// apps/web/src/lib/runner.ts
// Client for the Runner — one button per AI model that issues a REAL runtime start.
//
// Every button maps to `POST /api/runtime/run-now { worker_type, runtime, provider }`, the same
// orchestrator path the scheduler uses (lease → RuntimeStarter → provider). For the Kaggle/Qwen
// Script AI that call re-pushes the configured notebook (KAGGLE_KERNEL_REF on Render) as a new
// Kaggle version, which makes Kaggle execute the whole notebook — every cell — before a worker can
// tunnel in, register and heartbeat.
//
// Truth rules this file exists to protect:
//  - `requested` means "a start was requested". It is NOT online.
//  - The only sources of state are the API's own answers (`action`, `error`) and the persisted
//    `runtime_startup_history` rows. Nothing here invents RUNNING / ONLINE.
//  - A runtime with no starter answers `not_autostartable`; the UI says exactly that.
//  - Nothing secret is read here: only NEXT_PUBLIC_* is browser-visible (see ./api).

import { apiUrl } from "./api";

export type RunNowTarget = { worker_type: string; runtime: string; provider: string };

/**
 * Discriminated result: `reachable:false` means the API did not answer with an action at all
 * (network failure, non-JSON, or the endpoint missing on the deployed build) — a different state
 * from "the API answered and refused the start".
 */
export type RunNowResult =
  | { reachable: true; httpStatus: number; action: string; historyId?: string; error?: string }
  | { reachable: false; error: string };

