import type { Request, Response } from "express";
import { classifySlugWriteError, resolveProjectSlug, slugCandidates } from "@ostra/shared";
import { requireSupabase } from "../lib/supabase.js";

export async function listProjects(_req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { data, error } = await supa.from("projects").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ projects: data ?? [] });
}

const SLUG_HELP =
  "Could not derive a valid slug — use at least two letters or numbers (a-z, 0-9 and hyphens), " +
  "or leave the slug blank to derive it from the title.";

// Postgres never gets to explain itself to the user: a rejected slug is always reported as the
// same actionable 400, whatever the database column/constraint happens to be named.
const SLUG_REJECTED = `${SLUG_HELP} (The database rejected the generated slug.)`;

export async function createProject(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { slug?: string; title?: string; logline?: string; story_bible?: Record<string, unknown> } | null;

  const title = (body?.title ?? "").toString().trim();
  if (!title) return res.status(400).json({ error: "title is required" });

  // Always hand Postgres a slug that satisfies `projects_slug_check` (slug ~ '^[a-z0-9-]{2,64}$').
  // The slug is optional: when it is missing or unusable we derive it from the title.
  const baseSlug = resolveProjectSlug(body?.slug, title);
  if (!baseSlug) return res.status(400).json({ error: SLUG_HELP });

  // slug is UNIQUE. Deriving from the title makes collisions likely, so retry with a numeric
  // suffix instead of surfacing a raw duplicate-key error to the user. Every candidate is
  // pre-validated against `projects_slug_check` (see slugCandidates) so the suffix can never
  // push the value out of range.
  for (const slug of slugCandidates(baseSlug)) {
    const { data, error } = await supa
      .from("projects")
      .insert({ slug, title, logline: body?.logline ?? null, story_bible: body?.story_bible ?? {} })
      .select()
      .single();
    if (!error) return res.status(201).json({ project: data });
    const kind = classifySlugWriteError((error as { code?: string }).code);
    if (kind === "duplicate") continue; // slug taken — try the next suffix
    if (kind === "invalid") return res.status(400).json({ error: SLUG_REJECTED, detail: error.message });
    return res.status(400).json({ error: error.message });
  }
  return res.status(409).json({ error: `Could not allocate a unique slug for "${baseSlug}".` });
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
