import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkSupabaseHealth,
  colabConfig,
  deriveProviderHealth,
  getServerSupabase,
  kaggleConfig,
  summarizeHealth,
  type ProviderHealth,
  type ProviderId,
  type StartupAttemptRow,
  type WorkerHealthRow,
} from "@ostra/shared";

/** One provider entry in the health report: stable id + display provider + truthful health. */
export type ProviderHealthEntry = {
  id: ProviderId;
  provider: string;
  runtime?: string;
  health: ProviderHealth;
};

export type OverallStatus = "ONLINE" | "DEGRADED" | "ERROR";

export type HealthReport = {
  ok: boolean;
  status: OverallStatus;
  app: string;
  host: string;
  autoPublish: boolean;
  supabase: ProviderHealth;
  providers: Record<string, ProviderHealthEntry>;
  timestamp: string;
  /** @deprecated alias of `timestamp` kept for older clients. */
  at: string;
};

type AttemptRow = StartupAttemptRow & { worker_type?: string | null; runtime?: string | null };

const WORKER_COLUMNS =
  "id,type,runtime,provider,worker_id,status,endpoint,model,last_heartbeat_at,heartbeat_timeout_sec,error,error_code,error_message";

// Bounded queries only — a slow/dead database must not hang /api/health.
async function loadWorkers(supa: SupabaseClient | null): Promise<WorkerHealthRow[]> {
  if (!supa) return [];
  try {
    const { data, error } = await supa.from("workers").select(WORKER_COLUMNS);
    if (error || !data) return [];
    return data as WorkerHealthRow[];
  } catch {
    return [];
  }
}

async function loadAttempts(supa: SupabaseClient | null): Promise<AttemptRow[]> {
  if (!supa) return [];
  try {
    const { data, error } = await supa
      .from("runtime_startup_history")
      .select(
        "worker_type,runtime,result,status,error,error_code,requested_at,startup_request_id,provider_run_id"
      )
      .order("requested_at", { ascending: false })
      .limit(50);
    if (error || !data) return [];
    return data as AttemptRow[];
  } catch {
    return [];
  }
}

const LIVE_STATUSES = ["ONLINE", "IDLE", "WORKING", "QUEUED", "WAITING"];
const FAILED_STATUSES = ["FAILED", "RETRYING"];

/** Prefer a live, freshly-heartbeating worker over a stale/failed row for the same type+runtime. */
function pickWorker(
  workers: WorkerHealthRow[],
  type: string,
  runtime: string
): WorkerHealthRow | null {
  const candidates = workers.filter((w) => w.type === type && (runtime ? w.runtime === runtime : true));
  if (candidates.length === 0) return null;
  const rank = (w: WorkerHealthRow) => {
    const s = (w.status ?? "").toUpperCase();
    if (LIVE_STATUSES.includes(s)) return 0;
    if (FAILED_STATUSES.includes(s)) return 2;
    return 1;
  };
  return candidates
    .slice()
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ta = a.last_heartbeat_at ? new Date(a.last_heartbeat_at).getTime() : 0;
      const tb = b.last_heartbeat_at ? new Date(b.last_heartbeat_at).getTime() : 0;
      return tb - ta;
    })[0]!;
}

/** Attempts arrive newest-first, so the first match per (type, runtime) is the latest. */
function latestAttempt(attempts: AttemptRow[], type: string, runtime: string): AttemptRow | null {
  return attempts.find((a) => a.worker_type === type && a.runtime === runtime) ?? null;
}

type ProviderDef = {
  id: ProviderId;
  type: string;
  runtime: string;
  provider: string;
  configured: boolean;
  configReason?: string;
  extraDetail?: Record<string, unknown>;
};

function providerDefinitions(): ProviderDef[] {
  const kaggle = kaggleConfig();
  const image = colabConfig("image");
  const voice = colabConfig("voice");
  return [
    {
      id: "script",
      type: "script",
      runtime: "kaggle",
      provider: "kaggle",
      configured: kaggle.configured,
      configReason: kaggle.reason,
      extraDetail: { kernelRef: kaggle.kernelRef ?? null },
    },
    {
      id: "image",
      type: "image",
      runtime: "colab",
      provider: "colab-image",
      configured: image.configured,
      configReason: image.reason,
    },
    {
      id: "voice",
      type: "voice",
      runtime: "colab",
      provider: "kokoro-82m",
      configured: voice.configured,
      configReason: voice.reason,
    },
    {
      id: "video",
      type: "video",
      runtime: "local",
      provider: "ffmpeg",
      configured: false,
      configReason: "Video rendering (FFmpeg) is not deployed yet",
    },
    {
      id: "youtube",
      type: "youtube",
      runtime: "api",
      provider: "youtube-api",
      configured: false,
      configReason: "YouTube OAuth is not configured",
    },
  ];
}

async function collectAll(supa: SupabaseClient | null): Promise<{
  providers: Record<string, ProviderHealthEntry>;
  supabase: ProviderHealth;
}> {
  const [workers, attempts, supabaseHealth] = await Promise.all([
    loadWorkers(supa),
    loadAttempts(supa),
    checkSupabaseHealth(supa),
  ]);

  const providers: Record<string, ProviderHealthEntry> = {};
  for (const def of providerDefinitions()) {
    const health = deriveProviderHealth({
      id: def.id,
      provider: def.provider,
      configured: def.configured,
      configReason: def.configReason,
      worker: pickWorker(workers, def.type, def.runtime),
      attempt: latestAttempt(attempts, def.type, def.runtime),
    });
    providers[def.id] = {
      id: def.id,
      provider: def.provider,
      runtime: def.runtime,
      health: def.extraDetail ? { ...health, detail: { ...(health.detail ?? {}), ...def.extraDetail } } : health,
    };
  }

  // Storage health is the real Supabase check (DB + Storage share the same project/credentials).
  providers.storage = {
    id: "storage",
    provider: "supabase-storage",
    runtime: "supabase",
    health: { ...supabaseHealth, provider: "supabase-storage" },
  };

  return { providers, supabase: supabaseHealth };
}

export async function collectProviderHealth(): Promise<Record<string, ProviderHealthEntry>> {
  const { providers } = await collectAll(getServerSupabase());
  return providers;
}

export async function collectProvidersFlat(): Promise<Record<string, ProviderHealthEntry>> {
  return collectProviderHealth();
}

export async function buildHealthReport(): Promise<HealthReport> {
  const { providers, supabase } = await collectAll(getServerSupabase());
  const overall = summarizeHealth(
    supabase,
    Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.health]))
  );
  const timestamp = new Date().toISOString();
  return {
    ok: overall.ok,
    status: overall.status,
    app: "ostra-api",
    host: process.env.OSTRA_HOST ?? "render",
    autoPublish: process.env.AUTO_PUBLISH === "true",
    supabase,
    providers,
    timestamp,
    at: timestamp,
  };
}
