// packages/shared/src/agent/protocol.ts
// The contract between the Ostra backend and whatever LLM answers in the Agent Chat room.
//
// Truth rules this file exists to protect (see CONSTRAINTS.md):
//  - The model may only ASK for store changes from a fixed, additive allow-list. There is no
//    delete op: chat can never destroy an artifact or a row.
//  - `parseAgentResponse` is pure. If the model answers with prose instead of the JSON envelope we
//    keep that prose as the reply and report `parse: "text_fallback"` — we never invent a reply and
//    never invent actions.
//  - Anything the model asks for that is not in the allow-list is reported in `rejected`, so a
//    dropped request is visible instead of silently ignored.
//  - `reasoning` is whatever the model actually thought — Qwen3 emits ` thinking…</think>` inline in
//    `content`, other servers return `reasoning_content`. It is split off from `reply` and never
//    invented: when the model did not think, `reasoning` is empty and the UI shows no thinking block.

/** Store operations the agent may request. Additive only — deliberately no delete ops. */
export const AGENT_ACTION_OPS = [
  "create_project",
  "update_project",
  "create_character",
  "update_character",
  "create_location",
  "update_location",
  "create_episode",
  "update_episode",
  "create_scene",
  "update_scene",
] as const;

export type AgentActionOp = (typeof AGENT_ACTION_OPS)[number];

const OP_SET = new Set<string>(AGENT_ACTION_OPS);
export function isAgentActionOp(value: unknown): value is AgentActionOp {
  return typeof value === "string" && OP_SET.has(value);
}

/** One requested store change. `project` is a slug or title; omitted ⇒ the room's project. */
export type AgentAction = {
  op: AgentActionOp;
  project?: string;
  data: Record<string, string | number | boolean | null>;
};

export type AgentParse = "json" | "text_fallback";

// ── Agent-to-agent messages ──────────────────────────────────────────────────
// In a multi-agent production channel one agent needs to address another ("Script AI asks Image AI
// to change Kai's scar"). That is a SEPARATE channel from `reply`: `reply` is shown to the human
// director, while `messages` is delivered to named peers. Both travel inside the same JSON envelope,
// and a message is only ever recorded when the model actually emitted it — never inferred.

export const AGENT_MESSAGE_KINDS = [
  "brief",
  "position",
  "request",
  "handoff",
  "report",
  "ack",
  "instruction",
] as const;
export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

const MESSAGE_KIND_SET = new Set<string>(AGENT_MESSAGE_KINDS);
export function isAgentMessageKind(value: unknown): value is AgentMessageKind {
  return typeof value === "string" && MESSAGE_KIND_SET.has(value);
}

/** Everyone who can appear in a channel: the four AI roles, the management team and the human director. */
export const AGENT_PARTICIPANTS = [
  "director",
  "manager",
  "script",
  "image",
  "voice",
  "overseer",
] as const;
export type AgentParticipant = (typeof AGENT_PARTICIPANTS)[number];

export function isAgentParticipant(value: unknown): value is AgentParticipant {
  return typeof value === "string" && (AGENT_PARTICIPANTS as readonly string[]).includes(value);
}

/**
 * Resolve who a model addressed, accepting the agent's ID *or* the label the prompt actually uses
 * ("Script AI", "Management Team", "Showrunner"). Without this an instruction addressed the way the
 * prompt tells the model to address it is silently DROPPED — the model did the right thing and the
 * backend threw it away.
 */
const PARTICIPANT_ALIASES: Readonly<Record<string, AgentParticipant>> = {
  director: "director",
  human: "director",
  manager: "manager",
  management: "manager",
  "management team": "manager",
  management_team: "manager",
  script: "script",
  "script ai": "script",
  script_ai: "script",
  writer: "script",
  image: "image",
  "image ai": "image",
  image_ai: "image",
  art: "image",
  voice: "voice",
  "voice ai": "voice",
  voice_ai: "voice",
  audio: "voice",
  overseer: "overseer",
  showrunner: "overseer",
  "show runner": "overseer",
};

export function resolveParticipant(value: unknown): AgentParticipant | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  if (isAgentParticipant(key)) return key;
  return PARTICIPANT_ALIASES[key] ?? null;
}

