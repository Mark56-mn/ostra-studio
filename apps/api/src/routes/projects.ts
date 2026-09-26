import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

export async function listProjects(_req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { data, error } = await supa.from("projects").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ projects: data ?? [] });
}

export async function createProject(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { slug?: string; title?: string; logline?: string; story_bible?: Record<string, unknown> } | null;
  if (!body?.slug || !body?.title) return res.status(400).json({ error: "slug and title are required" });
  const { data, error } = await supa
    .from("projects")
    .insert({ slug: body.slug, title: body.title, logline: body.logline ?? null, story_bible: body.story_bible ?? {} })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ project: data });
}

export async function getProject(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data, error } = await supa.from("projects").select("*").eq("id", id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json({ project: data });
}

export async function patchProject(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as Record<string, unknown>;
  // Only allow known fields
  const allowed: Record<string, unknown> = {};
  for (const k of ["title", "logline", "story_bible"]) if (k in body) allowed[k] = body[k];
  if (Object.keys(allowed).length === 0) return res.status(400).json({ error: "No updatable fields" });
  const { data, error } = await supa.from("projects").update(allowed).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ project: data });
}
