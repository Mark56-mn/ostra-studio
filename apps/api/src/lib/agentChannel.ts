// apps/api/src/lib/agentChannel.ts
// Runs one "production round" of the AI Studio channel: Script AI → Image AI → Voice AI, then the
// Showrunner. Each agent is called with the REAL channel so far and the REAL store, and everything it
// emits is persisted as it happened.
//
// Truth rules (see CONSTRAINTS.md):
//  - Only agents that are genuinely ONLINE (fresh heartbeat + registered endpoint) are called. An
//    offline agent is skipped and its inbox stays `sent` — never marked delivered to a model that
//    was never asked.
//  - A message row is written ONLY for text the model actually produced (its `reply` or one of its
//    explicit peer `messages`). Nothing is inferred, reordered or backfilled.
//  - Store writes go through `applyStoreActions` — the same additive allow-list as the Agent Chat
//    room. There is no delete path.
//  - A failed call marks the inbound messages `failed` with the real reason and records the failure;
//    it does not fabricate a reply.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_CHANNEL_ORDER,
  agentLabel,
  buildAgentChannelPrompt,
  parseAgentResponse,
  type AgentKind,
  type AgentStoreSnapshot,
} from "@ostra/shared";
import { callAgent, publicBackend, resolveChannelBackend, type AgentMessage } from "./agentRuntime.js";
import { applyManagerStarts, type ManagerStartOutcome } from "./managerAutonomy.js";
import { applyStoreActions, readStoreSnapshot, type AppliedAction } from "./storeActions.js";

/** How many channel rows we keep in context and return. */
const CHANNEL_PAGE_LIMIT = 200;

export type ChannelRow = {
  id: string;
  room_id: string;
  project_id: string | null;
  from_agent: string;
  to_agent: string;
  kind: string;
  content: string;
  payload: Record<string, unknown> | null;
  status: string;
  backend: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  created_at: string;
};

export type AgentTurnResult = {
  agent: AgentKind;
  ok: boolean;
  backend: ReturnType<typeof publicBackend> | null;
  latencyMs: number | null;
  /** The exact text addressed to the director, or null when the agent produced none. */
  reply: string | null;
  /** How many peer messages this agent addressed. */
  outgoing: number;
  applied: AppliedAction[];
  rejected: string[];
  error: string | null;
  /** Worker types the model asked to start. Only the management team may return these. */
  startsRequested?: string[];
  /** What the supervisor actually did (or refused to do) about those starts. */
  starts?: ManagerStartOutcome[];
};

export async function loadChannel(supa: SupabaseClient, roomId: string): Promise<ChannelRow[]> {
  const { data } = await supa
    .from("agent_messages")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: true })
    .limit(CHANNEL_PAGE_LIMIT);
  return (data ?? []) as ChannelRow[];
}

/** Persist one real message. Returns the inserted row, or null when the insert failed. */
export async function insertChannelMessage(
  supa: SupabaseClient,
  row: {
    room_id: string;
    project_id: string | null;
    from_agent: string;
    to_agent: string;
    kind: string;
    content: string;
    payload?: Record<string, unknown>;
    status?: string;
    backend?: Record<string, unknown> | null;
    error?: Record<string, unknown> | null;
  }
): Promise<ChannelRow | null> {
  const { data } = await supa
    .from("agent_messages")
    .insert({
      room_id: row.room_id,
      project_id: row.project_id,
      from_agent: row.from_agent,
      to_agent: row.to_agent,
      kind: row.kind,
      content: row.content,
      payload: row.payload ?? {},
      status: row.status ?? "sent",
      backend: row.backend ?? null,
      error: row.error ?? null,
    })
    .select()
    .single();
  return (data as ChannelRow | null) ?? null;
}

/** Mark every not-yet-delivered message addressed to `agent` with the outcome of its real call. */
async function settleInbox(
  supa: SupabaseClient,
  roomId: string,
  agent: AgentKind,
  outcome: "delivered" | "failed",
  error?: Record<string, unknown>
): Promise<void> {
  const patch: Record<string, unknown> = { status: outcome };
  if (error) patch["error"] = error;
  try {
    await supa
      .from("agent_messages")
      .update(patch)
      .eq("room_id", roomId)
      .eq("to_agent", agent)
      .eq("status", "sent")
      .neq("from_agent", agent);
  } catch {
    /* settling the inbox is bookkeeping; the agent's own rows are the record that matters */
  }
}

/**
 * Run exactly one agent's turn. Reads the store fresh (so later agents see earlier agents' writes),
 * calls the resolved backend, persists what it emitted and applies its store actions.
 */
