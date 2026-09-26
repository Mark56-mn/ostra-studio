import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

export async function listCharacters(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const projectId = (req.query.projectId as string) ?? null;
  if (!projectId) return res.status(400).json({ error: "projectId required" });
  const { data, error } = await supa.from("characters").select("*").eq("project_id", projectId).order("created_at");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ characters: data ?? [] });
}
export async function createCharacter(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const b = req.body as { project_id?: string; name?: string; role?: string; description?: string; visual_ref?: string } | null;
  if (!b?.project_id || !b?.name) return res.status(400).json({ error: "project_id and name required" });
  const { data, error } = await supa.from("characters").insert({ project_id: b.project_id, name: b.name, role: b.role ?? null, description: b.description ?? null, visual_ref: b.visual_ref ?? null }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ character: data });
}
export async function patchCharacter(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const b = req.body as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  for (const k of ["name","role","description","visual_ref"]) if (k in b) allowed[k] = b[k];
  if (!Object.keys(allowed).length) return res.status(400).json({ error: "No fields" });
  const { data, error } = await supa.from("characters").update(allowed).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ character: data });
}
export async function deleteCharacter(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { error } = await supa.from("characters").delete().eq("id", id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
}
