// packages/shared/src/providers/health.ts
// Single source of truth for provider status derivation. Pure + testable (no I/O).
//
// Rules that must never be broken:
//  - ONLINE requires a fresh, real heartbeat (or a real, successful check) — never mere configuration.
//  - Configuration present but nothing running  => OFFLINE (or STARTING while a start is in flight).
//  - No configuration                              => NOT_CONFIGURED (with the exact missing keys).
//  - Provider/push failures                        => ERROR (with the real reason).
//  - Unknown/indeterminate                         => UNKNOWN.

import type { ProviderHealth, ProviderStatus } from "./contracts";
import { isHeartbeatStale } from "../orchestrator/state";

// One id per real capability slot. `overseer` (the Showrunner) is a first-class slot: it registers its
// own worker row, so it needs its own health entry — otherwise a live Showrunner is invisible here.
export const PROVIDER_IDS = ["script", "image", "voice", "overseer", "video", "youtube", "storage"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The one and only status that means "this provider is actually usable right now". */
export function statusOk(status: ProviderStatus): boolean {
  return status === "ONLINE";
}

export function makeHealth(
  status: ProviderStatus,
  opts: {
    provider?: string;
    reason?: string;
    latencyMs?: number;
    checkedAt?: string;
    lastHeartbeatAt?: string | null;
    heartbeatAgeSec?: number | null;
    detail?: Record<string, unknown>;
  } = {}
): ProviderHealth {
  const h: ProviderHealth = {
    ok: statusOk(status),
    status,
    checkedAt: opts.checkedAt ?? new Date().toISOString(),
  };
  if (opts.provider) h.provider = opts.provider;
  if (opts.reason) h.reason = opts.reason;
  if (opts.latencyMs != null) h.latencyMs = opts.latencyMs;
  if (opts.lastHeartbeatAt !== undefined) h.lastHeartbeatAt = opts.lastHeartbeatAt;
  if (opts.heartbeatAgeSec !== undefined) h.heartbeatAgeSec = opts.heartbeatAgeSec;
  if (opts.detail && Object.keys(opts.detail).length > 0) h.detail = opts.detail;
  return h;
}

// ── Worker rows ──────────────────────────────────────────────────────────────
export type WorkerHealthRow = {
  id?: string;
  type?: string;
  runtime?: string;
  provider?: string;
  worker_id?: string | null;
  status?: string | null;
  endpoint?: string | null;
  model?: string | null;
  last_heartbeat_at?: string | null;
  heartbeat_timeout_sec?: number | null;
  error?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

/** Statuses that mean "the worker says it is alive". Anything else needs heartbeat evidence. */
const LIVE_WORKER_STATUSES = ["ONLINE", "IDLE", "WORKING", "QUEUED", "WAITING"];

export function workerHeartbeatAgeSec(row: WorkerHealthRow, nowMs = Date.now()): number | null {
  if (!row.last_heartbeat_at) return null;
  const t = new Date(row.last_heartbeat_at).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

export function workerHeartbeatTimeoutSec(row: WorkerHealthRow): number {
  const t = row.heartbeat_timeout_sec;
  return typeof t === "number" && t > 0 ? t : 90;
}

/**
 * Truthful health for a single worker row, derived only from heartbeat freshness.
 * A row existing is NOT enough — the heartbeat must be fresh.
 */
export function workerDisplayHealth(row: WorkerHealthRow, nowMs = Date.now()): ProviderHealth {
  const status = (row.status ?? "").toUpperCase();
  const ageSec = workerHeartbeatAgeSec(row, nowMs);
  const timeoutSec = workerHeartbeatTimeoutSec(row);
  const base = {
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    heartbeatAgeSec: ageSec,
    detail: {
      workerId: row.id,
      workerSlug: row.worker_id ?? undefined,
      runtime: row.runtime ?? undefined,
      provider: row.provider ?? undefined,
      // The model the worker itself reported (e.g. "Qwen/Qwen3-4B"). Never assumed from config.
      model: row.model ?? undefined,
      workerStatus: status || undefined,
      endpointHost: hostOf(row.endpoint),
      heartbeatTimeoutSec: timeoutSec,
    } as Record<string, unknown>,
  };

  if (status === "FAILED" || status === "RETRYING") {
    return makeHealth("ERROR", { ...base, reason: row.error_message ?? row.error ?? `worker status ${status}` });
  }
  if (!LIVE_WORKER_STATUSES.includes(status)) {
    return makeHealth("OFFLINE", { ...base, reason: `worker status ${status || "unknown"}` });
  }
  if (isHeartbeatStale(row.last_heartbeat_at, nowMs, timeoutSec * 1000)) {
    const age = ageSec == null ? "no heartbeat" : `last heartbeat ${ageSec}s ago`;
    return makeHealth("OFFLINE", { ...base, reason: `heartbeat expired — ${age} (timeout ${timeoutSec}s)` });
  }
  return makeHealth("ONLINE", {
    ...base,
    reason: row.endpoint ? `heartbeat fresh — worker reachable` : `heartbeat fresh`,
  });
}

function hostOf(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

// ── Startup attempts (runtime_startup_history) ───────────────────────────────
export type StartupAttemptRow = {
  result?: string | null;
  status?: string | null;
  error?: string | null;
  error_code?: string | null;
  requested_at?: string | null;
  startup_request_id?: string | null;
  provider_run_id?: string | null;
};

const IN_PROGRESS_RESULTS = ["pending", "requested", "starting", "registering"];
/** A start that has not progressed in this long is no longer "starting" — it is just not running. */
export const STARTING_WINDOW_MS = 20 * 60 * 1000;

export function attemptAgeMs(attempt: StartupAttemptRow | null | undefined, nowMs = Date.now()): number | null {
  if (!attempt?.requested_at) return null;
  const t = new Date(attempt.requested_at).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, nowMs - t);
}

export function isRecentStartupInProgress(attempt: StartupAttemptRow | null | undefined, nowMs = Date.now()): boolean {
  if (!attempt?.result || !IN_PROGRESS_RESULTS.includes(attempt.result)) return false;
  const age = attemptAgeMs(attempt, nowMs);
  return age != null && age <= STARTING_WINDOW_MS;
}

// ── Provider derivation ──────────────────────────────────────────────────────
export type DeriveProviderInput = {
  id: ProviderId;
  /** Provider label shown in the UI (e.g. "kaggle", "colab-image", "supabase"). */
  provider: string;
  /** Is the minimum configuration present? Presence alone NEVER yields ONLINE. */
  configured: boolean;
  /** Exact reason when not configured (names the missing keys). */
  configReason?: string;
  /** The most relevant worker row for this provider/runtime, if any. */
  worker?: WorkerHealthRow | null;
  /** The most recent startup attempt for this provider/runtime, if any. */
  attempt?: StartupAttemptRow | null;
  nowMs?: number;
};

/**
 * Derive the truthful status for one provider. Precedence:
 *  1. fresh healthy worker                -> ONLINE
 *  2. recent in-flight startup attempt    -> STARTING
 *  3. existing worker (stale/failed)      -> its truthful OFFLINE/ERROR
 *  4. missing configuration               -> NOT_CONFIGURED
 *  5. last attempt failed / timed out     -> ERROR
 *  6. last attempt not autostartable      -> NOT_CONFIGURED (with the real blocker)
 *  7. configured but idle                 -> OFFLINE
 */
export function deriveProviderHealth(input: DeriveProviderInput): ProviderHealth {
  const now = input.nowMs ?? Date.now();
  const workerHealth = input.worker ? workerDisplayHealth(input.worker, now) : null;

  if (workerHealth?.status === "ONLINE") {
    return { ...workerHealth, ok: true, provider: input.provider };
  }

  if (isRecentStartupInProgress(input.attempt, now)) {
    const ageSec = attemptAgeMs(input.attempt, now);
    const detail: Record<string, unknown> = {
      startupResult: input.attempt?.result ?? undefined,
      startupRequestId: input.attempt?.startup_request_id ?? undefined,
      providerRunId: input.attempt?.provider_run_id ?? undefined,
    };
    return makeHealth("STARTING", {
      provider: input.provider,
      reason: `startup ${input.attempt?.result}${ageSec != null ? ` — requested ${ageSec}s ago` : ""}; worker has not registered yet`,
      detail,
    });
  }

  if (workerHealth) {
    return { ...workerHealth, provider: input.provider };
  }

  if (!input.configured) {
    return makeHealth("NOT_CONFIGURED", {
      provider: input.provider,
      reason: input.configReason ?? `${input.id} provider is not configured`,
    });
  }

  const result = input.attempt?.result ?? null;
  if (result === "failed" || result === "timed_out") {
    return makeHealth("ERROR", {
      provider: input.provider,
      reason: input.attempt?.error ?? `last startup ${result}`,
      detail: {
        errorCode: input.attempt?.error_code ?? undefined,
        startupRequestId: input.attempt?.startup_request_id ?? undefined,
        providerRunId: input.attempt?.provider_run_id ?? undefined,
      },
    });
  }
  if (result === "not_autostartable") {
    return makeHealth("NOT_CONFIGURED", {
      provider: input.provider,
      reason: input.attempt?.error ?? "runtime is not autostartable — no automatic trigger is configured",
    });
  }

  return makeHealth("OFFLINE", {
    provider: input.provider,
    reason: "configured but runtime is not running — use Run Now or wait for the schedule",
  });
}

// ── Overall report ───────────────────────────────────────────────────────────
/**
 * Overall backend status. The backend itself is ONLINE when it can answer AND its
 * persistence layer is ONLINE; otherwise DEGRADED (backend up, dependency down).
 */
export function summarizeHealth(supabase: ProviderHealth, providers: Record<string, ProviderHealth>): {
  ok: boolean;
  status: "ONLINE" | "DEGRADED" | "ERROR";
} {
  const values = Object.values(providers);
  if (supabase.status === "ERROR" || supabase.status === "OFFLINE") {
    return { ok: false, status: "DEGRADED" };
  }
  if (supabase.status === "NOT_CONFIGURED") {
    return { ok: false, status: "DEGRADED" };
  }
  const anyError = values.some((p) => p.status === "ERROR");
  if (anyError) return { ok: false, status: "DEGRADED" };
  return { ok: true, status: "ONLINE" };
}
