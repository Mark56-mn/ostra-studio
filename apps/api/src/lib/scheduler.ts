import type { SupabaseClient } from "@supabase/supabase-js";
import { isDueNow } from "@ostra/shared";
import { findWorkerByTypeRuntime, isHealthyWorker } from "./workerHealth.js";
import { tryAcquireLease, releaseLease } from "./lease.js";
import { KaggleRuntimeStarter, ColabImageRuntimeStarter, ColabVoiceRuntimeStarter, findStarter, resolveRuntimeStarters, redactSecrets } from "@ostra/shared";
import type { RuntimeStartOutcome } from "@ostra/shared";

// ── Types ────────────────────────────────────────────────────────────────────
type TickResult = {
  checkedAt: string;
  schedulesChecked: number;
  started: Array<{ scheduleId: string; worker_type: string; runtime: string; historyId?: string }>;
  skippedReason?: string;
};

// Mapping outcome codes to error_code for spec history
function codeToErrorCode(code?: string): string | null {
  if (!code) return null;
  if (code === "NOT_AUTOSTARTABLE") return "NOT_AUTOSTARTABLE";
  if (code === "AUTH_FAILED") return "AUTH_FAILED";
  if (code === "RATE_LIMITED") return "RATE_LIMITED";
  if (code === "QUOTA_EXCEEDED") return "QUOTA_EXCEEDED";
  return code;
}

// ── Core: evaluate one schedule firing ─────────────────────────────────────

