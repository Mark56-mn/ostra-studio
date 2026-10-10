// apps/api/src/routes/seasons.ts
// SEASON-FIRST APPROVAL (spec §5) — the Manager AI submits ONE complete season package per cycle and
// the human decides on THAT package. Production is gated on the result (see tasks.ts).
//
//   GET    /api/seasons?projectId=     → seasons for a project (newest first) + the production gate
//   POST   /api/seasons                → create a draft package (validated; a broken package is refused)
//   GET    /api/seasons/:id            → one season, with the gate and the notification that is due
//   PATCH  /api/seasons/:id            → edit a season that is not approved
//   POST   /api/seasons/:id/submit     → send it for review (never approves anything)
//   POST   /api/seasons/:id/decision   → { decision, note?, decided_by? } — the ONLY path to 'approved'
//   GET    /api/notifications          → the in-app inbox (unread first)
//   POST   /api/notifications/:id/read → mark one read
//
// Honesty rules (CONSTRAINTS.md):
//  - Nothing here can approve a season by accident: `applySeasonDecision` only accepts a human
//    decision on a `submitted` season, and every state change writes an `events` row.
//  - Submitting/deciding raises a real `notifications` row for the human (deduped by key), so the
//    dashboard's inbox is the database, not a client-side trick.

import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applySeasonDecision,
  canEditSeason,
  canSubmitSeason,
  productionGate,
  seasonNotification,
  validateSeasonPackage,
  type SeasonDecision,
  type SeasonEpisodeEntry,
  type SeasonStatus,
} from "@ostra/shared";
import { requireSupabase } from "../lib/supabase.js";

export type SeasonRow = {
  id: string;
  project_id: string;
  title: string;
  premise: string | null;
  episode_count: number;
  episodes: unknown;
  characters: unknown;
  world: unknown;
  arcs: unknown;
  ending: string | null;
  assumptions: unknown;
  production_estimate: unknown;
  status: SeasonStatus;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
};

const SEASON_COLUMNS =
  "id, project_id, title, premise, episode_count, episodes, characters, world, arcs, ending, assumptions, production_estimate, status, submitted_at, decided_at, decided_by, decision_note, created_at, updated_at";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Raise the real notification for a season event. Never throws — a failed inbox row is logged, not faked. */
async function notify(
  supa: SupabaseClient,
  event: "submitted" | "approved" | "changes_requested" | "rejected",
  season: { id: string; project_id: string; title: string },
  dedupeKey: string | null
) {
  const n = seasonNotification(event, season);
  if (!n) return;
  await supa
    .from("notifications")
    .insert({
      kind: n.kind,
      project_id: season.project_id,
      season_id: season.id,
      title: n.title,
      body: n.body,
      severity: n.severity,
      requires_action: n.requiresAction,
      dedupe_key: dedupeKey,
    })
    .then(
      () => undefined,
      (e) => console.error("[seasons] notification insert failed", e?.message ?? e)
    );
}

async function audit(supa: SupabaseClient, type: string, season: SeasonRow, actor: string, payload: Record<string, unknown>) {
  await supa
    .from("events")
    .insert({ type, project_id: season.project_id, actor, payload: { season_id: season.id, season_title: season.title, ...payload } })
    .then(
      () => undefined,
      (e) => console.error("[seasons] event insert failed", e?.message ?? e)
    );
}

