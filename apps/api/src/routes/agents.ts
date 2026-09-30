// apps/api/src/routes/agents.ts
// AI Studio — the production channel where the agents talk to EACH OTHER and the Showrunner reports
// to the director.
//
//   GET    /api/agents/roster                  → the four roles + their REAL live status
//   GET    /api/agents/rooms                   → studio channels (kind='studio')
//   POST   /api/agents/rooms                   → create a studio channel, optionally bound to a project
//   PATCH  /api/agents/rooms/:id               → retitle / rebind a channel
//   GET    /api/agents/rooms/:id/messages      → the real channel transcript + live roster
//   POST   /api/agents/rooms/:id/dispatch      → run one production round (Script → Image → Voice → Showrunner)
//
// Honesty rules:
//  - A brief from the director is persisted BEFORE any model is called, so it is never lost.
//  - Each agent is only called when it is genuinely ONLINE; an offline agent is reported as skipped
//    with the real reason, and messages to it stay `sent` rather than being marked delivered.
//  - Nothing is written that a model did not actually produce. `turns` reports what each agent did,
//    including the ones that failed — there is no canned reply and no fabricated success.

import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENT_ROSTER, AGENT_CHANNEL_ORDER, type AgentKind } from "@ostra/shared";
import { requireSupabase } from "../lib/supabase.js";
import { resolveChannelBackend } from "../lib/agentRuntime.js";
import { insertChannelMessage, loadChannel, runProductionRound } from "../lib/agentChannel.js";

const MAX_BRIEF_CHARS = 8000;
const ROSTER_KINDS: AgentKind[] = [...AGENT_CHANNEL_ORDER, "overseer"];

type RoomRow = { id: string; project_id: string | null; title: string; kind: string; created_at: string; updated_at: string };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function loadStudioRoom(supa: SupabaseClient, id: string): Promise<RoomRow | null> {
  const { data } = await supa
    .from("chat_rooms")
    .select("id, project_id, title, kind, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  const room = (data as RoomRow | null) ?? null;
  return room && room.kind === "studio" ? room : null;
}

/** The roster with REAL status per role. Never a claim that an agent is running. */
async function rosterWithStatus(supa: SupabaseClient) {
  return Promise.all(
    ROSTER_KINDS.map(async (kind) => {
      const profile = AGENT_ROSTER.find((a) => a.kind === kind)!;
      const { status } = await resolveChannelBackend(supa, kind);
      return {
        kind,
        label: profile.label,
        workerType: profile.workerType,
        specialty: profile.specialty,
        accent: profile.accent,
        capabilities: profile.capabilities,
        available: status.available,
        provider: status.provider,
        model: status.model,
        endpointHost: status.endpointHost,
        detail: status.detail,
        candidates: status.candidates,
      };
    })
  );
}

// ── GET /api/agents/roster ───────────────────────────────────────────────────
export async function getRoster(_req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const roster = await rosterWithStatus(supa);
  res.json({ roster, timestamp: new Date().toISOString() });
}

// ── GET /api/agents/rooms ────────────────────────────────────────────────────
export async function listStudioRooms(_req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { data, error } = await supa
    .from("chat_rooms")
    .select("id, project_id, title, kind, created_at, updated_at")
    .eq("kind", "studio")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rooms: (data ?? []) as RoomRow[], timestamp: new Date().toISOString() });
}

// ── POST /api/agents/rooms ───────────────────────────────────────────────────
export async function createStudioRoom(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { project_id?: string | null; title?: string } | null;
  const projectId = body?.project_id ?? null;
  if (projectId && !isUuid(projectId)) return res.status(400).json({ error: "project_id must be a project id" });
  if (projectId) {
    const { data: project } = await supa.from("projects").select("id").eq("id", projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: "project not found" });
  }
  const title = (body?.title ?? "").toString().trim().slice(0, 120) || "Production channel";
  const { data, error } = await supa
    .from("chat_rooms")
    .insert({ project_id: projectId, title, kind: "studio" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ room: data });
}

// ── PATCH /api/agents/rooms/:id ──────────────────────────────────────────────
export async function patchStudioRoom(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const room = await loadStudioRoom(supa, id);
  if (!room) return res.status(404).json({ error: "studio room not found" });
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

// ── GET /api/agents/rooms/:id/messages ───────────────────────────────────────
export async function listChannelMessages(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const room = await loadStudioRoom(supa, id);
  if (!room) return res.status(404).json({ error: "studio room not found" });
  const [messages, roster] = await Promise.all([loadChannel(supa, id), rosterWithStatus(supa)]);
  res.json({ room, messages, roster, timestamp: new Date().toISOString() });
}

// ── POST /api/agents/rooms/:id/dispatch ──────────────────────────────────────
export async function dispatchRound(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const room = await loadStudioRoom(supa, id);
  if (!room) return res.status(404).json({ error: "studio room not found" });

  const body = req.body as { brief?: string; note?: string; overseer?: boolean } | null;
  const brief = (body?.brief ?? "").toString().trim();
  if (brief.length > MAX_BRIEF_CHARS) {
    return res.status(400).json({ error: `brief is too long (max ${MAX_BRIEF_CHARS} characters)` });
  }

  // 1) Persist the director's brief first — it must survive any model failure.
  if (brief) {
    const row = await insertChannelMessage(supa, {
      room_id: id,
      project_id: room.project_id,
      from_agent: "director",
      to_agent: "script",
      kind: "brief",
      content: brief,
      status: "sent",
    });
    if (!row) return res.status(500).json({ error: "the brief could not be saved" });
  }

  // 2) Run the round. Every turn reports what really happened, including failures.
  const result = await runProductionRound(supa, {
    roomId: id,
    projectId: room.project_id,
    directorNote: body?.note ?? null,
    overseer: body?.overseer !== false,
  });

  await supa.from("chat_rooms").update({ updated_at: new Date().toISOString() }).eq("id", id);

  const [messages, roster] = await Promise.all([loadChannel(supa, id), rosterWithStatus(supa)]);
  res.json({
    turns: result.turns,
    changed: result.changed,
    failedWrites: result.failedWrites,
    messages,
    roster,
  });
}
