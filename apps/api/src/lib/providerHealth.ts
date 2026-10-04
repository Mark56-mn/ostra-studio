import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkSupabaseHealth,
  colabConfig,
  deriveProviderHealth,
  getServerSupabase,
  kaggleApiTokens,
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

/**
 * Prefer a live, freshly-heartbeating worker over a stale/failed row for the same type+runtime.
 *
 * `runtimes` empty means "whatever runtime this agent actually registered on". That matters because
 * an agent notebook is a real worker row wherever it runs: pinning a slot to one runtime (e.g. image
 * => "colab") makes a live Kaggle Image worker invisible and reports NOT_CONFIGURED for a runtime
 * that was never the production plan.
 */
export function pickWorker(
  workers: WorkerHealthRow[],
  type: string,
  runtimes: string[]
): WorkerHealthRow | null {
  const candidates = workers.filter(
    (w) => w.type === type && (runtimes.length === 0 || runtimes.includes(w.runtime ?? ""))
  );
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
function latestAttempt(attempts: AttemptRow[], type: string, runtimes: string[]): AttemptRow | null {
  return (
    attempts.find(
      (a) =>
        a.worker_type === type &&
        (runtimes.length === 0 || runtimes.includes(a.runtime ?? ""))
    ) ?? null
  );
}

export type ProviderDef = {
  id: ProviderId;
  /** The `workers.type` that serves this slot. */
  type: string;
  /** Runtimes that may serve it. Empty ⇒ accept the runtime the worker actually registered on. */
  runtimes: string[];
  /** Provider label used until a real worker row reports its own. */
  provider: string;
  configured: boolean;
  configReason?: string;
  extraDetail?: Record<string, unknown>;
};

/**
 * The four AI agent slots (script / image / voice / overseer) are hosted as Kaggle notebooks in
 * production, with Colab kept as the alternative runtime. `runtimes: []` makes the health follow the
 * REAL worker row instead of a hard-coded runtime name, so a live agent is reported as live.
 */
function agentSlot(
  id: ProviderId,
  type: string,
  opts: { kaggleConfigured: boolean; kaggleReason: string; altConfigured: boolean; altReason: string; altProvider: string; extraDetail?: Record<string, unknown> }
): ProviderDef {
  const configured = opts.kaggleConfigured || opts.altConfigured;
  const configReason = configured
    ? undefined
    : `${opts.kaggleReason} (Kaggle agent notebook) — or ${opts.altReason}`;
  return {
    id,
    type,
    runtimes: [],
    provider: opts.kaggleConfigured ? "kaggle" : opts.altProvider,
    configured,
    configReason,
    ...(opts.extraDetail ? { extraDetail: opts.extraDetail } : {}),
  };
}

export function providerDefinitions(): ProviderDef[] {
  const kaggle = kaggleConfig();
  const image = colabConfig("image");
  const voice = colabConfig("voice");
  const kaggleReason = kaggle.reason ?? "Set KAGGLE_API_TOKEN on Render";
  // The agent notebooks (image / voice / overseer) are started from their own Kaggle accounts, so a
  // token alone is the configuration signal for them — the script KAGGLE_KERNEL_REF is not.
  const kaggleForAgents = kaggleApiTokens().length > 0;

  return [
    {
      id: "script",
      type: "script",
      runtimes: [],
      provider: "kaggle",
      configured: kaggle.configured,
      configReason: kaggle.reason,
      extraDetail: { kernelRef: kaggle.kernelRef ?? null },
    },
    agentSlot("image", "image", {
      kaggleConfigured: kaggleForAgents,
      kaggleReason,
      altConfigured: image.configured,
      altReason: image.reason ?? "the Colab Image runtime is not configured",
      altProvider: "colab-image",
    }),
    agentSlot("voice", "voice", {
      kaggleConfigured: kaggleForAgents,
      kaggleReason,
      altConfigured: voice.configured,
      altReason: voice.reason ?? "the Colab Voice runtime is not configured",
      altProvider: "kokoro-82m",
    }),
    agentSlot("overseer", "overseer", {
      kaggleConfigured: kaggleForAgents,
      kaggleReason,
      altConfigured: false,
      altReason: "the Showrunner runs on its own Kaggle notebook",
      altProvider: "kaggle",
    }),
    {
      id: "video",
      type: "video",
      runtimes: ["local"],
      provider: "ffmpeg",
      configured: false,
      configReason: "Video rendering (FFmpeg) is not deployed yet",
    },
    {
      id: "youtube",
      type: "youtube",
      runtimes: ["api"],
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
    const worker = pickWorker(workers, def.type, def.runtimes);
    // A real worker row is the only thing that may overrule the planned provider/runtime label.
    const provider = worker?.provider ?? def.provider;
    const runtime = worker?.runtime ?? def.runtimes[0] ?? provider;
    const health = deriveProviderHealth({
      id: def.id,
      provider,
      configured: def.configured,
      configReason: def.configReason,
      worker,
      attempt: latestAttempt(attempts, def.type, def.runtimes),
    });
    providers[def.id] = {
      id: def.id,
      provider,
      runtime,
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
