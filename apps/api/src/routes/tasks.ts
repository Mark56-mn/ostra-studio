import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

export async function listTasks(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const episodeId = (req.query.episodeId as string) ?? null;
  const status = (req.query.status as string) ?? null;
  let q = supa.from("tasks").select("*").order("created_at", { ascending: false }).limit(100);
  if (episodeId) q = q.eq("episode_id", episodeId);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: data ?? [] });
}

export async function createTask(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { project_id?: string; episode_id?: string; scene_id?: string; type?: string; worker_type?: string; input?: Record<string, unknown>; depends_on?: string[] } | null;
  if (!body?.type || !body?.worker_type) return res.status(400).json({ error: "type and worker_type are required" });
  const validWorker = ["script","image","voice","video","youtube"];
  if (!validWorker.includes(body.worker_type)) return res.status(400).json({ error: "Invalid worker_type" });
  const { data, error } = await supa
    .from("tasks")
    .insert({
      project_id: body.project_id ?? null, episode_id: body.episode_id ?? null, scene_id: body.scene_id ?? null,
      type: body.type, worker_type: body.worker_type, input: body.input ?? null,
      depends_on: body.depends_on ?? [], status: "pending",
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await supa.from("events").insert({ type: "task.created", project_id: body.project_id ?? null, episode_id: body.episode_id ?? null, task_id: data.id, actor: "orchestrator", payload: { taskType: body.type } });
  res.status(201).json({ task: data });
}

export async function patchTask(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  for (const k of ["status","worker_id","output","error","attempts","started_at","completed_at"]) if (k in body) allowed[k] = body[k];
  if (Object.keys(allowed).length === 0) return res.status(400).json({ error: "No updatable fields" });
  if ("status" in allowed) {
    const valid = ["pending","queued","working","waiting","completed","failed","retrying","cancelled"];
    if (typeof allowed.status !== "string" || !valid.includes(allowed.status)) return res.status(400).json({ error: "Invalid status" });
    if (allowed.status === "working" && !("started_at" in allowed)) allowed["started_at"] = new Date().toISOString();
    if (["completed","failed","cancelled"].includes(allowed.status as string) && !("completed_at" in allowed)) allowed["completed_at"] = new Date().toISOString();
  }
  const { data, error } = await supa.from("tasks").update(allowed).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  // Emit audited event for status transitions
  if ("status" in allowed) {
    const evtMap: Record<string,string> = { queued:"task.started", working:"task.started", waiting:"task.waiting", completed:"task.completed", failed:"task.failed", retrying:"task.retried", cancelled:"task.failed" };
    const evt = evtMap[allowed.status as string];
    if (evt) await supa.from("events").insert({ type: evt, task_id: id, episode_id: data.episode_id, project_id: data.project_id, actor: "orchestrator", payload: { status: allowed.status } });
  }
  res.json({ task: data });
}
