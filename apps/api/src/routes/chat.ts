// apps/api/src/routes/chat.ts
// Agent Chat — the director talks to the Script AI in a room, and the AI can adjust the real store.
//
//   GET    /api/chat/rooms                → rooms (newest activity first)
//   POST   /api/chat/rooms                → create a room, optionally bound to a project
//   PATCH  /api/chat/rooms/:id            → rebind a room to another project / retitle it
//   GET    /api/chat/rooms/:id/messages   → transcript + the live backend situation
//   POST   /api/chat/rooms/:id/messages    → send one turn: model → store writes → assistant row
//   GET    /api/chat/store?projectId=      → the store as the agent sees it (projects + snapshot)
//
// Honesty rules:
//  - The user's message is persisted BEFORE the model is called, so a transcript never loses what
//    the human said even when the AI is unavailable.
//  - When no backend can answer, the response is 503 NO_AGENT_BACKEND with the real reason and NO
//    assistant row is written. When the call fails, it is 502 with the real transport/HTTP error.
//    There is no placeholder, no canned reply and no fabricated success.
//  - WHICH model answers is the operator's persisted routing decision (own / auto / nvidia, see
//    apps/api/src/lib/routing.ts). The hosted NVIDIA backup is rate-limited for the free tier and
//    answers 429 with a real Retry-After rather than silently burning the account.
//  - Store writes happen only through `applyStoreActions` and only for the actions the model
//    actually returned; the response carries the per-action result.

import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_ALL_KINDS,
  DIRECT_CHAT_TARGETS,
  agentLabel,
  agentProfile,
  buildAgentSystemPrompt,
  buildDirectChatPrompt,
  parseAgentResponse,
  renderChannelTranscript,
  type AgentKind,
} from "@ostra/shared";
import { requireSupabase } from "../lib/supabase.js";
import {
  callAgent,
  publicBackend,
  resolveAgentBackend,
  resolveChannelBackend,
  resolveManagerBackend,
  type AgentMessage,
} from "../lib/agentRuntime.js";
import { deliverPeerMessages, loadChannel, type HandoffResult } from "../lib/agentChannel.js";
import { applyStoreActions, readStoreSnapshot, type AppliedAction } from "../lib/storeActions.js";

/** Longest direct conversation the model is shown, per target (bounds the prompt, never the call). */
const DIRECT_HISTORY_LIMIT = 24;

const MAX_CONTENT_CHARS = 8000;
const HISTORY_LIMIT = 32;
const MESSAGES_PAGE_LIMIT = 200;

type RoomRow = { id: string; project_id: string | null; title: string; created_at: string; updated_at: string };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Coerce the `actions` JSONB column into a stable shape for the client. */
function normalizeActions(value: unknown): AppliedAction[] {
  return Array.isArray(value) ? (value as AppliedAction[]) : [];
}

// ── GET /api/chat/rooms ──────────────────────────────────────────────────────
export async function listRooms(_req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { data, error } = await supa
    .from("chat_rooms")
    .select("id, project_id, title, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rooms: (data ?? []) as RoomRow[], timestamp: new Date().toISOString() });
}

// ── POST /api/chat/rooms ─────────────────────────────────────────────────────
export async function createRoom(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { project_id?: string | null; title?: string } | null;
  const projectId = body?.project_id ?? null;
  if (projectId && !isUuid(projectId)) return res.status(400).json({ error: "project_id must be a project id" });
  if (projectId) {
    const { data: project } = await supa.from("projects").select("id").eq("id", projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: "project not found" });
  }
  const title = (body?.title ?? "").toString().trim().slice(0, 120) || "Agent room";
  const { data, error } = await supa
    .from("chat_rooms")
    .insert({ project_id: projectId, title })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ room: data });
}

