// apps/web/src/lib/health.ts
// Client-side readers for the Render health contract. The dashboard never invents provider state:
// every status here comes from GET /api/health, /api/providers or /api/workers.

import { apiUrl } from "./api";

export type ProviderStatus =
  | "ONLINE"
  | "OFFLINE"
  | "DEGRADED"
  | "NOT_CONFIGURED"
  | "STARTING"
  | "ERROR"
  | "UNKNOWN";

export type ProviderHealth = {
  ok: boolean;
  status: ProviderStatus;
  provider?: string;
  reason?: string;
  latencyMs?: number;
  checkedAt: string;
  lastHeartbeatAt?: string | null;
  heartbeatAgeSec?: number | null;
  detail?: Record<string, unknown>;
};

export type ProviderEntry = {
  id: string;
  provider: string;
  runtime?: string;
  health: ProviderHealth;
};

export type HealthReport = {
  ok: boolean;
  status?: string;
  app?: string;
  host?: string;
  autoPublish?: boolean;
  supabase?: ProviderHealth;
  providers?: Record<string, ProviderEntry>;
  timestamp?: string;
  at?: string;
};

/**
 * Discriminated fetch result: `reachable:false` means the Render API could not be reached at all
 * (network error / non-JSON), which is a DIFFERENT state from "reachable but a provider is down".
 */
export type FetchResult<T> =
  | { reachable: true; data: T; error?: string }
  | { reachable: false; error: string };

export async function fetchHealth(): Promise<FetchResult<HealthReport>> {
  try {
    const res = await fetch(apiUrl("/api/health"), { cache: "no-store" });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!json || typeof json !== "object") {
      return { reachable: false, error: `Unexpected response from Render API (HTTP ${res.status})` };
    }
    const report = json as HealthReport;
    if (!report.app && !report.providers) {
      return { reachable: false, error: `Render API returned an unrecognized health payload (HTTP ${res.status})` };
    }
    return { reachable: true, data: report };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type WorkerRow = {
  id: string;
  type: string;
  provider: string;
  runtime?: string | null;
  model?: string | null;
  status: string;
  endpoint?: string | null;
  last_heartbeat_at?: string | null;
  heartbeat_timeout_sec?: number | null;
  current_task_id?: string | null;
  error?: string | null;
  error_message?: string | null;
  health?: ProviderHealth;
};

export type WorkersResult = { reachable: boolean; workers: WorkerRow[]; error?: string };

export async function fetchWorkers(): Promise<WorkersResult> {
  try {
    const res = await fetch(apiUrl("/api/workers"), { cache: "no-store" });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!json || typeof json !== "object") {
      return { reachable: false, workers: [], error: `Unexpected response from Render API (HTTP ${res.status})` };
    }
    const obj = json as { workers?: WorkerRow[]; error?: string; reason?: string; hint?: string };
    if (!Array.isArray(obj.workers)) {
      return {
        reachable: false,
        workers: [],
        error: obj.reason ?? obj.error ?? `Worker registry unavailable (HTTP ${res.status})`,
      };
    }
    return { reachable: true, workers: obj.workers, error: obj.reason ?? obj.error };
  } catch (e) {
    return { reachable: false, workers: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Presentation helpers (pure) ──────────────────────────────────────────────
export type StatusTone = "ok" | "warn" | "bad" | "info" | "muted";

export function statusTone(status: ProviderStatus | string | undefined): StatusTone {
  switch ((status ?? "UNKNOWN").toUpperCase()) {
    case "ONLINE":
      return "ok";
    case "STARTING":
    case "DEGRADED":
      return "info";
    case "OFFLINE":
    case "ERROR":
      return "bad";
    case "NOT_CONFIGURED":
      return "warn";
    default:
      return "muted";
  }
}

export function statusLabel(status: ProviderStatus | string | undefined): string {
  return (status ?? "UNKNOWN").toUpperCase();
}

export function heartbeatAgeLabel(iso?: string | null, nowMs = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 15) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/** Provider ids in the order the dashboard should display them. */
export const PROVIDER_ORDER = ["script", "image", "voice", "video", "youtube", "storage"] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  script: "Script AI",
  image: "Image AI",
  voice: "Voice AI",
  video: "Video Engine",
  youtube: "YouTube",
  storage: "Storage",
};
