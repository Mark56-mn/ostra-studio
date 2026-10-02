// packages/shared/src/agent/agents.ts
// The multi-agent roster for the Ostra production channel, plus the prompt that lets each agent speak
// BOTH to the human director (its `reply`) and to its peer agents (its `messages`).
//
// Truth rules this file protects (see CONSTRAINTS.md):
//  - The roster is metadata, never status. Whether an agent is ONLINE comes from the real worker
//    registry (heartbeat freshness) — this file never claims an agent is running.
//  - Each agent's prompt carries the SAME action allow-list as the single-agent room, so no role can
//    widen what may be written to the store. Additive only; there is still no delete op anywhere.
//  - The channel transcript is rendered from the real `agent_messages` rows. An agent only sees what
//    actually happened; nothing is summarised, reordered or invented.
//  - The overseer reads the real channel and the real store. Its report is `parse: "json"` only when
//    the model returned the envelope, exactly like every other agent — a prose report is still shown.

import {
  AGENT_ACTION_REFERENCE,
  renderStoreContext,
  type AgentStoreSnapshot,
} from "./protocol.js";

/** The four AI roles that exist in a production channel. `director` is the human and is never an agent. */
export type AgentKind = "script" | "image" | "voice" | "overseer";

/** One role's static identity. Status is NEVER stored here — it comes from the live worker registry. */
export type AgentProfile = {
  kind: AgentKind;
  /** Human label shown on a message ("Script AI"). */
  label: string;
  /** The `workers.type` this role registers as. */
  workerType: string;
  /** Worker provider/runtime hint used when a Kaggle notebook registers. */
  provider: string;
  runtime: string;
  /** Default model; the live worker row can override it. */
  model: string;
  /** Capabilities advertised by the role's notebook. */
  capabilities: string[];
  /** One-line specialty for the roster UI. */
  specialty: string;
  /** What the agent tells itself it is, used verbatim at the top of its prompt. */
  promptRole: string;
  /** Tailwind text colour token for the role's accent in the UI. */
  accent: string;
};

export const AGENT_ROSTER: readonly AgentProfile[] = [
  {
    kind: "script",
    label: "Script AI",
    workerType: "script",
    provider: "kaggle",
    runtime: "kaggle",
    model: "Qwen/Qwen3-4B",
    capabilities: [
      "story_development",
      "script_writing",
      "scene_planning",
      "dialogue",
      "narration_text",
      "image_prompts",
      "story_continuity",
    ],
    specialty: "Story, scripts, scene breakdowns, narration and the image brief.",
    promptRole:
      "You are the Script AI of Ostra Studio. You own the story: premise, characters, episode arcs, scene breakdowns and narration. You are the first voice in the channel and the one who briefs the other agents on what the picture and the sound must do.",
    accent: "text-[#FF8A93]",
  },
  {
    kind: "image",
    label: "Image AI",
    workerType: "image",
    provider: "kaggle",
    runtime: "kaggle",
    model: "Qwen/Qwen3-4B",
    capabilities: [
      "character_design",
      "visual_consistency",
      "scene_composition",
      "image_prompting",
      "style_bible",
    ],
    specialty: "Character look and face, visual consistency, scene composition and image prompts.",
    promptRole:
      "You are the Image AI of Ostra Studio. You own how everything LOOKS: character faces, hair, wardrobe, scars and signature props, plus the visual continuity of each scene. When a script change affects how a character looks, say so and say exactly what must be redrawn.",
    accent: "text-[#7CC6FF]",
  },
  {
    kind: "voice",
    label: "Voice AI",
    workerType: "voice",
    provider: "kaggle",
    runtime: "kaggle",
    model: "Qwen/Qwen3-4B",
    capabilities: [
      "narration_direction",
      "pacing",
      "dialogue_timing",
      "audio_mix",
      "scene_alignment",
    ],
    specialty: "Narration, pacing, dialogue timing and matching audio to each scene.",
    promptRole:
      "You are the Voice AI of Ostra Studio. You own how everything SOUNDS and how it lands against the picture: narration pacing, dialogue delivery, where a beat needs silence, and whether each audio segment matches the scene it sits under. When the picture changes, say what the audio must change to match.",
    accent: "text-[#3DE0B3]",
  },
  {
    kind: "overseer",
    label: "Showrunner",
    workerType: "overseer",
    provider: "kaggle",
    runtime: "kaggle",
    model: "Qwen/Qwen3-4B",
    capabilities: ["oversight", "conflict_detection", "status_reporting", "handoff_summary"],
    specialty: "Oversees the channel, resolves conflicts and reports the real status to the director.",
    promptRole:
      "You are the Showrunner of Ostra Studio. You do not write the show — you keep the other agents honest. You read the whole channel and the real store, spot where two agents disagree or where work is blocked, and report the TRUE status to the director. You never invent progress that did not happen.",
    accent: "text-[#C4A8FF]",
  },
] as const;

/** The people/agents a message can be addressed to, in channel order. */
export const AGENT_CHANNEL_ORDER: readonly AgentKind[] = ["script", "image", "voice"] as const;