export async function runAgentTurn(
  supa: SupabaseClient,
  args: {
    roomId: string;
    projectId: string | null;
    agent: AgentKind;
    overseer?: boolean;
    directorNote?: string | null;
  }
): Promise<AgentTurnResult> {
  const { roomId, projectId, agent } = args;
  const overseer = args.overseer === true;
  const label = agentLabel(agent);

  const { backend, status } = await resolveChannelBackend(supa, agent);
  if (!backend) {
    return {
      agent,
      ok: false,
      backend: null,
      latencyMs: null,
      reply: null,
      outgoing: 0,
      applied: [],
      rejected: [],
      error: status.detail,
      ...(agent === "manager" ? { startsRequested: [], starts: [] } : {}),
    };
  }

  const snapshot: AgentStoreSnapshot = await readStoreSnapshot(supa, projectId);
  const channel = await loadChannel(supa, roomId);
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: buildAgentChannelPrompt({
        agent,
        snapshot,
        messages: channel,
        directorNote: args.directorNote ?? null,
        overseer,
        manager: agent === "manager",
      }),
    },
    {
      role: "user",
      content: overseer
        ? "It is your turn to report. Read the channel and the store and answer with the JSON envelope."
        : agent === "manager"
          ? "It is the Management Team's turn. Direct the production agents and answer with the JSON envelope."
          : `It is ${label}'s turn. Answer with the JSON envelope.`,
    },
  ];

  const call = await callAgent(backend, messages);
  if (!call.ok) {
    await settleInbox(supa, roomId, agent, "failed", { code: call.code, reason: call.error });
    return {
      agent,
      ok: false,
      backend: publicBackend(backend),
      latencyMs: call.latencyMs,
      reply: null,
      outgoing: 0,
      applied: [],
      rejected: [],
      error: `${call.code}: ${call.error}`,
      ...(agent === "manager" ? { startsRequested: [], starts: [] } : {}),
    };
  }

  const reply = parseAgentResponse(call.content, call.reasoning);
  // Only the management team may ask for a runtime to start, and even then every target is re-checked
  // against the autonomy gate and the real autostart path before anything runs.
  const starts = agent === "manager" ? await applyManagerStarts(supa, reply.starts) : null;
  const store = await applyStoreActions(supa, reply.actions, projectId, `agent:${agent}`);
  const backendInfo = { ...publicBackend(backend), latencyMs: call.latencyMs, parse: reply.parse };
  const payload: Record<string, unknown> = {};
  if (reply.reasoning) payload["reasoning"] = reply.reasoning;

  // 1) What the agent says to the DIRECTOR (always visible in the channel).
  const directorText = reply.reply || (reply.reasoning ? "(no final answer — the model's thinking is attached)" : "");
  if (directorText) {
    await insertChannelMessage(supa, {
      room_id: roomId,
      project_id: projectId,
      from_agent: agent,
      to_agent: "director",
      kind: overseer ? "report" : "position",
      content: directorText,
      payload,
      status: "reported",
      backend: backendInfo,
    });
  }

  // 2) What the agent says to its PEERS — one real row per addressed message.
  let outgoing = 0;
  for (const m of reply.messages) {
    if (m.to === "director") continue; // already covered by `reply`; a duplicate would be noise
    const row = await insertChannelMessage(supa, {
      room_id: roomId,
      project_id: projectId,
      from_agent: agent,
      to_agent: m.to,
      kind: m.kind,
      content: m.content,
      payload,
      status: "sent",
      backend: backendInfo,
    });
    if (row) outgoing += 1;
  }

  await settleInbox(supa, roomId, agent, "delivered");

  return {
    agent,
    ok: true,
    backend: publicBackend(backend),
    latencyMs: call.latencyMs,
    reply: directorText || null,
    outgoing,
    applied: store.applied,
    rejected: reply.rejected,
    error: null,
    ...(starts ? { startsRequested: reply.starts, starts } : {}),
  };
}

/**
 * One full round: the Management Team first (so its instructions are in the inbox of every agent the
 * round calls next), then each production agent in order, then the Showrunner. Bounded — every agent
 * is called at most once, so a chatty model cannot spin the round forever.
 */
export async function runProductionRound(
  supa: SupabaseClient,
  args: {
    roomId: string;
    projectId: string | null;
    directorNote?: string | null;
    overseer?: boolean;
    /** Set false to skip the management team's turn (it is skipped when it is not configured). */
    manager?: boolean;
  }
): Promise<{ turns: AgentTurnResult[]; changed: number; failedWrites: number }> {
  const turns: AgentTurnResult[] = [];

  if (args.manager !== false) {
    // An unconfigured management team must not add a noise row to the round: it is skipped here and
    // reported by the roster / manager route instead.
    const { backend } = await resolveChannelBackend(supa, "manager");
    if (backend) turns.push(await runAgentTurn(supa, { ...args, agent: "manager" }));
  }

  for (const agent of AGENT_CHANNEL_ORDER) {
    turns.push(await runAgentTurn(supa, { ...args, agent, overseer: false }));
  }
  if (args.overseer !== false) {
    turns.push(await runAgentTurn(supa, { ...args, agent: "overseer", overseer: true }));
  }
  const applied = turns.flatMap((t) => t.applied);
  const changed = applied.filter((a) => a.ok).length;
  return { turns, changed, failedWrites: applied.length - changed };
}