// ── PATCH /api/chat/rooms/:id ────────────────────────────────────────────────
export async function patchRoom(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as { project_id?: string | null; title?: string } | null;
  const patch: Record<string, unknown> = {};
  if (body && "project_id" in body) {
    const projectId = body.project_id ?? null;
    if (projectId && !isUuid(projectId)) return res.status(400).json({ error: "project_id must be a project id" });
    if (projectId) {
      const { data: project } = await supa.from("projects").select("id").eq("id", projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: "project not found" });
    }
    patch["project_id"] = projectId;
  }
  if (typeof body?.title === "string" && body.title.trim()) patch["title"] = body.title.trim().slice(0, 120);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No updatable fields" });
  const { data, error } = await supa.from("chat_rooms").update(patch).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ room: data });
}

async function loadRoom(supa: SupabaseClient, id: string): Promise<RoomRow | null> {
  const { data } = await supa
    .from("chat_rooms")
    .select("id, project_id, title, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  return (data as RoomRow | null) ?? null;
}

// ── GET /api/chat/rooms/:id/messages ─────────────────────────────────────────
export async function listMessages(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const room = await loadRoom(supa, id);
  if (!room) return res.status(404).json({ error: "room not found" });

  const { data, error } = await supa
    .from("chat_messages")
    .select("*")
    .eq("room_id", id)
    .order("created_at", { ascending: false })
    .limit(MESSAGES_PAGE_LIMIT);
  if (error) return res.status(500).json({ error: error.message });

  const messages = (data ?? [])
    .slice()
    .reverse()
    .map((row) => ({ ...(row as Record<string, unknown>), actions: normalizeActions((row as { actions?: unknown }).actions) }));

  // Report the live backend every time the transcript is read, so the UI never has to guess.
  const { status } = await resolveAgentBackend(supa);
  res.json({ room, messages, agent: status, timestamp: new Date().toISOString() });
}

// ── POST /api/chat/rooms/:id/messages ────────────────────────────────────────
export async function postMessage(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as { content?: string; note?: string } | null;
  const content = (body?.content ?? "").toString().trim();
  if (!content) return res.status(400).json({ error: "content is required" });
  if (content.length > MAX_CONTENT_CHARS) {
    return res.status(400).json({ error: `content is too long (max ${MAX_CONTENT_CHARS} characters)` });
  }

  const room = await loadRoom(supa, id);
  if (!room) return res.status(404).json({ error: "room not found" });

  // 1) Persist what the director said, before anything can fail.
  const userInsert = await supa
    .from("chat_messages")
    .insert({ room_id: id, role: "user", content, actions: [] })
    .select()
    .single();
  if (userInsert.error) return res.status(400).json({ error: userInsert.error.message });
  const userMessage = userInsert.data;
  await supa.from("chat_rooms").update({ updated_at: new Date().toISOString() }).eq("id", id);

  // 2) Build the real context: the store right now + the recent transcript.
  const snapshot = await readStoreSnapshot(supa, room.project_id);
  const { data: historyRows } = await supa
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("room_id", id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const history = (historyRows ?? []).slice().reverse() as Array<{ role: string; content: string }>;
  const messages: AgentMessage[] = [
    { role: "system", content: buildAgentSystemPrompt(snapshot, body?.note ?? null) },
    ...history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  // 3) Resolve the real backend; refuse loudly when there is none.
  const { backend, status } = await resolveAgentBackend(supa);
  if (!backend) {
    return res.status(503).json({
      error: "NO_AGENT_BACKEND",
      reason: status.detail,
      user_message: userMessage,
      agent: status,
    });
  }

  const call = await callAgent(backend, messages);
  if (!call.ok) {
    if (call.code === "RATE_LIMITED") {
      const retryAfterSec = call.retryAfterSec ?? 60;
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        error: "RATE_LIMITED",
        reason: `The Script AI (${backend.provider} · ${backend.model}) ${call.error}`,
        retry_after_sec: retryAfterSec,
        user_message: userMessage,
        backend: publicBackend(backend),
        agent: status,
      });
    }
    return res.status(502).json({
      error: call.code,
      reason: `The Script AI (${backend.provider} · ${backend.model}${backend.endpointHost ? ` · ${backend.endpointHost}` : ""}) ${call.error}`,
      user_message: userMessage,
      backend: publicBackend(backend),
      agent: status,
    });
  }

  // 4) Interpret the answer, apply the requested store changes, then record the turn.
  //    The model's thinking (inline ` thinking…</think>` on the project worker, or a separate
  //    `reasoning_content` field on other servers) is split off here and stored on its own column,
  //    so the director can read the reasoning and the answer as two distinct things.
  const reply = parseAgentResponse(call.content, call.reasoning);
  const store = await applyStoreActions(supa, reply.actions, room.project_id);
  const backendInfo = { ...publicBackend(backend), latencyMs: call.latencyMs, parse: reply.parse };

  const assistantInsert = await supa
    .from("chat_messages")
    .insert({
      room_id: id,
      role: "assistant",
      content: reply.reply || (reply.reasoning ? "(no final answer — the model's thinking is attached)" : "(the model returned no text)"),
      // NULL, not "", when there was no reasoning: the UI keys off presence, not emptiness.
      reasoning: reply.reasoning || null,
      actions: store.applied,
      backend: backendInfo,
    })
    .select()
    .single();
  if (assistantInsert.error) return res.status(500).json({ error: assistantInsert.error.message });

  await supa.from("chat_rooms").update({ updated_at: new Date().toISOString() }).eq("id", id);

  res.json({
    user_message: userMessage,
    message: { ...assistantInsert.data, actions: normalizeActions(assistantInsert.data.actions) },
    applied: store.applied,
    store: { changed: store.changed, failed: store.failed },
    backend: publicBackend(backend),
    agent: status,
    rejected: reply.rejected,
  });
}

/** Resolve one canonical target to its REAL live backend + status — the single source of truth for
 * "who would answer this target right now", shared by the selector, the send route and the
 * per-target transcript so they can never disagree. */
async function resolveTarget(supa: SupabaseClient, target: AgentKind) {
  return target === "manager"
    ? resolveManagerBackend()
    : await resolveChannelBackend(supa, target);
}

// ── GET /api/chat/rooms/:id/targets ──────────────────────────────────────────
// The five canonical targets with their REAL live availability/provider/model. Availability is the
// same resolution the send path uses — never a hard-coded "online".
export async function listTargets(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const room = await loadRoom(supa, id);
  if (!room) return res.status(404).json({ error: "room not found" });

  const targets = await Promise.all(
    DIRECT_CHAT_TARGETS.map(async (t) => {
      const kind = t.kind as AgentKind;
      const profile = agentProfile(kind);
      const { backend, status } = await resolveTarget(supa, kind);
      return {
        kind: t.kind,
        label: profile.label,
        subtitle: t.subtitle,
        accent: profile.accent,
        capabilities: profile.capabilities,
        specialty: profile.specialty,
        available: status.available,
        provider: status.provider,
        model: status.model,
        endpointHost: status.endpointHost,
        detail: status.detail,
        candidates: status.candidates,
        backend: backend ? publicBackend(backend) : null,
      };
    })
  );
  res.json({ room, targets, timestamp: new Date().toISOString() });
}

/** A client-supplied id that makes a retried/double-tapped send return the FIRST turn instead of
 * running the model twice. Random UUIDs only — never used as a lookup key for anything else. */
function isClientId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ── POST /api/chat/rooms/:id/message ─────────────────────────────────────────
// One conversational turn with ONE chosen canonical agent. `target` is required (body or query) and
// must be a canonical kind; the request can never name a provider, endpoint or model.
export async function sendToAgent(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as { content?: string; note?: string; target?: string; client_msg_id?: string } | null;
  const rawTarget = (body?.target ?? (req.query.target as string | undefined) ?? "").toString();
  const target = AGENT_ALL_KINDS.includes(rawTarget as AgentKind) ? (rawTarget as AgentKind) : null;
  if (!target) return res.status(400).json({ error: `target must be one of: ${AGENT_ALL_KINDS.join(", ")}` });

  const room = await loadRoom(supa, id);
  if (!room) return res.status(404).json({ error: "room not found" });

  const content = (body?.content ?? "").toString().trim();
  if (!content) return res.status(400).json({ error: "content is required" });
  if (content.length > MAX_CONTENT_CHARS) {
    return res.status(400).json({ error: `content is too long (max ${MAX_CONTENT_CHARS} characters)` });
  }

  // Idempotency: a double tap / network retry with the same client id must not run the model twice.
  const clientId = isClientId(body?.client_msg_id) ? body.client_msg_id : null;
  if (clientId) {
    const { data: prior } = await supa
      .from("chat_messages")
      .select("*")
      .eq("room_id", id)
      .eq("client_msg_id", clientId)
      .order("created_at", { ascending: false })
      .limit(2);
    const priorRows = (prior ?? []) as Array<Record<string, unknown> & { id: string; role: string }>;
    const priorUser = priorRows.find((r) => r.role === "user");
    const priorAssistant = priorRows.find((r) => r.role === "assistant");
    if (priorUser && priorAssistant) {
      return res.json({
        deduplicated: true,
        user_message: priorUser,
        message: { ...priorAssistant, actions: normalizeActions(priorAssistant.actions) },
        applied: normalizeActions(priorAssistant.actions),
        store: { changed: 0, failed: 0 },
        target,
      });
    }
  }

  // 1) Persist the user message BEFORE calling the model — it survives any later failure.
  const userInsert = await supa
    .from("chat_messages")
    .insert({ room_id: id, role: "user", content, actions: [], target_kind: target, client_msg_id: clientId })
    .select()
    .single();
  if (userInsert.error) return res.status(400).json({ error: userInsert.error.message });
  const userMessage = userInsert.data;
  await supa.from("chat_rooms").update({ updated_at: new Date().toISOString() }).eq("id", id);

  // 2) Resolve the REAL backend for this target. No backend → honest 503, no assistant row.
  const { backend, status } = await resolveTarget(supa, target);
  if (!backend) {
    return res.status(503).json({
      error: "NO_AGENT_BACKEND",
      reason: `${agentLabel(target)} cannot answer right now — ${status.detail}`,
      user_message: userMessage,
      target,
      agent: status,
    });
  }

  // 3) Context: the store snapshot + THIS target's conversation history (per target_kind, so
  //    switching agents never leaks one agent's transcript into another's).
  const snapshot = await readStoreSnapshot(supa, room.project_id);
  const { data: historyRows } = await supa
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("room_id", id)
    .eq("target_kind", target)
    .order("created_at", { ascending: false })
    .limit(DIRECT_HISTORY_LIMIT);
  const history = (historyRows ?? []).slice().reverse() as Array<{ role: string; content: string }>;

  const messages: AgentMessage[] = [
    { role: "system", content: buildDirectChatPrompt({ agent: target, snapshot, directorNote: body?.note ?? null }) },
    ...history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  const call = await callAgent(backend, messages);
  if (!call.ok) {
    // The failure is recorded ON the user's message so the transcript shows what really happened.
    await supa.from("chat_messages").update({ error: { code: call.code, reason: call.error } }).eq("id", userMessage.id);
    if (call.code === "RATE_LIMITED") {
      const retryAfterSec = call.retryAfterSec ?? 60;
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        error: "RATE_LIMITED",
        reason: `${agentLabel(target)} (${backend.provider} · ${backend.model}) ${call.error}`,
        retry_after_sec: retryAfterSec,
        user_message: userMessage,
        target,
        backend: publicBackend(backend),
        agent: status,
      });
    }
    return res.status(502).json({
      error: call.code,
      reason: `${agentLabel(target)} (${backend.provider} · ${backend.model}${backend.endpointHost ? ` · ${backend.endpointHost}` : ""}) ${call.error}`,
      user_message: userMessage,
      target,
      backend: publicBackend(backend),
      agent: status,
    });
  }

  // 4) Interpret the answer, apply its store writes, persist the REAL reply and its metadata.
  const reply = parseAgentResponse(call.content, call.reasoning);
  const store = await applyStoreActions(supa, reply.actions, room.project_id, `agent:${target}`);
  const backendInfo = { ...publicBackend(backend), latencyMs: call.latencyMs, parse: reply.parse, target_kind: target };

  const assistantInsert = await supa
    .from("chat_messages")
    .insert({
      room_id: id,
      role: "assistant",
      content: reply.reply || (reply.reasoning ? "(no final answer — the model's thinking is attached)" : "(the model returned no text)"),
      reasoning: reply.reasoning || null,
      actions: store.applied,
      backend: backendInfo,
      target_kind: target,
      client_msg_id: clientId,
    })
    .select()
    .single();
  if (assistantInsert.error) return res.status(500).json({ error: assistantInsert.error.message });

  await supa.from("chat_rooms").update({ updated_at: new Date().toISOString() }).eq("id", id);

  // 5) Peer-directed messages are DELIVERED, not just claimed: each one is persisted in the agent
  //    channel and the receiving agent is actually invoked with it (when it is genuinely online).
  //    This is how a manager handoff becomes real work instead of a promise in prose.
  const handoffs: HandoffResult[] = reply.messages.length
    ? await deliverPeerMessages(supa, {
        roomId: id,
        projectId: room.project_id,
        from: target,
        messages: reply.messages,
        backendInfo,
      })
    : [];

  res.json({
    user_message: userMessage,
    message: { ...assistantInsert.data, actions: normalizeActions(assistantInsert.data.actions) },
    applied: store.applied,
    store: { changed: store.changed, failed: store.failed },
    backend: publicBackend(backend),
    target,
    agent: status,
    rejected: reply.rejected,
    handoffs,
  });
}