async function evaluateAndStart(
  supa: SupabaseClient,
  schedule: Record<string, unknown>,
  triggerSource: string // e.g. `scheduler:<id>` or `run_now`
): Promise<{ action: string; historyId?: string; error?: string }> {
  const worker_type = schedule.worker_type as string;
  const runtime = schedule.runtime as string;
  const provider = schedule.provider as string;
  const startup_mode = (schedule.startup_mode as string) ?? "kaggle_kernel";
  const cooldownMinutes = (schedule.cooldown_minutes as number) ?? 15;
  const maxAttempts = (schedule.max_start_attempts as number) ?? 3;
  const scheduleId = schedule.id as string;
  const scheduleIdForFk = (typeof scheduleId === "string" && scheduleId.includes(":")) ? null : (scheduleId as string);
  const isRunNow = triggerSource.startsWith("run_now");
  const forHistorySource = isRunNow ? "run_now" : `scheduler:${scheduleId}`;
  // synthetic startup_request_id for correlation before starter returns one
  const preRequestId = `req:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,7)}`;

  // 0) Not autostartable guard — check startup_mode first (no fetch, no lease)
  if (startup_mode === "not_autostartable") {
    const h = await insertHistory(supa, {
      schedule_id: scheduleIdForFk, worker_type, runtime, provider,
      trigger_source: forHistorySource, startup_request_id: preRequestId,
      provider_run_id: null, provider_response: null,
      result: "not_autostartable", status: "CANCELLED",
      error: "Startup mode is not_autostartable — no automatic trigger configured",
      error_code: "NOT_AUTOSTARTABLE",
    });
    await emit(supa, "scheduler.skipped_not_autostartable", null, { schedule_id: scheduleId, worker_type, runtime });
    return { action: "not_autostartable", historyId: h?.id as string | undefined };
  }

  // 1) Is worker already healthy? → skip (Case A)
  const worker = await findWorkerByTypeRuntime(supa, worker_type, runtime);
  if (isHealthyWorker(worker)) {
    const h = await insertHistory(supa, {
      schedule_id: scheduleIdForFk, worker_type, runtime, provider,
      trigger_source: forHistorySource, startup_request_id: preRequestId,
      provider_run_id: null, provider_response: null,
      result: "skipped_already_online", status: "CANCELLED", error: null, error_code: null,
      worker_id: worker?.id ?? null,
    });
    await emit(supa, "scheduler.skipped_already_online", worker?.id ?? null, { schedule_id: scheduleId, worker_type, runtime });
    return { action: "skipped_already_online", historyId: h?.id as string | undefined };
  }

  // 2) Cooldown check — if last start was < cooldown ago and still not healthy, skip
  if (!isRunNow) {
    const { data: lastHistory } = await supa
      .from("runtime_startup_history")
      .select("requested_at, result")
      .eq("worker_type", worker_type)
      .eq("runtime", runtime)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastHistory) {
      const lastAt = new Date((lastHistory as { requested_at: string }).requested_at).getTime();
      const ageMin = (Date.now() - lastAt) / 60000;
      const lastResult = (lastHistory as { result: string }).result;
      const cooldownApplicable = !["skipped_already_online","not_autostartable"].includes(lastResult);
      if (cooldownApplicable && ageMin < cooldownMinutes) {
        const h = await insertHistory(supa, {
          schedule_id: scheduleIdForFk, worker_type, runtime, provider,
          trigger_source: forHistorySource, startup_request_id: preRequestId,
          provider_run_id: null, provider_response: null,
          result: "skipped_cooldown", status: "CANCELLED",
          error: `Cooldown: last start ${Math.round(ageMin)}m ago, need ${cooldownMinutes}m`,
          error_code: "COOLDOWN",
        });
        await emit(supa, "scheduler.skipped_cooldown", worker?.id ?? null, { schedule_id: scheduleId, cooldown_minutes: cooldownMinutes });
        return { action: "skipped_cooldown", historyId: h?.id as string | undefined };
      }
    }
  }

  // 3) Check recent attempt count (bounded retry) — count pending/requested/failed within last 24h (Case B_retry)
  const since = new Date(Date.now() - 24*3600*1000).toISOString();
  const { data: recentAttempts } = await supa
    .from("runtime_startup_history")
    .select("id")
    .eq("worker_type", worker_type)
    .eq("runtime", runtime)
    .gte("requested_at", since)
    .in("result", ["pending","requested","starting","registering","failed","timed_out"]);
  const attemptCount = (recentAttempts ?? []).length;
  if (attemptCount >= maxAttempts) {
    const h = await insertHistory(supa, {
      schedule_id: scheduleIdForFk, worker_type, runtime, provider,
      trigger_source: forHistorySource, startup_request_id: preRequestId,
      provider_run_id: null, provider_response: null,
      result: "failed", status: "FAILED",
      error: `Max attempts reached (${maxAttempts} in 24h)`, error_code: "MAX_ATTEMPTS",
    });
    await emit(supa, "scheduler.start_failed", null, { schedule_id: scheduleId, reason: "max_attempts", max_start_attempts: maxAttempts });
    return { action: "max_attempts", historyId: h?.id as string | undefined, error: `max attempts ${maxAttempts}` };
  }

  // 4) Acquire startup lease (persisted, survives restart — Case E) — TTL = cooldown or 30m, whichever larger
  const ttl = Math.max(cooldownMinutes, 30);
  const leaseRes = await tryAcquireLease(supa, {
    worker_type, runtime, trigger_source: forHistorySource, schedule_id: scheduleIdForFk, ttlMinutes: ttl,
  });
  if (!leaseRes.acquired) {
    const h = await insertHistory(supa, {
      schedule_id: scheduleIdForFk, worker_type, runtime, provider,
      trigger_source: forHistorySource, startup_request_id: preRequestId,
      provider_run_id: null, provider_response: null,
      result: "skipped_in_progress", status: "CANCELLED",
      error: leaseRes.reason, error_code: "LEASE_HELD",
    });
    await emit(supa, "scheduler.skipped_in_progress", worker?.id ?? null, { schedule_id: scheduleId, lease_reason: leaseRes.reason });
    return { action: "skipped_in_progress", historyId: h?.id as string | undefined };
  }
  const leaseId = leaseRes.leaseId;

  // 5) Request runtime startup via the abstraction (server-side only)
  await emit(supa, "scheduler.triggered", null, { schedule_id: scheduleId, worker_type, runtime, trigger_source: forHistorySource });

  let outcome: RuntimeStartOutcome;
  try {
    outcome = await startViaStarter(schedule, forHistorySource);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const h = await insertHistory(supa, {
      schedule_id: scheduleIdForFk, worker_type, runtime, provider,
      trigger_source: forHistorySource, startup_request_id: preRequestId,
      provider_run_id: null, provider_response: redactSecrets({ error: msg }) as Record<string,unknown>,
      result: "failed", status: "FAILED", error: msg, error_code: "UNKNOWN",
    });
    await emit(supa, "scheduler.start_failed", null, { schedule_id: scheduleId, error: msg });
    await releaseLease(supa, leaseId);
    try { await supa.from("events").insert({ type: "worker.offline", actor: "scheduler", payload: { worker_type, runtime, reason: msg } }); } catch {}
    return { action: "failed", historyId: h?.id as string | undefined, error: msg };
  }

  if (!outcome.ok) {
    const code = outcome.code ?? "UNKNOWN";
    const result: string = code === "NOT_AUTOSTARTABLE" ? "not_autostartable" : "failed";
    const status = code === "NOT_AUTOSTARTABLE" ? "CANCELLED" : "FAILED";
    const h = await insertHistory(supa, {
      schedule_id: scheduleIdForFk, worker_type, runtime, provider,
      trigger_source: forHistorySource, startup_request_id: preRequestId,
      provider_run_id: null, provider_response: redactSecrets(outcome.provider_response) as Record<string,unknown>,
      result: result as never, status: status as never, error: outcome.error, error_code: codeToErrorCode(code),
    });
    await emit(supa, code === "NOT_AUTOSTARTABLE" ? "scheduler.skipped_not_autostartable" : "scheduler.start_failed", null, { schedule_id: scheduleId, code, error: outcome.error });
    await releaseLease(supa, leaseId);
    if (code !== "NOT_AUTOSTARTABLE") {
      try { await supa.from("events").insert({ type: "worker.offline", actor: "scheduler", payload: { worker_type, runtime, reason: outcome.error } }); } catch {}
    }
    return { action: result, historyId: h?.id as string | undefined, error: outcome.error };
  }

  // 6) Success — startup requested (NOT ONLINE). History progresses: REQUESTED -> STARTING -> REGISTERING -> ONLINE
  // We record the initial REQUESTED + STARTING; registration will advance to REGISTERING -> ONLINE via worker registration.
  const realRequestId = outcome.startup_request_id ?? preRequestId;
  const h = await insertHistory(supa, {
    schedule_id: scheduleIdForFk, worker_type, runtime, provider,
    trigger_source: forHistorySource, startup_request_id: realRequestId,
    provider_run_id: outcome.provider_run_id ?? null,
    provider_response: redactSecrets(outcome.provider_response) as Record<string,unknown>,
    result: "requested", status: "REQUESTED", error: null, error_code: null,
    started_at: new Date().toISOString(),
  });
  try { await supa.from("runtime_startup_leases").update({ provider_run_id: outcome.provider_run_id ?? null }).eq("id", leaseId); } catch {}
  await emit(supa, "scheduler.start_requested", null, {
    schedule_id: scheduleId, worker_type, runtime,
    startup_request_id: realRequestId, provider_run_id: outcome.provider_run_id ?? null,
  });
  // Immediately also record STARTING for lifecycle visibility (REQUESTED -> STARTING)
  await insertHistory(supa, {
    schedule_id: scheduleIdForFk, worker_type, runtime, provider,
    trigger_source: forHistorySource, startup_request_id: realRequestId,
    provider_run_id: outcome.provider_run_id ?? null,
    provider_response: null,
    result: "starting", status: "STARTING", error: null, error_code: null,
    started_at: new Date().toISOString(),
  });
  await releaseLease(supa, leaseId);
  return { action: "requested", historyId: h?.id as string | undefined };
}

