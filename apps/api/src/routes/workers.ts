import type { Request, Response } from "express";
import { workerDisplayHealth, type WorkerHealthRow } from "@ostra/shared";
import { getServerSupabase, requireSupabase, supabaseConfigReason } from "../lib/supabase.js";

// GET /api/workers — the real worker registry, with status derived from heartbeat freshness.
// There is NO synthetic fallback list: if the backend cannot read Supabase it says so explicitly
// (503 + reason) so the dashboard can tell "backend unreachable" from "no workers registered".
export async function listWorkers(_req: Request, res: Response) {
  const c = getServerSupabase();
  if (!c) {
    return res.status(503).json({
      error: "Supabase not configured",
      reason: supabaseConfigReason() ?? "Supabase is not configured on the backend",
      hint: "Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on Render, then wait for a worker to register.",
      workers: [],
    });
  }
  const { data, error } = await c.from("workers").select("*").order("type");
  if (error) {
    return res.status(500).json({ error: error.message, workers: [] });
  }
  // Layer the real health on top of the raw row (heartbeat freshness), so the dashboard never has
  // to re-implement the rule and a stale row is never presented as ONLINE.
  const workers = (data ?? []).map((row) => ({
    ...(row as Record<string, unknown>),
    health: workerDisplayHealth(row as WorkerHealthRow),
  }));
  res.json({ workers, source: "supabase", timestamp: new Date().toISOString() });
}

export async function createWorker(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { type?: string; provider?: string; model?: string; runtime?: string; capabilities?: string[]; status?: string } | null;
  if (!body?.type || !body?.provider) return res.status(400).json({ error: "type and provider are required" });
  const { data, error } = await supa.from("workers").insert({
    type: body.type, provider: body.provider, model: body.model ?? null, runtime: body.runtime ?? null,
    capabilities: body.capabilities ?? [], status: body.status ?? "OFFLINE",
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await supa.from("events").insert({ type: "worker.connected", worker_id: data.id, actor: "orchestrator", payload: { type: body.type, provider: body.provider } });
  res.status(201).json({ worker: data });
}

export async function patchWorker(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  for (const k of ["status","current_task_id","last_heartbeat_at","error","capabilities","model","runtime","config"]) if (k in body) allowed[k] = body[k];
  if (Object.keys(allowed).length === 0) return res.status(400).json({ error: "No updatable fields" });
  // heartbeat touch
  if (allowed.status === "ONLINE" || allowed.status === "IDLE" || allowed.status === "WORKING") {
    if (!("last_heartbeat_at" in allowed)) allowed["last_heartbeat_at"] = new Date().toISOString();
  }
  const { data, error } = await supa.from("workers").update(allowed).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ worker: data });
}

export async function heartbeatWorker(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data, error } = await supa.from("workers").update({
    last_heartbeat_at: new Date().toISOString(),
    status: (req.body as { status?: string })?.status ?? "ONLINE",
  }).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ worker: data });
}