export function agentProfile(kind: AgentKind): AgentProfile {
  const found = AGENT_ROSTER.find((a) => a.kind === kind);
  // The roster is total over AgentKind; this can only trip if the type and the array drift apart.
  if (!found) throw new Error(`unknown agent kind: ${kind}`);
  return found;
}

export function agentLabel(kind: string): string {
  if (kind === "director") return "Director";
  return AGENT_ROSTER.find((a) => a.kind === kind)?.label ?? kind;
}

/** One line of the real channel, exactly as it is stored. */
export type ChannelMessage = {
  id?: string;
  from_agent: string;
  to_agent: string;
  kind: string;
  content: string;
  created_at?: string;
};

/** How many characters of a single channel line are shown to the model (keeps the prompt bounded). */
export const CHANNEL_LINE_MAX_CHARS = 900;
/** How many recent channel lines are shown to the model. */
export const CHANNEL_WINDOW = 40;

function clipLine(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > CHANNEL_LINE_MAX_CHARS ? `${s.slice(0, CHANNEL_LINE_MAX_CHARS)}…` : s;
}

/**
 * Render the tail of the real channel as the block embedded in an agent's prompt. Newest last, so a
 * model reads the conversation the way a person would. Always labelled as the current truth.
 */
export function renderChannelTranscript(messages: ChannelMessage[]): string {
  const tail = messages.slice(-CHANNEL_WINDOW);
  if (tail.length === 0) return "CHANNEL: (empty — nothing has been said yet)";
  const lines = tail.map((m) => `[${agentLabel(m.from_agent)} → ${agentLabel(m.to_agent)}] (${m.kind}) ${clipLine(m.content)}`);
  return `CHANNEL SO FAR (oldest first, exactly what was sent):\n${lines.join("\n")}`;
}

/** Messages addressed to this agent (directly or to `all`) that it did not send itself. */
export function inboxFor(kind: AgentKind, messages: ChannelMessage[]): ChannelMessage[] {
  return messages.filter((m) => (m.to_agent === kind || m.to_agent === "all") && m.from_agent !== kind);
}

function renderInbox(kind: AgentKind, messages: ChannelMessage[]): string {
  const mine = inboxFor(kind, messages);
  if (mine.length === 0) return `YOUR INBOX: (nothing addressed to you — act on the channel and the store)`;
  return `YOUR INBOX (addressed to ${agentProfile(kind).label}):\n${mine
    .map((m) => `- from ${agentLabel(m.from_agent)} (${m.kind}): ${clipLine(m.content)}`)
    .join("\n")}`;
}

/**
 * The prompt for one agent speaking in the production channel. It teaches the envelope, the peer
 * `messages` array, and reuses the SAME action reference and store context as the single-agent room.
 */
export function buildAgentChannelPrompt(args: {
  agent: AgentKind;
  snapshot: AgentStoreSnapshot | null;
  messages: ChannelMessage[];
  directorNote?: string | null;
  /** True for the overseer, which reports instead of producing. */
  overseer?: boolean;
}): string {
  const { agent, snapshot, messages, directorNote } = args;
  const profile = agentProfile(agent);
  const others = AGENT_CHANNEL_ORDER.filter((k) => k !== agent && k !== "overseer").map(agentLabel);

  const rules = args.overseer
    ? [
        "You are the Showrunner: do NOT write story, art or audio yourself and do NOT request store changes unless a fix is genuinely missing.",
        "Read the channel and the store. Report what each agent actually did, where they disagree, and what is blocked or unowned.",
        "Use `messages` only to ask a specific agent to resolve a specific conflict. Use `reply` for the director's report.",
        "Never claim an agent finished work that is not visible in the channel. If you cannot tell, say so.",
      ]
    : [
        "`reply` is shown to the human director. Be concrete and brief (2-6 sentences). Write in the director's language.",
        "Use `messages` for EVERYTHING you need another agent to do — one entry per peer. Only address someone when you actually need them to act or to know something.",
        `Your peers are ${others.join(", ")} and the director. Address them by those names.`,
        "Put EVERY store change in `actions`. Never claim in `reply` or in a message that something was saved unless the matching action is present.",
        "Never invent characters, episodes, scene facts or art that are not in the store context or in this channel.",
        "You cannot delete anything and you must not promise that you did.",
      ];

  return [
    profile.promptRole,
    "",
    "You are one agent in a shared Ostra Studio production channel. The director and the other agents all read it.",
    "Answer with EXACTLY ONE JSON object and nothing else — no markdown fence, no commentary:",
    '{"reply": "<what you say to the director>", "messages": [{"to": "<agent>", "kind": "request|handoff|position|ack", "content": "<what they must know or do>"}], "actions": [ <zero or more action objects> ]}',
    "",
    "Rules:",
    ...rules.map((r) => `- ${r}`),
    "- You may reason as much as you need inside  thinking…</think>. The reasoning is shown separately, so put the JSON object AFTER </think> and nothing after it.",
    "",
    AGENT_ACTION_REFERENCE,
    "",
    directorNote ? `DIRECTOR NOTE FOR THIS CHANNEL: ${directorNote}` : "",
    "",
    renderInbox(agent, messages),
    "",
    renderChannelTranscript(messages),
    "",
    renderStoreContext(snapshot),
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}
