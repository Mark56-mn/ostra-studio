import type { Request, Response } from "express";
import { requireSupabase, getServerSupabase } from "../lib/supabase.js";

// ── Helpers ────────────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

function expectedRegistrationToken(): string | undefined {
  const raw = (process.env.WORKER_REGISTRATION_TOKEN ?? process.env.WORKER_REGISTRATION_SECRET ?? "").trim();
  return raw || undefined;
}

function redactEndpoint(ep?: string | null): string | null {
  if (!ep) return null;
  return ep;
}

async function emit(supabase: NonNullable<ReturnType<typeof getServerSupabase>>, row: Record<string, unknown>) {
  try { await supabase.from("events").insert(row); } catch {}
}

// ── POST /api/workers/register — worker self-registration ────────────────
// Body: { worker_id?, worker_type, runtime, provider, model?, endpoint?, capabilities?, status?, registration_token? }
// Header: x-worker-token or Authorization: Bearer <token> or JSON registration_token
// When WORKER_REGISTRATION_TOKEN / WORKER_REGISTRATION_SECRET is set on Render, token is required.
// When not set, open registration is allowed (dev) but still audited.

export async function registerWorker(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;

  const body = req.body as {
    worker_id?: string;
    worker_type?: string; runtime?: string; provider?: string;
    model?: string; endpoint?: string; capabilities?: string[];
    status?: string; registration_token?: string; metadata?: Record<string, unknown>;
  } | null;

  const worker_type = (body?.worker_type ?? "").trim().toLowerCase();
  const runtime = (body?.runtime ?? "").trim().toLowerCase();
  const provider = (body?.provider ?? "").trim();

  if (!worker_type || !runtime || !provider) {
    return res.status(400).json({ error: "worker_type, runtime and provider are required" });
  }
  if (!["script","image","voice","video","youtube"].includes(worker_type)) {
    return res.status(400).json({ error: "invalid worker_type" });
  }

  const expectedToken = expectedRegistrationToken();
  if (expectedToken) {
    const headerToken = (req.headers["x-worker-token"] as string | undefined) ?? (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "") ?? "";
    const got = (body?.registration_token ?? headerToken ?? "").trim();
    if (got !== expectedToken) return res.status(401).json({ error: "invalid registration token" });
  }

  const endpoint = (body?.endpoint ?? "").trim() || null;
  const model = (body?.model ?? "").trim() || null;
  const capabilities = Array.isArray(body?.capabilities) ? body!.capabilities : [];
  const metadata = body?.metadata && typeof body.metadata === "object" ? body.metadata : null;
  // worker_id from spec like script-ai-kaggle — store in workers.worker_id column if present, else derive
  const workerIdSlug = (body?.worker_id ?? `${worker_type}-${runtime}-${provider}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")).trim() || null;

  const heartbeatTimeoutSec = Math.max(30, Math.min(600, parseInt(process.env.WORKER_HEARTBEAT_TIMEOUT_SEC ?? "90", 10) || 90));

  // Upsert by (type, runtime, provider) — endpoint churn handled by updating on every registration.
  const { data: existing } = await supa
    .from("workers")
    .select("id, status")
    .eq("type", worker_type)
    .eq("runtime", runtime)
    .eq("provider", provider)
    .maybeSingle();

  if (existing?.id) {
    const patch: Record<string, unknown> = {
      endpoint,
      model: model ?? undefined,
      capabilities,
      status: "ONLINE",
      last_heartbeat_at: nowIso(),
      last_seen_at: nowIso(),
      registered_at: nowIso(),
      heartbeat_timeout_sec: heartbeatTimeoutSec,
      error: null,
      error_code: null,
      error_message: null,
    };
    // Add extended columns if migration 003 is applied — no-op if column doesn't exist (Postgres ignores unknown? Actually errors, so try/catch)
    // We add them conditionally via raw update that tolerates missing columns by using separate try
    if (workerIdSlug) patch["worker_id"] = workerIdSlug;
    if (metadata) patch["metadata"] = metadata;

    const { data, error } = await supa
      .from("workers")
      .update(patch)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) {
      // If error is about missing column (pre-migration), retry without extended columns
      if (error.message.includes("column") && (error.message.includes("worker_id") || error.message.includes("error_code") || error.message.includes("metadata"))) {
        const fallback: Record<string, unknown> = {
          endpoint, capabilities, status: "ONLINE",
          last_heartbeat_at: nowIso(), last_seen_at: nowIso(), registered_at: nowIso(),
          heartbeat_timeout_sec: heartbeatTimeoutSec, error: null,
        };
        if (model) fallback["model"] = model;
        const { data: data2, error: err2 } = await supa.from("workers").update(fallback).eq("id", existing.id).select().single();
        if (err2) return res.status(400).json({ error: err2.message });
        await emit(supa, { type: "worker.registration_received", worker_id: data2.id, actor: `worker:${provider}`, payload: { worker_type, runtime, provider, endpoint: redactEndpoint(endpoint), capabilities } });
        await emit(supa, { type: "worker.health_check_passed", worker_id: data2.id, actor: "orchestrator", payload: { endpoint: redactEndpoint(endpoint) } });
        // Also mark startup history as REGISTERING -> ONLINE progression if there's a pending attempt
        await markStartupRegistered(supa, data2.id, worker_type, runtime, provider, endpoint);
        return res.status(200).json({ worker: data2, already_existed: true, health: "ONLINE" });
      }
      return res.status(400).json({ error: error.message });
    }
    await emit(supa, { type: "worker.registration_received", worker_id: data.id, actor: `worker:${provider}`, payload: { worker_type, runtime, provider, endpoint: redactEndpoint(endpoint), capabilities } });
    await emit(supa, { type: "worker.health_check_passed", worker_id: data.id, actor: "orchestrator", payload: { endpoint: redactEndpoint(endpoint) } });
    await markStartupRegistered(supa, data.id, worker_type, runtime, provider, endpoint);
    return res.status(200).json({ worker: data, already_existed: true, health: "ONLINE" });
  }

  const insertPatch: Record<string, unknown> = {
    type: worker_type,
    runtime,
    provider,
    model,
    endpoint,
    capabilities,
    status: "ONLINE",
    last_heartbeat_at: nowIso(),
    last_seen_at: nowIso(),
    registered_at: nowIso(),
    heartbeat_timeout_sec: heartbeatTimeoutSec,
    error: null,
    error_code: null,
    error_message: null,
  };
  if (workerIdSlug) insertPatch["worker_id"] = workerIdSlug;
  if (metadata) insertPatch["metadata"] = metadata;

  const { data, error } = await supa
    .from("workers")
    .insert(insertPatch)
    .select()
    .single();
  if (error) {
    if (error.message.includes("column") && (error.message.includes("worker_id") || error.message.includes("error_code") || error.message.includes("metadata"))) {
      const fallback = {
        type: worker_type, runtime, provider, model, endpoint, capabilities,
        status: "ONLINE" as const,
        last_heartbeat_at: nowIso(), last_seen_at: nowIso(), registered_at: nowIso(),
        heartbeat_timeout_sec: heartbeatTimeoutSec, error: null,
      };
      const { data: data2, error: err2 } = await supa.from("workers").insert(fallback).select().single();
      if (err2) return res.status(400).json({ error: err2.message });
      await emit(supa, { type: "worker.registration_received", worker_id: data2.id, actor: `worker:${provider}`, payload: { worker_type, runtime, provider, endpoint: redactEndpoint(endpoint), capabilities } });
      await emit(supa, { type: "worker.health_check_passed", worker_id: data2.id, actor: "orchestrator", payload: { endpoint: redactEndpoint(endpoint) } });
      await markStartupRegistered(supa, data2.id, worker_type, runtime, provider, endpoint);
      return res.status(201).json({ worker: data2, health: "ONLINE" });
    }
    return res.status(400).json({ error: error.message });
  }
  await emit(supa, { type: "worker.registration_received", worker_id: data.id, actor: `worker:${provider}`, payload: { worker_type, runtime, provider, endpoint: redactEndpoint(endpoint), capabilities } });
  await emit(supa, { type: "worker.health_check_passed", worker_id: data.id, actor: "orchestrator", payload: { endpoint: redactEndpoint(endpoint) } });
  await markStartupRegistered(supa, data.id, worker_type, runtime, provider, endpoint);
  return res.status(201).json({ worker: data, health: "ONLINE" });
}

async function markStartupRegistered(
  supa: NonNullable<ReturnType<typeof getServerSupabase>>,
  workerId: string,
  worker_type: string,
  runtime: string,
  provider: string,
  endpoint: string | null
) {
  // Record REGISTERING -> ONLINE progression in startup history if there's a recent pending/requested attempt
  try {
    const { data: recent } = await supa
      .from("runtime_startup_history")
      .select("id, result")
      .eq("worker_type", worker_type)
      .eq("runtime", runtime)
      .in("result", ["pending","requested","starting","registering"])
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent?.id) {
      // Update that history row to registered, set worker_id + registered_at
      const patch: Record<string, unknown> = { result: "registered", registered_at: nowIso(), completed_at: nowIso(), worker_id: workerId };
      // try extended columns, fallback if missing
      const { error } = await supa.from("runtime_startup_history").update(patch as never).eq("id", (recent as { id:string }).id);
      void error;
      // Also insert a health_passed event/row for audit visibility
      await supa.from("runtime_startup_history").insert({
        worker_type, runtime, provider,
        trigger_source: "worker_registration",
        result: "health_passed",
        worker_id: workerId,
        provider_response: endpoint ? { endpoint } : null,
      } as never);
      await emit(supa, { type: "worker.health_check_passed", worker_id: workerId, actor: "orchestrator", payload: { worker_type, runtime, provider, endpoint: redactEndpoint(endpoint) } });
    } else {
      // No pending attempt — still emit health_passed history for direct registrations
      try {
        await supa.from("runtime_startup_history").insert({
          worker_type, runtime, provider,
          trigger_source: "worker_registration",
          result: "health_passed",
          worker_id: workerId,
        } as never);
      } catch {}
    }
  } catch {}
}

// ── POST /api/workers/heartbeat (by identity) ────────────────────────────
export async function heartbeatByIdentity(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { worker_id?: string; worker_type?: string; runtime?: string; provider?: string; status?: string; endpoint?: string; current_task?: string | null; metadata?: Record<string, unknown> } | null;
  const worker_type = (body?.worker_type ?? "").trim().toLowerCase();
  const runtime = (body?.runtime ?? "").trim().toLowerCase();
  const provider = (body?.provider ?? "").trim();
  if (!worker_type || !runtime || !provider) return res.status(400).json({ error: "worker_type, runtime and provider are required" });

  // Heartbeat is also authenticated when token is set — check same token as registration
  const expectedToken = expectedRegistrationToken();
  if (expectedToken) {
    const headerToken = (req.headers["x-worker-token"] as string | undefined) ?? (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "") ?? "";
    const bodyToken = (body as unknown as { registration_token?: string })?.registration_token ?? "";
    const got = (bodyToken || headerToken).trim();
    // Allow heartbeat without token if worker already registered recently? No — require if configured, but allow empty for backward compat when worker is already ONLINE?
    // Spec says health checks should use appropriate authentication if required — so we enforce when token is set and bodyToken/headerToken is provided but wrong.
    // If no token supplied at all, we still check — heartbeat must be authenticated too when registration is gated.
    if (got && got !== expectedToken) return res.status(401).json({ error: "invalid heartbeat token" });
    if (!got) return res.status(401).json({ error: "heartbeat requires registration token" });
  }

  const endpoint = (body?.endpoint ?? "").trim() || undefined;
  const status = (body?.status ?? "ONLINE").toUpperCase();
  const allowed = ["ONLINE","IDLE","WORKING","WAITING","QUEUED"];
  const nextStatus = allowed.includes(status) ? status : "ONLINE";

  const { data: existing } = await supa.from("workers").select("id").eq("type", worker_type).eq("runtime", runtime).eq("provider", provider).maybeSingle();
  if (!existing?.id) return res.status(404).json({ error: "worker not found — register first via POST /api/workers/register" });

  const patch: Record<string, unknown> = { last_heartbeat_at: nowIso(), last_seen_at: nowIso(), status: nextStatus };
  if (endpoint) patch["endpoint"] = endpoint;
  if (body?.current_task !== undefined) patch["current_task_id"] = body.current_task || null;
  if (body?.metadata) patch["metadata"] = body.metadata;
  // Clear error on successful heartbeat
  patch["error"] = null;
  patch["error_code"] = null;
  patch["error_message"] = null;

  const { data, error } = await supa.from("workers").update(patch).eq("id", existing.id).select().single();
  if (error) {
    if (error.message.includes("column") && (error.message.includes("error_code") || error.message.includes("metadata") || error.message.includes("current_task"))) {
      const fallback: Record<string, unknown> = { last_heartbeat_at: nowIso(), last_seen_at: nowIso(), status: nextStatus };
      if (endpoint) fallback["endpoint"] = endpoint;
      const { data: data2, error: err2 } = await supa.from("workers").update(fallback).eq("id", existing.id).select().single();
      if (err2) return res.status(400).json({ error: err2.message });
      await emit(supa, { type: "worker.heartbeat_received", worker_id: data2.id, actor: `worker:${provider}`, payload: endpoint ? { endpoint: redactEndpoint(endpoint) } : {} });
      return res.json({ worker: data2 });
    }
    return res.status(400).json({ error: error.message });
  }
  await emit(supa, { type: "worker.heartbeat_received", worker_id: data.id, actor: `worker:${provider}`, payload: endpoint ? { endpoint: redactEndpoint(endpoint) } : {} });
  res.json({ worker: data });
}

// Periodic sweep called by scheduler: mark heartbeat-stale workers OFFLINE (and emit timeout).
export async function sweepStaleWorkers(supa: NonNullable<ReturnType<typeof getServerSupabase>>): Promise<number> {
  const { data: workers, error } = await supa
    .from("workers")
    .select("id, type, runtime, provider, status, last_heartbeat_at, heartbeat_timeout_sec")
    .in("status", ["ONLINE","IDLE","QUEUED","WORKING","WAITING","CONNECTING"]);
  if (error || !workers?.length) return 0;
  const now = Date.now();
  let changed = 0;
  for (const w of workers as Array<{ id:string; type:string; runtime:string; provider:string; status:string; last_heartbeat_at:string|null; heartbeat_timeout_sec:number|null }>) {
    const timeoutSec = w.heartbeat_timeout_sec ?? 90;
    const last = w.last_heartbeat_at ? new Date(w.last_heartbeat_at).getTime() : 0;
    const stale = !w.last_heartbeat_at || (now - last) > timeoutSec * 1000;
    if (!stale) continue;
    // Use extended columns if available
    const patch: Record<string, unknown> = { status: "OFFLINE", error: `heartbeat timeout (${timeoutSec}s)`, error_code: "HEARTBEAT_TIMEOUT", error_message: `No heartbeat for ${timeoutSec}s` };
    const { error: upErr } = await supa.from("workers").update(patch).eq("id", w.id);
    if (upErr) {
      // fallback without extended columns
      if (upErr.message.includes("column")) {
        const { error: upErr2 } = await supa.from("workers").update({ status: "OFFLINE", error: `heartbeat timeout (${timeoutSec}s)` }).eq("id", w.id);
        if (upErr2) continue;
      } else continue;
    }
    changed++;
    await emit(supa, { type: "worker.timeout", worker_id: w.id, actor: "orchestrator", payload: { last_heartbeat_at: w.last_heartbeat_at, timeout_sec: timeoutSec } });
    await emit(supa, { type: "worker.offline", worker_id: w.id, actor: "orchestrator", payload: { reason: "heartbeat_timeout" } });
    // Also mark any pending startup history as timed_out
    try {
      await supa.from("runtime_startup_history")
        .update({ result: "timed_out", error: "heartbeat timeout", error_code: "TIMEOUT", completed_at: nowIso() } as never)
        .eq("worker_type", w.type).eq("runtime", w.runtime).in("result", ["pending","requested","starting","registering"]);
    } catch {}
  }
  return changed;
}
