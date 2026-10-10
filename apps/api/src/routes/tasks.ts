import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isProductionWorkerType, productionGate, type SeasonStatus } from "@ostra/shared";
import { requireSupabase } from "../lib/supabase.js";

/**
 * SEASON-FIRST PRODUCTION GATE (spec §5 + its acceptance test).
 *
 * Expensive work (image / voice / video / youtube) may only be created for a project that has an
 * APPROVED season. The gate is the same pure decision the dashboard renders, so what the UI shows is
 * what the API enforces. Preparation work (script) is deliberately not gated — the story has to be
 * written before it can be approved.
 *
 * Returns null when the task is allowed, or the refusal to send back verbatim.
 */
async function productionGateRefusal(
  supa: SupabaseClient,
  body: { project_id?: string | null; episode_id?: string | null; scene_id?: string | null; worker_type: string }
): Promise<{ status: number; payload: Record<string, unknown> } | null> {
  if (!isProductionWorkerType(body.worker_type)) return null;

  // Resolve which project this work belongs to, through the episode/scene when needed.
  let projectId = body.project_id ?? null;
  if (!projectId && body.episode_id) {
    const { data: ep } = await supa.from("episodes").select("project_id").eq("id", body.episode_id).maybeSingle();
    projectId = ep?.project_id ?? null;
  }
  if (!projectId && body.scene_id) {
    const { data: scene } = await supa.from("scenes").select("episode_id").eq("id", body.scene_id).maybeSingle();
    if (scene?.episode_id) {
      const { data: ep } = await supa.from("episodes").select("project_id").eq("id", scene.episode_id).maybeSingle();
      projectId = ep?.project_id ?? null;
    }
  }
  // A production task with no project at all cannot be checked against a story, so it is refused
  // rather than waved through — the alternative is untracked, ungoverned generation.
  if (!projectId) {
    return {
      status: 400,
      payload: {
        error: "SEASON_NOT_APPROVED",
        reason: `A '${body.worker_type}' task must belong to a project with an approved season. Pass project_id (or an episode_id/scene_id that resolves to one).`,
      },
    };
  }

  const { data: seasons } = await supa
    .from("seasons")
    .select("id, status, title")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  const gate = productionGate((seasons ?? []) as Array<{ id: string; status: SeasonStatus; title: string | null }>, projectId);
  if (gate.allowed) return null;
  return {
    status: 409,
    payload: { error: "SEASON_NOT_APPROVED", reason: gate.reason, season_status: gate.status, project_id: projectId },
  };
}

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

  // Refuse expensive work on an unapproved story, by name — never silently drop it.
  const refusal = await productionGateRefusal(supa, {
    project_id: body.project_id ?? null,
    episode_id: body.episode_id ?? null,
    scene_id: body.scene_id ?? null,
    worker_type: body.worker_type,
  });
  if (refusal) return res.status(refusal.status).json(refusal.payload);

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
  // A real failure reaches the human's inbox once (deduped), never silently.
  if (allowed.status === "failed") {
    await supa.from("notifications").insert({
      kind: "task_failed",
      project_id: data.project_id ?? null,
      title: `Task failed: ${data.type ?? id}`,
      body: typeof allowed.error === "string" ? allowed.error.slice(0, 500) : `The ${data.worker_type} task failed.`,
      severity: "warning",
      requires_action: false,
      dedupe_key: `task_failed:${id}`,
    }).then(() => undefined, () => undefined);
  }
  res.json({ task: data });
}
