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
//  - Store writes happen only through `applyStoreActions` and only for the actions the model
//    actually returned; the response carries the per-action result.

import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAgentSystemPrompt, parseAgentResponse } from "@ostra/shared";
import { requireSupabase } from "../lib/supabase.js";
import { callAgent, publicBackend, resolveAgentBackend, type AgentMessage } from "../lib/agentRuntime.js";
import { applyStoreActions, readStoreSnapshot, type AppliedAction } from "../lib/storeActions.js";

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
    return res.status(502).json({
      error: call.code,
      reason: `The Script AI (${backend.provider} · ${backend.model}${backend.endpointHost ? ` · ${backend.endpointHost}` : ""}) ${call.error}`,
      user_message: userMessage,
      backend: publicBackend(backend),
      agent: status,
    });
  }

  // 4) Interpret the answer, apply the requested store changes, then record the turn.
  const reply = parseAgentResponse(call.content);
  const store = await applyStoreActions(supa, reply.actions, room.project_id);
  const backendInfo = { ...publicBackend(backend), latencyMs: call.latencyMs, parse: reply.parse };

  const assistantInsert = await supa
    .from("chat_messages")
    .insert({
      room_id: id,
      role: "assistant",
      content: reply.reply || "(the model returned no text)",
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