export async function runModelNow(target: RunNowTarget): Promise<RunNowResult> {
  try {
    const res = await fetch(apiUrl("/api/runtime/run-now"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target),
      cache: "no-store",
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const obj = (json && typeof json === "object" ? json : {}) as {
      action?: string;
      historyId?: string;
      error?: string;
    };
    if (!obj.action) {
      const missing = res.status === 404 ? " — the run-now endpoint is missing on the deployed API" : "";
      return {
        reachable: false,
        error: `${obj.error ?? "Run Now returned an unrecognized response"}${missing} (HTTP ${res.status})`,
      };
    }
    return {
      reachable: true,
      httpStatus: res.status,
      action: obj.action,
      historyId: obj.historyId,
      error: obj.error,
    };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One `runtime_startup_history` row — the persisted record of a real start attempt. */
export type RunnerHistoryRow = {
  id: string;
  schedule_id?: string | null;
  worker_type: string;
  runtime: string;
  provider: string;
  trigger_source: string;
  result: string;
  status?: string | null;
  error?: string | null;
  error_code?: string | null;
  provider_run_id?: string | null;
  startup_request_id?: string | null;
  requested_at: string;
  started_at?: string | null;
  registered_at?: string | null;
  completed_at?: string | null;
  worker_id?: string | null;
};

export type RunnerHistoryResult = { reachable: boolean; rows: RunnerHistoryRow[]; error?: string };

export async function fetchRunHistory(limit = 40): Promise<RunnerHistoryResult> {
  try {
    const res = await fetch(apiUrl(`/api/runtime/history?limit=${limit}`), { cache: "no-store" });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const obj = (json && typeof json === "object" ? json : {}) as {
      history?: RunnerHistoryRow[];
      error?: string;
    };
    if (!Array.isArray(obj.history)) {
      return {
        reachable: false,
        rows: [],
        error: obj.error ?? `Startup history unavailable (HTTP ${res.status})`,
      };
    }
    return { reachable: true, rows: obj.history };
  } catch (e) {
    return { reachable: false, rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Pure helpers (no React, no fetch) ────────────────────────────────────────
export type RunTone = "ok" | "info" | "warn" | "bad" | "muted";

/** Join a model to its history rows. Both halves are stored on every row, so this is stable. */
export function targetKey(workerType: string, runtime: string): string {
  return `${workerType}/${runtime}`;
}

/** Newest row per (worker_type, runtime). Rows arrive newest-first; timestamps break any tie. */
export function latestByTarget(rows: readonly RunnerHistoryRow[]): Record<string, RunnerHistoryRow> {
  const out: Record<string, RunnerHistoryRow> = {};
  for (const row of rows) {
    const key = targetKey(row.worker_type, row.runtime);
    const seen = out[key];
    if (!seen) {
      out[key] = row;
      continue;
    }
    const a = new Date(row.requested_at).getTime();
    const b = new Date(seen.requested_at).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && a > b) out[key] = row;
  }
  return out;
}

const ACTION_LABEL: Record<string, string> = {
  requested: "START REQUESTED",
  skipped_already_online: "ALREADY ONLINE",
  skipped_disabled: "SWITCHED OFF",
  skipped_cooldown: "COOLDOWN",
  skipped_in_progress: "START IN PROGRESS",
  not_autostartable: "NOT AUTOSTARTABLE",
  max_attempts: "MAX ATTEMPTS",
  failed: "FAILED",
};

const ACTION_TONE: Record<string, RunTone> = {
  requested: "info", // a request, not a live worker
  skipped_already_online: "ok",
  skipped_disabled: "warn",
  skipped_cooldown: "warn",
  skipped_in_progress: "warn",
  not_autostartable: "muted",
  max_attempts: "bad",
  failed: "bad",
};

const STATUS_TONE: Record<string, RunTone> = {
  REQUESTED: "info",
  STARTING: "info",
  REGISTERING: "info",
  ONLINE: "ok",
  CANCELLED: "warn",
  TIMEOUT: "bad",
  FAILED: "bad",
};

/** Human label for the action the API returned. Unknown actions are echoed, never guessed. */
export function runActionLabel(action?: string | null): string {
  const a = (action ?? "").trim();
  if (!a) return "NO ACTION";
  return ACTION_LABEL[a] ?? a.replace(/[_-]+/g, " ").toUpperCase();
}

export function runActionTone(action?: string | null): RunTone {
  const a = (action ?? "").trim();
  return ACTION_TONE[a] ?? "muted";
}

/**
 * Tone for a history row. A skip is reported as the skip it was (a switched-off model is not a
 * failure, and "already online" is a good sign), and only an explicit ONLINE row is `ok`.
 */
export function runRowTone(row?: RunnerHistoryRow | null): RunTone {
  if (!row) return "muted";
  const result = (row.result ?? "").toLowerCase();
  if (result === "not_autostartable") return "muted";
  if (result.startsWith("skipped")) return runActionTone(result);
  const status = (row.status ?? "").toUpperCase();
  if (STATUS_TONE[status]) return STATUS_TONE[status];
  return runActionTone(result);
}

/** What to print on the lifecycle pill: the persisted status when there is one, else the result. */
export function runRowLabel(row?: RunnerHistoryRow | null): string {
  if (!row) return "NO RUNS YET";
  const result = (row.result ?? "").toLowerCase();
  if (result === "not_autostartable") return "NOT AUTOSTARTABLE";
  if (result.startsWith("skipped")) return runActionLabel(result);
  return (row.status ?? row.result ?? "UNKNOWN").toUpperCase();
}

/** Truthful one-liner for the API's answer to a button press. */
export function runResultSentence(r: {
  httpStatus: number;
  action: string;
  error?: string;
}): string {
  const base = (() => {
    switch (r.action) {
      case "requested":
        return `Start requested (HTTP ${r.httpStatus}). The runtime is starting — it is not ONLINE until a worker registers and heartbeats.`;
      case "skipped_already_online":
        return "Not started: a healthy worker is already online for this model, so the start was skipped (no duplicate run).";
      case "skipped_disabled":
        return "Refused: this model is switched off in the Models control room. Nothing was started.";
      case "skipped_cooldown":
        return "Not started: still inside the cooldown window since the last attempt.";
      case "skipped_in_progress":
        return "Not started: a start is already in progress (lease held). Check the run history below.";
      case "not_autostartable":
        return "Not started: this runtime has no start path wired up, so the orchestrator answered not_autostartable.";
      case "max_attempts":
        return "Not started: the maximum number of start attempts in 24h was already reached.";
      case "failed":
        return "The start request failed. The reason is recorded in runtime_startup_history.";
      default:
        return `The API answered "${r.action}".`;
    }
  })();
  return r.error ? `${base} — ${r.error}` : base;
}

/**
 * Which runtime family a model belongs to for starting purposes. `kaggle` and `colab` have starters
 * registered on the API; anything else (`local`, `api`) has none, so Run Now answers
 * `not_autostartable`. Derived from the real starter registry, not from a wish list.
 */
export function remoteStartKind(runtime: string): "kaggle" | "colab" | "none" {
  const r = (runtime ?? "").trim().toLowerCase();
  if (r === "kaggle") return "kaggle";
  if (r === "colab") return "colab";
  return "none";
}

export function isRemotelyStartable(runtime: string): boolean {
  return remoteStartKind(runtime) !== "none";
}

/** Tailwind pill classes per tone — same vocabulary as the rest of the dashboard. */
export const RUN_TONE_PILL: Record<RunTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  bad: "bg-red-500/15 text-red-300 border-red-500/30",
  muted: "bg-white/[0.06] text-zinc-300 border-white/10",
};