// ── GET /api/chat/rooms/:id/conversation/:kind ────────────────────────────────────
// ONE target's transcript only. History is stored per `target_kind`, so switching agents in the UI
// never shows one agent's messages under another's name.
export async function listConversation(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id, kind } = req.params as { id: string; kind: string };
  const target = kind && AGENT_ALL_KINDS.includes(kind as AgentKind) ? (kind as AgentKind) : null;
  if (!target) return res.status(400).json({ error: `kind must be one of: ${AGENT_ALL_KINDS.join(", ")}` });

  const room = await loadRoom(supa, id);
  if (!room) return res.status(404).json({ error: "room not found" });

  const { data, error } = await supa
    .from("chat_messages")
    .select("*")
    .eq("room_id", id)
    .eq("target_kind", target)
    .order("created_at", { ascending: false })
    .limit(MESSAGES_PAGE_LIMIT);
  if (error) return res.status(500).json({ error: error.message });

  const messages = (data ?? [])
    .slice()
    .reverse()
    .map((row) => ({ ...(row as Record<string, unknown>), actions: normalizeActions((row as { actions?: unknown }).actions) }));

  const { backend, status } = await resolveTarget(supa, target);

  // The real inter-agent channel for this room, so the UI can show delivered handoffs and their
  // real outcomes next to the conversation.
  const channel = await loadChannel(supa, id);

  res.json({
    room,
    messages,
    target,
    agent: status,
    backend: backend ? publicBackend(backend) : null,
    channel: channel.map((m) => ({
      id: m.id,
      from_agent: m.from_agent,
      to_agent: m.to_agent,
      kind: m.kind,
      content: m.content,
      status: m.status,
      backend: m.backend,
      error: m.error,
      created_at: m.created_at,
    })),
    channel_transcript: renderChannelTranscript(channel),
    timestamp: new Date().toISOString(),
  });
}

// ── GET /api/chat/store?projectId= ───────────────────────────────────────────
export async function getStore(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const projectId = (req.query.projectId as string | undefined) ?? null;
  if (projectId && !isUuid(projectId)) return res.status(400).json({ error: "projectId must be a project id" });
  const { data: projects, error } = await supa
    .from("projects")
    .select("id, slug, title")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  const snapshot = await readStoreSnapshot(supa, projectId);
  res.json({ projects: projects ?? [], snapshot });
}