async function startViaStarter(schedule: Record<string, unknown>, triggerSource: string): Promise<RuntimeStartOutcome> {
  const worker_type = schedule.worker_type as string;
  const runtime = schedule.runtime as string;
  const provider = schedule.provider as string;
  const map = resolveRuntimeStarters();
  const starter = findStarter(map, runtime, provider);
  if (!starter) {
    const isColab = runtime === "colab";
    const isVoice = worker_type === "voice" || provider.includes("kokoro") || provider.includes("voice");
    const fallback: import("@ostra/shared").RuntimeStarter | null = isColab
      ? (isVoice ? new ColabVoiceRuntimeStarter() : new ColabImageRuntimeStarter())
      : new KaggleRuntimeStarter();
    if (fallback) return fallback.start({ worker_type, runtime, provider, trigger_source: triggerSource, config: schedule as Record<string, unknown> });
    return { ok: false, error: `No starter for runtime=${runtime} provider=${provider}`, code: "NOT_AUTOSTARTABLE" } as RuntimeStartOutcome;
  }
  return starter.start({ worker_type, runtime, provider, trigger_source: triggerSource, config: schedule as Record<string, unknown> });
}

async function insertHistory(
  supa: SupabaseClient,
  args: {
    schedule_id: string | null; worker_type: string; runtime: string; provider: string;
    trigger_source: string; startup_request_id?: string | null; provider_run_id: string | null;
    provider_response: Record<string, unknown> | null; result: string; status?: string | null;
    error: string | null; error_code?: string | null; worker_id?: string | null;
    started_at?: string | null; registered_at?: string | null; completed_at?: string | null;
    metadata?: Record<string, unknown> | null;
  }
) {
  // Try with extended columns (003), fallback to legacy if columns missing
  const payload: Record<string, unknown> = {
    schedule_id: args.schedule_id, worker_type: args.worker_type, runtime: args.runtime, provider: args.provider,
    trigger_source: args.trigger_source, provider_run_id: args.provider_run_id, provider_response: args.provider_response,
    result: args.result, error: args.error,
  };
  if (args.startup_request_id) payload["startup_request_id"] = args.startup_request_id;
  if (args.status) payload["status"] = args.status;
  if (args.error_code) payload["error_code"] = args.error_code;
  if (args.error_code || args.error) {
    payload["error_message"] = args.error;
    if (args.error_code && !payload["error_code"]) payload["error_code"] = args.error_code;
  }
  if (args.worker_id) payload["worker_id"] = args.worker_id;
  if (args.started_at) payload["started_at"] = args.started_at;
  if (args.registered_at) payload["registered_at"] = args.registered_at;
  if (args.completed_at) payload["completed_at"] = args.completed_at;
  if (args.metadata) payload["metadata"] = args.metadata;

  const { data, error } = await supa.from("runtime_startup_history").insert(payload as never).select("id").single();
  if (!error) return data as { id: string } | null;
  if (error.message.includes("column") || error.message.includes("constraint") || error.message.includes("check")) {
    // Retry with minimal legacy columns
    const legacy: Record<string, unknown> = {
      schedule_id: args.schedule_id, worker_type: args.worker_type, runtime: args.runtime, provider: args.provider,
      trigger_source: args.trigger_source, provider_run_id: args.provider_run_id, provider_response: args.provider_response,
      result: args.result, error: args.error,
    };
    const { data: data2 } = await supa.from("runtime_startup_history").insert(legacy as never).select("id").single();
    return (data2 as { id:string } | null) ?? null;
  }
  return data as { id: string } | null;
}

