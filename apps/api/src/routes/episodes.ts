import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

export async function listEpisodes(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const projectId = (req.query.projectId as string) ?? null;
  let q = supa.from("episodes").select("*").order("number", { ascending: true });
  if (projectId) q = q.eq("project_id", projectId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ episodes: data ?? [] });
}

export async function createEpisode(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { project_id?: string; title?: string; concept?: string; number?: number } | null;
  if (!body?.project_id || !body?.title) return res.status(400).json({ error: "project_id and title are required" });
  let number = body.number;
  if (!number) {
    const { data } = await supa.from("episodes").select("number").eq("project_id", body.project_id).order("number", { ascending: false }).limit(1).maybeSingle();
    number = (data?.number ?? 0) + 1;
  }
  const { data, error } = await supa
    .from("episodes")
    .insert({ project_id: body.project_id, title: body.title, concept: body.concept ?? null, number, status: "idea" })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await supa.from("events").insert({ type: "episode.created", project_id: body.project_id, episode_id: data.id, actor: "api", payload: { title: body.title } });
  res.status(201).json({ episode: data });
}

export async function getEpisode(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data, error } = await supa.from("episodes").select("*").eq("id", id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json({ episode: data });
}

export async function patchEpisode(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  for (const k of ["title", "concept", "outline", "script", "narration", "status", "auto_publish", "youtube_video_id", "youtube_url"]) {
    if (k in body) allowed[k] = body[k];
  }
  if (Object.keys(allowed).length === 0) return res.status(400).json({ error: "No updatable fields" });
  // Validate status if present
  if ("status" in allowed) {
    const valid = ["idea","writing","scenes","imaging","voicing","rendering","qc","ready_for_review","approved","uploading","published","archived"];
    if (typeof allowed.status !== "string" || !valid.includes(allowed.status)) return res.status(400).json({ error: "Invalid status" });
  }
  const { data, error } = await supa.from("episodes").update(allowed).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  if ("status" in allowed) {
    await supa.from("events").insert({ type: "episode.updated", episode_id: id, project_id: data.project_id, actor: "api", payload: { status: allowed.status } });
  }
  res.json({ episode: data });
}