/** One message an agent addressed at a named peer. */
export type AgentOutboundMessage = {
  to: AgentParticipant;
  kind: AgentMessageKind;
  content: string;
};

/** Longest single peer message we keep (a small model can ramble; this caps display, never the call). */
export const AGENT_MESSAGE_MAX_CHARS = 4000;

/** The interpreted answer of one agent call. `reply` is always what the human is shown. */
export type AgentReply = {
  reply: string;
  actions: AgentAction[];
  parse: AgentParse;
  /** Raw op names the model asked for that are not allowed (delete_*, anything unknown). */
  rejected: string[];
  /**
   * The model's own thinking for this turn, when the backend produced it. Empty string when the
   * model answered without thinking — the UI then renders nothing rather than an empty box.
   */
  reasoning: string;
  /** Messages this agent explicitly addressed at its peers. Empty when it addressed none. */
  messages: AgentOutboundMessage[];
  /**
   * Worker types this agent asked to be STARTED (e.g. `["script"]`). Collected from the model, never
   * acted upon here: the server checks the autonomy gate and the real autostart path for every target
   * before anything runs, and reports what actually happened.
   */
  starts: string[];
};

/** Longest start target list accepted from a model (bounds the directive parser). */
export const AGENT_MAX_STARTS = 8;

const STARTABLE_PARTICIPANTS = new Set<string>(["script", "image", "voice", "overseer", "manager"]);

function normalizeStarts(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? [raw] : typeof raw === "string" ? [raw] : [];
  const out: string[] = [];
  for (const item of list) {
    const value = typeof item === "string" ? item : isPlainObject(item) ? (item.target ?? item.worker_type ?? item.agent) : null;
    if (typeof value !== "string") continue;
    const target = value.trim().toLowerCase();
    if (!STARTABLE_PARTICIPANTS.has(target) || out.includes(target)) continue;
    out.push(target);
    if (out.length >= AGENT_MAX_STARTS) break;
  }
  return out;
}

/** Longest reply we accept from a model before truncating it for display (defensive, not a spec). */
export const AGENT_REPLY_MAX_CHARS = 8000;

/** Longest reasoning trace we keep (a small model can loop; this caps display only, never the call). */
export const AGENT_REASONING_MAX_CHARS = 20000;

/** A model answer split into its thinking and its actual answer. */
export type ReasoningSplit = { reasoning: string; answer: string };

/**
 * Thinking tags seen in the wild: Qwen3 emits ` thinking…</think>` inline in `content`; some servers
 * use `<thinking>`/`<reasoning>`. Matched case-insensitively.
 */
const THINK_TAGS = "(?:think|thinking|reasoning)";

function trimBlock(value: string): string {
  return value.replace(/^\s+|\s+$/g, "");
}

/**
 * Split a raw model answer into thinking vs answer. Pure, never throws.
 *
 *  - ` thinking… response<answer>` → reasoning is the inside, answer is what follows.
 *  - A stray `</think>` with no opener (a server that stripped the opening tag) → still split.
 *  - An unterminated ` thinking…` means the model ran out of room mid-thought: the thought is kept
 *    and the answer is empty, so the UI can report "no answer" honestly instead of presenting half
 *    a thought as if it were the reply.
 *  - No tags at all → reasoning is empty and the whole text is the answer.
 */
export function splitReasoning(raw: string | null | undefined): ReasoningSplit {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return { reasoning: "", answer: "" };

  const open = new RegExp(`<${THINK_TAGS}>`, "i").exec(text);
  const close = new RegExp(`</${THINK_TAGS}>`, "i").exec(text);

  if (close) {
    const openBefore = open && open.index < close.index ? open : null;
    const reasoning = openBefore
      ? text.slice(openBefore.index + openBefore[0].length, close.index)
      : text.slice(0, close.index);
    const lead = openBefore ? trimBlock(text.slice(0, openBefore.index)) : "";
    const tail = text.slice(close.index + close[0].length).replace(/^\s+/, "");
    return {
      reasoning: trimBlock(reasoning).slice(0, AGENT_REASONING_MAX_CHARS),
      answer: [lead, tail].filter(Boolean).join("\n"),
    };
  }

  if (open) {
    return {
      reasoning: trimBlock(text.slice(open.index + open[0].length)).slice(0, AGENT_REASONING_MAX_CHARS),
      answer: "",
    };
  }

  return { reasoning: "", answer: text };
}

