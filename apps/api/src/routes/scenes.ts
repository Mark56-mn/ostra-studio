import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

export async function listScenes(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const episodeId = (req.query.episodeId as string) ?? null;
  if (!episodeId) return res.status(400).json({ error: "episodeId query required" });
  const { data, error } = await supa.from("scenes").select("*").eq("episode_id", episodeId).order("index", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ scenes: data ?? [] });
}

export async function createScene(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { episode_id?: string; index?: number; title?: string; script_excerpt?: string; image_spec?: string; narration_segment?: string; duration_sec?: number } | null;
  if (!body?.episode_id) return res.status(400).json({ error: "episode_id is required" });
  let idx = body.index;
  if (typeof idx !== "number") {
    const { data } = await supa.from("scenes").select("index").eq("episode_id", body.episode_id).order("index", { ascending: false }).limit(1).maybeSingle();
    idx = (data?.index ?? -1) + 1;
  }
  const { data, error } = await supa
    .from("scenes")
    .insert({
      episode_id: body.episode_id, index: idx, title: body.title ?? null,
      script_excerpt: body.script_excerpt ?? null, image_spec: body.image_spec ?? null,
      narration_segment: body.narration_segment ?? null, duration_sec: body.duration_sec ?? null,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ scene: data });
}

export async function patchScene(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  for (const k of ["title","script_excerpt","image_spec","narration_segment","duration_sec"]) if (k in body) allowed[k] = body[k];
  if (Object.keys(allowed).length === 0) return res.status(400).json({ error: "No updatable fields" });
  const { data, error } = await supa.from("scenes").update(allowed).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ scene: data });
}

export async function deleteScene(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { error } = await supa.from("scenes").delete().eq("id", id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
}