async function emit(supa: SupabaseClient, type: string, workerId: string | null, payload: Record<string, unknown>) {
  try { await supa.from("events").insert({ type, worker_id: workerId, actor: "scheduler", payload }); } catch {}
}

// ── Public entry points ──────────────────────────────────────────────────────

// Called every minute by the scheduler tick (Render). Evaluates all enabled schedules.
export async function schedulerTick(supa: SupabaseClient, now: Date): Promise<TickResult> {
  const { data: schedules, error } = await supa.from("runtime_schedules").select("*").eq("enabled", true);
  if (error) throw new Error(error.message);
  const res: TickResult = { checkedAt: now.toISOString(), schedulesChecked: (schedules ?? []).length, started: [] };
  for (const s of (schedules as Record<string, unknown>[] | null) ?? []) {
    const normalized = {
      ...s,
      days_of_week: Array.isArray((s as unknown as { days_of_week?: unknown }).days_of_week) ? (s as unknown as { days_of_week: number[] }).days_of_week : [0,1,2,3,4,5,6],
    } as unknown as import("@ostra/shared").RuntimeSchedule;
    if (!isDueNow(normalized, now)) continue;
    const r = await evaluateAndStart(supa, s as Record<string, unknown>, `scheduler:${s.id as string}`);
    if (r.action === "requested") res.started.push({ scheduleId: s.id as string, worker_type: s.worker_type as string, runtime: s.runtime as string, historyId: r.historyId });
  }
  try {
    const { sweepStaleWorkers } = await import("../routes/registration.js");
    await sweepStaleWorkers(supa);
  } catch {}
  return res;
}

// Same lifecycle as the scheduled trigger — used by Dashboard "Run Now".
export async function runNow(supa: SupabaseClient, scheduleId: string): Promise<{ action: string; historyId?: string; error?: string }> {
  const { data: s, error } = await supa.from("runtime_schedules").select("*").eq("id", scheduleId).single();
  if (error) return { action: "failed", error: error.message };
  return evaluateAndStart(supa, s as Record<string, unknown>, `run_now:${scheduleId}`);
}