/**
 * Combine inline thinking with a separate reasoning channel (e.g. an OpenAI-compatible
 * `choices[0].message.reasoning_content`). The explicit channel wins when both are present.
 */
export function combineReasoning(inline: string, explicit?: string | null): string {
  const fromField = typeof explicit === "string" ? explicit.trim() : "";
  const chosen = fromField || inline.trim();
  return chosen.slice(0, AGENT_REASONING_MAX_CHARS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only primitive, JSON-safe values so a nested/garbage `data` field can never reach Postgres. */
function primitiveData(raw: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Normalize one candidate object into an AgentAction, or return the rejected op name.
 * Small models flatten their arguments, so `data` is accepted and the remaining top-level keys are
 * folded into it; `op`/`action`/`operation` and `data`/`arguments`/`args` are all accepted.
 */
function normalizeAction(raw: unknown): { action: AgentAction } | { rejected: string } {
  if (!isPlainObject(raw)) return { rejected: "(malformed action)" };
  const opRaw = raw.op ?? raw.action ?? raw.operation ?? raw.tool;
  if (typeof opRaw !== "string") return { rejected: "(action without an op)" };
  const op = opRaw.trim().toLowerCase();
  if (!isAgentActionOp(op)) return { rejected: op };

  const dataRaw = raw.data ?? raw.arguments ?? raw.args ?? raw.params;
  const data = primitiveData(dataRaw);
  // Fold flattened arguments (e.g. {"op":"create_character","name":"Kai"}) into data.
  for (const [k, v] of Object.entries(raw)) {
    if (["op", "action", "operation", "tool", "data", "arguments", "args", "params"].includes(k)) continue;
    if (k === "project") continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") data[k] = v;
  }

  const projectRaw = raw.project ?? raw.project_slug ?? raw.project_title;
  const action: AgentAction = { op, data };
  if (typeof projectRaw === "string" && projectRaw.trim()) action.project = projectRaw.trim();
  return { action };
}

/**
 * Normalize the model's `messages` array. A recipient that is not a known participant, or a message
 * with no text, is DROPPED rather than reported — an unaddressed message has nowhere to go, and the
 * reply itself still carries anything the model meant for the director. An unknown recipient is
 * surfaced via `rejected`-style dropping only for debugging through the returned list; here we keep
 * it simple and only return deliverable messages.
 */
function normalizeOutboundMessages(raw: unknown): AgentOutboundMessage[] {
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? [raw] : [];
  const out: AgentOutboundMessage[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const toRaw = item.to ?? item.target ?? item.recipient ?? item.agent;
    const to = resolveParticipant(toRaw);
    if (!to) continue;
    const contentRaw = item.content ?? item.message ?? item.text ?? item.body;
    const content = typeof contentRaw === "string" ? contentRaw.trim() : "";
    if (!content) continue;
    const kindRaw = item.kind ?? item.type;
    const kind = isAgentMessageKind(typeof kindRaw === "string" ? kindRaw.trim().toLowerCase() : "") ? (kindRaw as AgentMessageKind) : "request";
    out.push({ to, kind, content: content.slice(0, AGENT_MESSAGE_MAX_CHARS) });
  }
  return out;
}

function normalizeActions(raw: unknown): { actions: AgentAction[]; rejected: string[] } {
  const actions: AgentAction[] = [];
  const rejected: string[] = [];
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? [raw] : [];
  for (const item of list) {
    const res = normalizeAction(item);
    if ("action" in res) actions.push(res.action);
    else rejected.push(res.rejected);
  }
  return { actions, rejected };
}

/** Candidate JSON payloads inside a model answer, most-likely first. */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  if (trimmed) out.push(trimmed);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]?.trim()) out.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) out.push(text.slice(first, last + 1));
  return out;
}

