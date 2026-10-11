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

// Extensionless on purpose: the web app bundles this package with webpack (transpilePackages), and
// webpack does not rewrite a "./protocol.js" specifier back to protocol.ts, which made /agents and
// /runner fail to compile. Bun/Node ESM consumers resolve the extensionless form just as well.
import {
  AGENT_ACTION_REFERENCE,
  renderStoreContext,
  type AgentStoreSnapshot,
} from "./protocol";

/** The AI roles that exist in a production channel. `director` is the human and is never an agent. */
export type AgentKind = "manager" | "script" | "image" | "voice" | "overseer";

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
    kind: "manager",
    label: "Management Team",
    workerType: "manager",
    provider: "hosted",
    runtime: "hosted",
    model: "hosted-openai-compatible",
    capabilities: [
      "direction",
      "briefing",
      "prioritisation",
      "agent_instructions",
      "runtime_requests",
      "progress_reporting",
    ],
    specialty:
      "Talks to the director, issues instructions to every agent (including the Showrunner), and reports the real state.",
    promptRole:
      "You are the Management Team of Ostra Studio — a hosted planning agent. You talk to the human director and you give the production agents their instructions. You decide what gets produced next (episodes, scenes, art, audio), you brief Script AI, Image AI, Voice AI and the Showrunner, and you report back what really happened. You never claim work that is not visible in the channel or the store.",
    accent: "text-[#FFD166]",
  },
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

/**
 * Every agent kind that can appear in the UI/API: the management team, the three production agents
 * and the Showrunner. The management team is NOT in `AGENT_CHANNEL_ORDER` — it speaks first and is
 * never asked to produce an episode in the production round.
 */