// ── GET /api/seasons?projectId= ─────────────────────────────────────────────
export async function listSeasons(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const projectId = (req.query.projectId as string | undefined) ?? null;
  if (projectId && !isUuid(projectId)) return res.status(400).json({ error: "projectId must be a project id" });

  let q = supa.from("seasons").select(SEASON_COLUMNS).order("created_at", { ascending: false }).limit(100);
  if (projectId) q = q.eq("project_id", projectId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = (data ?? []) as SeasonRow[];
  // Group per project so each project's gate is computed from ITS seasons, never another project's.
  const byProject = new Map<string, SeasonRow[]>();
  for (const row of rows) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
  const gates = Object.fromEntries([...byProject].map(([pid, list]) => [pid, productionGate(list, pid)]));

  res.json({ seasons: rows, gates, timestamp: new Date().toISOString() });
}

// ── POST /api/seasons ───────────────────────────────────────────────────────
export async function createSeason(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { project_id?: string; package?: unknown; created_by?: string } | null;

  if (!isUuid(body?.project_id)) return res.status(400).json({ error: "project_id is required" });
  const { data: project } = await supa.from("projects").select("id, title").eq("id", body!.project_id).maybeSingle();
  if (!project) return res.status(404).json({ error: "project not found" });

  const validated = validateSeasonPackage(body?.package);
  if (!validated.ok) return res.status(400).json({ error: "SEASON_PACKAGE_INVALID", details: validated.errors });

  const p = validated.package;
  const { data, error } = await supa
    .from("seasons")
    .insert({
      project_id: body!.project_id,
      title: p.title,
      premise: p.premise,
      episode_count: p.episodeCount,
      episodes: p.episodes,
      characters: p.characters,
      world: p.world,
      arcs: p.arcs,
      ending: p.ending,
      assumptions: p.assumptions,
      production_estimate: p.productionEstimate,
      status: "draft",
    })
    .select(SEASON_COLUMNS)
    .single();
  if (error) return res.status(400).json({ error: error.message });

  const row = data as SeasonRow;
  await audit(supa, "season.created", row, body?.created_by ?? "human", { episodes: p.episodes.length });
  res.status(201).json({ season: row, gate: productionGate([row], row.project_id) });
}

// ── GET /api/seasons/:id ────────────────────────────────────────────────────
export async function getSeason(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data, error } = await supa.from("seasons").select(SEASON_COLUMNS).eq("id", id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  const row = data as SeasonRow | null;
  if (!row) return res.status(404).json({ error: "season not found" });

  const { data: siblings } = await supa
    .from("seasons")
    .select(SEASON_COLUMNS)
    .eq("project_id", row.project_id)
    .order("created_at", { ascending: false });
  res.json({ season: row, gate: productionGate((siblings ?? []) as SeasonRow[], row.project_id) });
}

// ── PATCH /api/seasons/:id ──────────────────────────────────────────────────
export async function patchSeason(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data: existing } = await supa.from("seasons").select(SEASON_COLUMNS).eq("id", id).maybeSingle();
  const row = existing as SeasonRow | null;
  if (!row) return res.status(404).json({ error: "season not found" });

  const editable = canEditSeason(row);
  if (!editable.ok) return res.status(409).json({ error: "SEASON_LOCKED", reason: editable.reason });

  const body = req.body as { package?: unknown } | null;
  const validated = validateSeasonPackage(body?.package);
  if (!validated.ok) return res.status(400).json({ error: "SEASON_PACKAGE_INVALID", details: validated.errors });
  const p = validated.package;

  const { data, error } = await supa
    .from("seasons")
    .update({
      title: p.title,
      premise: p.premise,
      episode_count: p.episodeCount,
      episodes: p.episodes,
      characters: p.characters,
      world: p.world,
      arcs: p.arcs,
      ending: p.ending,
      assumptions: p.assumptions,
      production_estimate: p.productionEstimate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(SEASON_COLUMNS)
    .single();
  if (error) return res.status(400).json({ error: error.message });
  const updated = data as SeasonRow;
  await audit(supa, "season.updated", updated, "human", { episodes: p.episodes.length });
  res.json({ season: updated, gate: productionGate([updated], updated.project_id) });
}

// ── POST /api/seasons/:id/submit ────────────────────────────────────────────
export async function submitSeason(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data: existing } = await supa.from("seasons").select(SEASON_COLUMNS).eq("id", id).maybeSingle();
  const row = existing as SeasonRow | null;
  if (!row) return res.status(404).json({ error: "season not found" });

  const submitable = canSubmitSeason({ status: row.status, episodes: arr(row.episodes) as SeasonEpisodeEntry[] });
  if (!submitable.ok) return res.status(409).json({ error: "SEASON_NOT_SUBMITTABLE", reason: submitable.reason });

  const { data, error } = await supa
    .from("seasons")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(SEASON_COLUMNS)
    .single();
  if (error) return res.status(400).json({ error: error.message });

  const submitted = data as SeasonRow;
  await audit(supa, "season.submitted", submitted, "manager", { episodes: arr(submitted.episodes).length });
  await notify(supa, "submitted", submitted, `season_submitted:${submitted.id}:${submitted.submitted_at ?? ""}`);
  res.json({ season: submitted, gate: productionGate([submitted], submitted.project_id) });
}

// ── POST /api/seasons/:id/decision ──────────────────────────────────────────
export async function decideSeason(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as { decision?: string; note?: string; decided_by?: string } | null;

  const decision = body?.decision as SeasonDecision | undefined;
  if (!decision || !["approved", "changes_requested", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "decision must be approved | changes_requested | rejected" });
  }

  const { data: existing } = await supa.from("seasons").select(SEASON_COLUMNS).eq("id", id).maybeSingle();
  const row = existing as SeasonRow | null;
  if (!row) return res.status(404).json({ error: "season not found" });

  const applied = applySeasonDecision(row, decision);
  if (!applied.ok) return res.status(409).json({ error: "SEASON_NOT_DECIDABLE", reason: applied.reason });

  const actor = (typeof body?.decided_by === "string" && body.decided_by.trim()) || "human";
  const { data, error } = await supa
    .from("seasons")
    .update({
      status: applied.status,
      decided_at: new Date().toISOString(),
      decided_by: actor,
      decision_note: typeof body?.note === "string" ? body.note.slice(0, 2000) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(SEASON_COLUMNS)
    .single();
  if (error) return res.status(400).json({ error: error.message });

  const decided = data as SeasonRow;
  await audit(supa, `season.${decision}`, decided, actor, { note: decided.decision_note });
  await notify(supa, decision, decided, `season_decided:${decided.id}:${decided.decided_at ?? ""}`);

  const { data: siblings } = await supa
    .from("seasons")
    .select(SEASON_COLUMNS)
    .eq("project_id", decided.project_id)
    .order("created_at", { ascending: false });
  res.json({ season: decided, gate: productionGate((siblings ?? []) as SeasonRow[], decided.project_id) });
}

// ── GET /api/notifications ──────────────────────────────────────────────────
export async function listNotifications(_req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { data, error } = await supa
    .from("notifications")
    .select("id, kind, project_id, season_id, title, body, severity, requires_action, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  const rows = (data ?? []) as Array<{ read_at: string | null } & Record<string, unknown>>;
  res.json({
    notifications: rows,
    unread: rows.filter((n) => !n.read_at).length,
    timestamp: new Date().toISOString(),
  });
}

// ── POST /api/notifications/:id/read ────────────────────────────────────────
export async function markNotificationRead(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data, error } = await supa
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null)
    .select("id")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "notification not found or already read" });
  res.json({ ok: true, id });
}