// Run Now by (worker_type, runtime) when the user doesn't have a schedule yet (ad-hoc).
export async function runNowByWorker(supa: SupabaseClient, worker_type: string, runtime: string, provider: string): Promise<{ action: string; historyId?: string; error?: string }> {
  const fake: Record<string, unknown> = {
    id: `run_now:${worker_type}:${runtime}`,
    worker_type, runtime, provider,
    startup_mode: runtime === "kaggle" ? "kaggle_kernel" : runtime === "colab" ? "colab_notebook" : "not_autostartable",
    cooldown_minutes: 0,
    max_start_attempts: 5,
    provider_run_id: null,
  };
  const worker = await (await import("./workerHealth.js")).findWorkerByTypeRuntime(supa, worker_type, runtime);
  const { isHealthyWorker: isHealthy } = await import("./workerHealth.js");
  if (isHealthy(worker)) {
    const h = await insertHistory(supa, {
      schedule_id: null, worker_type, runtime, provider,
      trigger_source: "run_now", startup_request_id: `req:${Date.now().toString(36)}`,
      provider_run_id: null, provider_response: null,
      result: "skipped_already_online", status: "CANCELLED", error: null, error_code: null, worker_id: worker?.id ?? null,
    });
    await emit(supa, "scheduler.skipped_already_online", worker?.id ?? null, { worker_type, runtime });
    return { action: "skipped_already_online", historyId: h?.id as string | undefined };
  }
  const { tryAcquireLease: tryAcq, releaseLease: relLease } = await import("./lease.js");
  const ttl = 30;
  const leaseRes = await tryAcq(supa, { worker_type, runtime, trigger_source: "run_now", ttlMinutes: ttl });
  if (!leaseRes.acquired) {
    const h = await insertHistory(supa, {
      schedule_id: null, worker_type, runtime, provider,
      trigger_source: "run_now", startup_request_id: `req:${Date.now().toString(36)}`,
      provider_run_id: null, provider_response: null,
      result: "skipped_in_progress", status: "CANCELLED", error: leaseRes.reason, error_code: "LEASE_HELD",
    });
    await emit(supa, "scheduler.skipped_in_progress", null, { worker_type, runtime, lease_reason: leaseRes.reason });
    return { action: "skipped_in_progress", historyId: h?.id as string | undefined };
  }
  const leaseId = leaseRes.leaseId;
  await emit(supa, "scheduler.triggered", null, { worker_type, runtime, trigger_source: "run_now" });
  const map = resolveRuntimeStarters();
  const starter = (await import("@ostra/shared")).findStarter(map, runtime, provider);
  const fallbackStarter = !starter && runtime === "colab"
    ? (worker_type === "voice" ? new ColabVoiceRuntimeStarter() : new ColabImageRuntimeStarter())
    : starter;
  const effectiveStarter = fallbackStarter ?? starter;
  if (!effectiveStarter) {
    await relLease(supa, leaseId);
    const h = await insertHistory(supa, {
      schedule_id: null, worker_type, runtime, provider,
      trigger_source: "run_now", startup_request_id: `req:${Date.now().toString(36)}`,
      provider_run_id: null, provider_response: null,
      result: "not_autostartable", status: "CANCELLED", error: `No starter for ${runtime}:${provider}`, error_code: "NOT_AUTOSTARTABLE",
    });
    return { action: "not_autostartable", historyId: h?.id as string | undefined };
  }
  const fakeRequestId = `req:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,7)}`;
  const outcome = await effectiveStarter.start({ worker_type, runtime, provider, trigger_source: "run_now", config: fake });
  if (!outcome.ok) {
    const code = outcome.code ?? "UNKNOWN";
    const result: string = code === "NOT_AUTOSTARTABLE" ? "not_autostartable" : "failed";
    const status = code === "NOT_AUTOSTARTABLE" ? "CANCELLED" : "FAILED";
    const h = await insertHistory(supa, {
      schedule_id: null, worker_type, runtime, provider,
      trigger_source: "run_now", startup_request_id: fakeRequestId,
      provider_run_id: null, provider_response: redactSecrets(outcome.provider_response) as Record<string,unknown>,
      result: result as never, status: status as never, error: outcome.error, error_code: code,
    });
    await emit(supa, code === "NOT_AUTOSTARTABLE" ? "scheduler.skipped_not_autostartable" : "scheduler.start_failed", null, { worker_type, runtime, code, error: outcome.error });
    await relLease(supa, leaseId);
    return { action: result, historyId: h?.id as string | undefined, error: outcome.error };
  }
  const realId = outcome.startup_request_id ?? fakeRequestId;
  const h = await insertHistory(supa, {
    schedule_id: null, worker_type, runtime, provider,
    trigger_source: "run_now", startup_request_id: realId,
    provider_run_id: outcome.provider_run_id ?? null,
    provider_response: redactSecrets(outcome.provider_response) as Record<string,unknown>,
    result: "requested", status: "REQUESTED", error: null, error_code: null, started_at: new Date().toISOString(),
  });
  await emit(supa, "scheduler.start_requested", null, { worker_type, runtime, startup_request_id: realId, provider_run_id: outcome.provider_run_id ?? null });
  await insertHistory(supa, {
    schedule_id: null, worker_type, runtime, provider,
    trigger_source: "run_now", startup_request_id: realId,
    provider_run_id: outcome.provider_run_id ?? null, provider_response: null,
    result: "starting", status: "STARTING", error: null, error_code: null, started_at: new Date().toISOString(),
  });
  await relLease(supa, leaseId);
  return { action: "requested", historyId: h?.id as string | undefined };
}