/**
 * Interpret one raw model answer. Never throws.
 * Thinking is split off FIRST: the strict `{"reply": ..., "actions": [...]}` envelope is looked for
 * only in the answer, so reasoning that happens to contain braces can never be mistaken for the
 * envelope. Falls back to treating the answer as prose (`parse: "text_fallback"`) rather than
 * fabricating a reply or dropping the text.
 * `explicitReasoning` is the backend's separate reasoning channel, when it returned one.
 */
export function parseAgentResponse(raw: string | null | undefined, explicitReasoning?: string | null): AgentReply {
  const split = splitReasoning(raw);
  const reasoning = combineReasoning(split.reasoning, explicitReasoning);
  const text = split.answer;
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const replyRaw = parsed.reply ?? parsed.message ?? parsed.response ?? parsed.text;
    const { actions, rejected } = normalizeActions(parsed.actions ?? parsed.action ?? []);
    const messages = normalizeOutboundMessages(parsed.messages ?? parsed.message_to ?? parsed.outbox ?? []);
    const starts = normalizeStarts(parsed.start ?? parsed.starts ?? parsed.start_workers ?? []);
    const reply = typeof replyRaw === "string" ? replyRaw.trim() : "";
    // A valid envelope needs a reply, some actions, or at least one peer message. An envelope with
    // only peer messages is real (the agent addressed a peer and said nothing to the director), and
    // unrelated JSON with none of those is skipped so it can still fall back to prose.
    if (!reply && actions.length === 0 && rejected.length === 0 && messages.length === 0 && starts.length === 0) continue;
    // A server forced into JSON mode can only express its thinking INSIDE the envelope, so accept a
    // `reasoning` / `reasoning_content` / `thinking` key on it as well as a separate channel.
    const envelopeReasoning = [parsed.reasoning, parsed.reasoning_content, parsed.thinking].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    return {
      reply: reply.slice(0, AGENT_REPLY_MAX_CHARS),
      actions,
      parse: "json",
      rejected,
      reasoning: combineReasoning(reasoning, envelopeReasoning),
      messages,
      starts,
    };
  }
  return {
    reply: text.trim().slice(0, AGENT_REPLY_MAX_CHARS),
    actions: [],
    parse: "text_fallback",
    rejected: [],
    reasoning,
    messages: [],
    starts: [],
  };
}

// ── Store context handed to the model ────────────────────────────────────────
// The agent can only reason about what it is shown, so the snapshot below IS the agent's view of
// the store. It is read from Supabase immediately before each call — never a cached guess.

export type AgentStoreSnapshot = {
  project: {
    id: string;
    slug: string;
    title: string;
    logline: string | null;
    story_bible: Record<string, unknown>;
  } | null;
  characters: Array<{ name: string; role: string | null; description: string | null }>;
  locations: Array<{ name: string; description: string | null }>;
  episodes: Array<{ number: number; title: string; status: string; concept: string | null }>;
  scenes: Array<{ episode_number: number; index: number; title: string | null }>;
  taken_at: string;
};

export const AGENT_STORY_BIBLE_MAX_CHARS = 1200;

