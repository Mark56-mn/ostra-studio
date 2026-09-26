import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

export async function listEvents(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const episodeId = (req.query.episodeId as string) ?? null;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
  let q = supa.from("events").select("*").order("created_at", { ascending: false }).limit(limit);
  if (episodeId) q = q.eq("episode_id", episodeId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data ?? [] });
}

export async function createEvent(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { type?: string; project_id?: string; episode_id?: string; task_id?: string; worker_id?: string; actor?: string; payload?: Record<string, unknown> } | null;
  if (!body?.type) return res.status(400).json({ error: "type is required" });
  const { data, error } = await supa.from("events").insert({
    type: body.type, project_id: body.project_id ?? null, episode_id: body.episode_id ?? null,
    task_id: body.task_id ?? null, worker_id: body.worker_id ?? null, actor: body.actor ?? "api", payload: body.payload ?? null,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ event: data });
}
