import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

export async function listArtifacts(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const episodeId = (req.query.episodeId as string) ?? null;
  const taskId = (req.query.taskId as string) ?? null;
  let q = supa.from("artifacts").select("*").order("created_at", { ascending: false }).limit(100);
  if (episodeId) q = q.eq("episode_id", episodeId);
  if (taskId) q = q.eq("task_id", taskId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ artifacts: data ?? [] });
}

export async function createArtifact(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const b = req.body as { project_id?: string; episode_id?: string; scene_id?: string; task_id?: string; kind?: string; storage_path?: string; inline_text?: string; metadata?: Record<string, unknown> } | null;
  if (!b?.kind) return res.status(400).json({ error: "kind is required" });
  if (!b.storage_path && !b.inline_text) return res.status(400).json({ error: "storage_path or inline_text is required (binaries go to Storage, not rows)" });
  // Compute next version for same episode+kind (or scene+kind) — never overwrite
  let q = supa.from("artifacts").select("version").order("version", { ascending: false }).limit(1);
  if (b.episode_id) q = q.eq("episode_id", b.episode_id);
  if (b.scene_id) q = q.eq("scene_id", b.scene_id);
  q = q.eq("kind", b.kind);
  const { data: prev } = await q.maybeSingle();
  const version = (prev?.version ?? 0) + 1;

  const { data, error } = await supa.from("artifacts").insert({
    project_id: b.project_id ?? null, episode_id: b.episode_id ?? null, scene_id: b.scene_id ?? null, task_id: b.task_id ?? null,
    kind: b.kind, version, storage_path: b.storage_path ?? null, inline_text: b.inline_text ?? null, metadata: b.metadata ?? null,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await supa.from("events").insert({ type: version > 1 ? "artifact.versioned" : "artifact.created", project_id: b.project_id ?? null, episode_id: b.episode_id ?? null, task_id: b.task_id ?? null, actor: "orchestrator", payload: { kind: b.kind, version, artifactId: data.id } });
  res.status(201).json({ artifact: data });
}