function clip(value: string | null | undefined, max: number): string {
  const s = (value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Render the snapshot as the compact, secret-free block embedded in the system prompt. */
export function renderStoreContext(snapshot: AgentStoreSnapshot | null): string {
  if (!snapshot) return "STORE CONTEXT: unavailable (the store could not be read).";
  const lines: string[] = [];
  const p = snapshot.project;
  if (p) {
    lines.push(`PROJECT: ${p.title} (slug: ${p.slug})`);
    if (p.logline) lines.push(`LOGLINE: ${clip(p.logline, 400)}`);
    const bible = JSON.stringify(p.story_bible ?? {});
    if (bible && bible !== "{}") lines.push(`STORY BIBLE: ${clip(bible, AGENT_STORY_BIBLE_MAX_CHARS)}`);
  } else {
    lines.push("PROJECT: none yet in this room (no project selected).");
  }
  lines.push(
    snapshot.characters.length
      ? `CHARACTERS: ${snapshot.characters.map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}${c.description ? ` — ${clip(c.description, 120)}` : ""}`).join(" | ")}`
      : "CHARACTERS: none"
  );
  lines.push(
    snapshot.locations.length
      ? `LOCATIONS: ${snapshot.locations.map((l) => `${l.name}${l.description ? ` — ${clip(l.description, 120)}` : ""}`).join(" | ")}`
      : "LOCATIONS: none"
  );
  lines.push(
    snapshot.episodes.length
      ? `EPISODES: ${snapshot.episodes.map((e) => `EP ${e.number} "${e.title}" [${e.status}]${e.concept ? ` — ${clip(e.concept, 120)}` : ""}`).join(" | ")}`
      : "EPISODES: none"
  );
  lines.push(
    snapshot.scenes.length
      ? `SCENES: ${snapshot.scenes.map((s) => `EP ${s.episode_number} #${s.index}${s.title ? ` "${clip(s.title, 60)}"` : ""}`).join(" | ")}`
      : "SCENES: none"
  );
  return `STORE CONTEXT (read at ${snapshot.taken_at}, this is the current truth):\n${lines.join("\n")}`;
}

/** The exact action vocabulary shown to the model. Kept next to the parser so they cannot drift. */
export const AGENT_ACTION_REFERENCE = `ACTIONS (all optional, additive only — deleting is impossible):
{"op":"create_project","data":{"title":"...","logline":"...","slug":"optional-slug"}}
{"op":"update_project","data":{"title":"...","logline":"...","story_bible":{"premise":"..."}}}
{"op":"create_character","data":{"name":"...","role":"...","description":"...","visual_ref":"..."}}
{"op":"update_character","data":{"name":"<existing name>","role":"...","description":"...","visual_ref":"..."}}
{"op":"create_location","data":{"name":"...","description":"...","visual_ref":"..."}}
{"op":"update_location","data":{"name":"<existing name>","description":"...","visual_ref":"..."}}
{"op":"create_episode","data":{"title":"...","concept":"...","number":3}}
{"op":"update_episode","data":{"number":<existing episode number>,"title":"...","concept":"...","outline":"...","script":"...","narration":"...","status":"idea|writing|scenes|imaging|voicing|rendering|qc|ready_for_review|approved|uploading|published|archived"}}
{"op":"create_scene","data":{"episode_number":<existing episode number>,"title":"...","script_excerpt":"...","image_spec":"...","narration_segment":"...","duration_sec":6}}
{"op":"update_scene","data":{"episode_number":<existing>,"index":<existing scene index>,"title":"...","script_excerpt":"...","image_spec":"...","narration_segment":"...","duration_sec":6}}`;

/** System prompt for the room. `directorNote` carries optional per-room instructions. */
export function buildAgentSystemPrompt(snapshot: AgentStoreSnapshot | null, directorNote?: string | null): string {
  return [
    "You are the Script AI of Ostra Studio, the production agent for an original manhwa YouTube channel.",
    "You talk directly with the human director. You can also adjust the studio store: projects, characters, locations, episodes and scenes.",
    "",
    "Answer with EXACTLY ONE JSON object and nothing else — no markdown fence, no commentary:",
    '{"reply": "<what you say to the director>", "actions": [ <zero or more action objects> ]}',
    "",
    "Rules:",
    "- `reply` is shown to the director. Be concrete, warm and brief (2-6 sentences). Write in the director's language.",
    "- Put EVERY store change in `actions`. Never claim in `reply` that something was saved unless the matching action is present.",
    "- Only use the operations listed below. Never send ids. Refer to things exactly as they appear in the store context: project slug, character name, location name, episode number, scene index.",
    "- If the director is just talking, asking a question or thinking out loud, return \"actions\": [].",
    "- Never invent characters, episodes or story facts that are not in the store context or in this conversation.",
    "- You may reason as much as you need inside  thinking…</think>. The director sees that reasoning as its own block, so put the JSON object AFTER </think> and nothing after it.",
    "- You cannot delete anything and you must not promise that you did.",
    "",
    AGENT_ACTION_REFERENCE,
    "",
    directorNote ? `DIRECTOR NOTE FOR THIS ROOM: ${directorNote}` : "",
    "",
    renderStoreContext(snapshot),
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}