export const AGENT_ALL_KINDS: readonly AgentKind[] = ["manager", "overseer", ...AGENT_CHANNEL_ORDER] as const;

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
  /** True for the management team, which directs instead of producing. */
  manager?: boolean;
}): string {
  const { agent, snapshot, messages, directorNote } = args;
  const profile = agentProfile(agent);
  const others = AGENT_ALL_KINDS.filter((k) => k !== agent).map(agentLabel);

  const rules = args.manager
    ? [
        "You are the Management Team: you direct, you do not write the episodes yourself.",
        "`reply` is your message to the human director: the plan, the priorities and the honest status. 2-8 sentences.",
        "Give instructions with `messages`, addressed by name: Script AI, Image AI, Voice AI, Showrunner. Use kind `instruction` when you are directing, `brief` when you hand over work, `request` when you need something back.",
        "Plan the work in `actions` — create the projects, episodes and scenes you decided on (create_project, create_episode, create_scene, create_character, update_episode …). Plan only what you actually intend to produce; never invent finished work.",
        "Put a worker type in `start` ONLY when that agent is currently offline and you need it running (e.g. \"start\":[\"script\"]). The server checks whether it may be started and reports the real result; a start you did not ask for never happens.",
        "Never report an agent's work as done unless it is visible in the channel or the store.",
      ]
    : args.overseer
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
    '{"reply": "<what you say to the director>", "messages": [{"to": "<agent>", "kind": "request|handoff|position|ack|instruction", "content": "<what they must know or do>"}], "actions": [ <zero or more action objects> ], "start": [ "<worker_type you need started>" ]}',
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

// ── Direct-chat selection helpers ────────────────────────────────────────────
// Selection uses the canonical shared kind id. The displayed answer source must come from the backend
// that actually answered (provider/model/worker), never from this roster's default labels. Some roles
// may answer from the same hosted model with different instructions — the UI must say so honestly.

/** The five canonical targets a human can open a direct conversation with, in selection order. */
export const DIRECT_CHAT_TARGETS = [
  {
    kind: "manager",
    label: "Management Team",
    subtitle: "Plan the work, brief the agents, and report what is blocking or needs your decision.",
  },
  {
    kind: "script",
    label: "Script AI",
    subtitle: "Story, episodes, scenes, dialogue and continuity.",
  },
  {
    kind: "image",
    label: "Image AI",
    subtitle: "Characters, scene composition and visual consistency.",
  },
  {
    kind: "voice",
    label: "Voice AI",
    subtitle: "Narration, pacing and dialogue timing.",
  },
  {
    kind: "overseer",
    label: "Showrunner",
    subtitle: "Oversight, conflict detection and status reporting.",
  },
] as const;

/**
 * One line naming the backend that ACTUALLY answered a turn. Built from the live backend record the
 * API returned for that turn — never from the roster's default model names.
 */
export function answerSourceLabel(backend: {
  kind: string;
  provider: string;
  model: string;
  workerType?: string | null;
}): string {
  if (backend.kind === "project_worker") {
    return backend.workerType && backend.workerType !== backend.provider
      ? `${backend.provider} · ${backend.workerType} worker`
      : `${backend.provider} · project worker`;
  }
  if (backend.kind === "hosted_nvidia") return `NVIDIA NIM · ${backend.model}`;
  if (backend.kind === "hosted_manager") return `${backend.provider} · management team`;
  if (backend.kind === "hosted_fallback") return `${backend.provider} · hosted fallback`;
  return `${backend.provider} · ${backend.model}`;
}

/**
 * Non-null when several roles share one hosted model and only their instructions differ. The UI shows
 * this instead of pretending the roles are separate models.
 */
export function sharedModelNote(backend: { kind: string; provider: string; model: string }): string | null {
  if (backend.kind === "hosted_nvidia" || backend.kind === "hosted_manager" || backend.kind === "hosted_fallback") {
    return "Shared hosted model, role-specific instructions.";
  }
  return null;
}

/**
 * The system prompt for a DIRECT conversation between the human director and one chosen agent. It is
 * the same role identity, envelope and action allow-list as the production channel, minus the channel
 * transcript (the per-target chat history travels as ordinary user/assistant messages instead).
 * The manager keeps its `messages` peer array so a handoff it makes in chat is a real, deliverable
 * message — not a promise in prose.
 */
export function buildDirectChatPrompt(args: {
  agent: AgentKind;
  snapshot: AgentStoreSnapshot | null;
  directorNote?: string | null;
}): string {
  const { agent, snapshot, directorNote } = args;
  const profile = agentProfile(agent);
  const others = AGENT_ALL_KINDS.filter((k) => k !== agent).map(agentLabel);

  const rules =
    agent === "manager"
      ? [
          "You are the Management Team: you direct the production agents, you do not write the episodes yourself.",
          "`reply` is your message to the human director: answer their question, state the plan, the priorities and the honest status. 2-8 sentences unless they asked for detail.",
          "When you need another agent to do something, put it in `messages`, addressed by name: Script AI, Image AI, Voice AI, Showrunner. Use kind `instruction` when directing, `brief` when handing over work, `request` when you need something back. The server DELIVERS that message to the agent and records its real answer — never claim an agent did work you have not seen come back.",
          "Plan store changes in `actions` (create_project, create_season, submit_season, create_episode, create_scene, create_character, update_episode …). Plan only what you actually intend to produce; never invent finished work.",
          "Put a worker type in `start` ONLY when that agent is currently offline and you need it running. The server checks whether it may be started and reports the real result.",
          "Ask the director for approval when a decision is genuinely theirs (a season package, a rejected outline, spending quota). Never approve on their behalf.",
        ]
      : agent === "overseer"
        ? [
            "You are the Showrunner: do NOT write story, art or audio yourself and do NOT request store changes unless a fix is genuinely missing.",
            "Answer the director's question from the store context. Report what is done, what is blocked and what is unowned.",
            "Use `messages` only to ask a specific agent to resolve a specific conflict. Use `reply` for the director's report.",
            "Never claim an agent finished work that is not visible in the store context. If you cannot tell, say so.",
          ]
        : [
            `You are the ${profile.label} of Ostra Studio, talking ONE-TO-ONE with the human director.`,
            "`reply` is your answer to the director. Be concrete and brief (2-6 sentences unless they asked for detail). Write in the director's language.",
            "Put EVERY store change in `actions`. Never claim in `reply` that something was saved unless the matching action is present.",
            "You may address another agent with `messages` when you genuinely need them — one entry per peer, addressed by name (they are: " + others.join(", ") + ").",
            "Never invent characters, episodes, scene facts or art that are not in the store context or in this conversation.",
            "You cannot delete anything and you must not promise that you did.",
          ];

  return [
    profile.promptRole,
    "",
    "You are in a PRIVATE conversation with the human director of Ostra Studio. The conversation history with you follows this prompt as ordinary messages.",
    "Answer with EXACTLY ONE JSON object and nothing else — no markdown fence, no commentary:",
    '{"reply": "<your answer to the director>", "messages": [{"to": "<agent>", "kind": "request|handoff|position|ack|instruction", "content": "<what they must know or do>"}], "actions": [ <zero or more action objects> ], "start": [ "<worker_type you need started>" ]}',
    "",
    "Rules:",
    ...rules.map((r) => `- ${r}`),
    "- You may reason as much as you need inside  thinking…<>. The reasoning is shown separately, so put the JSON object AFTER  thinking…<> and nothing after it.",
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
