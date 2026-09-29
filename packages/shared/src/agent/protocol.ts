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

/** The interpreted answer of one agent call. `reply` is always what the human is shown. */
export type AgentReply = {
  reply: string;
  actions: AgentAction[];
  parse: AgentParse;
  /** Raw op names the model asked for that are not allowed (delete_*, anything unknown). */
  rejected: string[];
};

/** Longest reply we accept from a model before truncating it for display (defensive, not a spec). */
export const AGENT_REPLY_MAX_CHARS = 8000;

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
 * Prefers the strict `{"reply": ..., "actions": [...]}` envelope; falls back to treating the whole
 * answer as prose (`parse: "text_fallback"`) rather than fabricating a reply or dropping the text.
 */
export function parseAgentResponse(raw: string | null | undefined): AgentReply {
  const text = typeof raw === "string" ? raw : "";
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const replyRaw = parsed.reply ?? parsed.message ?? parsed.response ?? parsed.text;
    const hasActions = "actions" in parsed || "action" in parsed;
    if (typeof replyRaw !== "string" && !hasActions) continue;
    const { actions, rejected } = normalizeActions(parsed.actions ?? parsed.action ?? []);
    const reply = typeof replyRaw === "string" ? replyRaw.trim() : "";
    if (!reply && actions.length === 0 && rejected.length === 0) continue;
    return { reply: reply.slice(0, AGENT_REPLY_MAX_CHARS), actions, parse: "json", rejected };
  }
  return { reply: text.trim().slice(0, AGENT_REPLY_MAX_CHARS), actions: [], parse: "text_fallback", rejected: [] };
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
