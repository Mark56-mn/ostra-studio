import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";
import { schedulerTick, runNow, runNowByWorker } from "../lib/scheduler.js";

function tickTokens(): { cron: string | undefined; worker: string | undefined } {
  const cron = process.env.CRON_SECRET?.trim() || undefined;
  const worker = (process.env.WORKER_REGISTRATION_TOKEN ?? process.env.WORKER_REGISTRATION_SECRET ?? "").trim() || undefined;
  return { cron, worker };
}

// POST /api/runtime/tick — internal scheduler heartbeat (call with header auth on Render Cron or internal loop)
// Accept: x-cron-secret when CRON_SECRET is set; otherwise require WORKER_REGISTRATION_TOKEN / WORKER_REGISTRATION_SECRET; otherwise open in dev.
export async function schedulerTickHandler(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;

  const { cron: expected, worker: workerToken } = tickTokens();
  if (expected || workerToken) {
    const got = ((req.headers["x-cron-secret"] as string) ?? (req.headers["x-worker-token"] as string) ?? (req.headers["authorization"] as string)?.replace(/^Bearer\s+/,"") ?? "").trim();
    const ok = (expected && got === expected) || (workerToken && got === workerToken);
    if (!ok) return res.status(401).json({ error: "unauthorized tick" });
  }

  const now = req.body?.at ? new Date(req.body.at as string) : new Date();
  if (isNaN(now.getTime())) return res.status(400).json({ error: "invalid at" });
  try {
    const result = await schedulerTick(supa, now);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// POST /api/runtime/run-now — Dashboard manual "Run Now" (same lifecycle as schedule)
export async function runNowHandler(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { schedule_id?: string; worker_type?: string; runtime?: string; provider?: string } | null;
  if (body?.schedule_id) {
    const r = await runNow(supa, body.schedule_id);
    const status = r.action === "requested" ? 201 : r.action.startsWith("skipped") ? 200 : r.action === "not_autostartable" ? 409 : 400;
    return res.status(status).json(r);
  }
  if (body?.worker_type && body?.runtime && body?.provider) {
    const r = await runNowByWorker(supa, body.worker_type, body.runtime, body.provider);
    const status = r.action === "requested" ? 201 : r.action.startsWith("skipped") ? 200 : r.action === "not_autostartable" ? 409 : 400;
    return res.status(status).json(r);
  }
  return res.status(400).json({ error: "provide schedule_id or worker_type+runtime+provider" });
}

// GET /api/runtime/history?scheduleId=&worker_type=&runtime=&limit=
export async function listStartupHistory(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const scheduleId = (req.query.scheduleId as string) ?? null;
  const worker_type = (req.query.worker_type as string) ?? null;
  const runtime = (req.query.runtime as string) ?? null;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
  let q = supa.from("runtime_startup_history").select("*").order("requested_at", { ascending: false }).limit(limit);
  if (scheduleId) q = q.eq("schedule_id", scheduleId);
  if (worker_type) q = q.eq("worker_type", worker_type);
  if (runtime) q = q.eq("runtime", runtime);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data ?? [] });
}

// GET /api/runtime/schedules — convenience alias
export { listStartupHistory as _list }
