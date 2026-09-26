import type { SupabaseClient } from "@supabase/supabase-js";

export type WorkerHealthRow = {
  id: string;
  type: string;
  runtime: string;
  provider: string;
  status: string;
  endpoint?: string | null;
  last_heartbeat_at?: string | null;
  heartbeat_timeout_sec?: number | null;
  model?: string | null;
  capabilities?: string[] | null;
};

export function isHealthyWorker(w: WorkerHealthRow | null, nowMs = Date.now()): boolean {
  if (!w) return false;
  const s = (w.status ?? "").toUpperCase();
  if (!["ONLINE","IDLE","WORKING","QUEUED","WAITING"].includes(s)) return false;
  const timeoutSec = w.heartbeat_timeout_sec ?? 90;
  if (!w.last_heartbeat_at) return false;
  const ageMs = nowMs - new Date(w.last_heartbeat_at).getTime();
  return ageMs <= timeoutSec * 1000;
}

export async function findWorkerByTypeRuntime(
  supa: SupabaseClient,
  worker_type: string,
  runtime: string
): Promise<WorkerHealthRow | null> {
  // One worker per (type, runtime) — provider may vary (e.g. colab-image vs kokoro on same runtime)
  const { data } = await supa
    .from("workers")
    .select("id, type, runtime, provider, status, endpoint, last_heartbeat_at, heartbeat_timeout_sec, model, capabilities")
    .eq("type", worker_type)
    .eq("runtime", runtime)
    .limit(10);
  if (!data || data.length === 0) return null;
  // Prefer ONLINE/healthy
  const sorted = (data as WorkerHealthRow[]).slice().sort((a,b) => {
    const ha = isHealthyWorker(a) ? 0 : 1;
    const hb = isHealthyWorker(b) ? 0 : 1;
    if (ha !== hb) return ha - hb;
    const ta = a.last_heartbeat_at ? new Date(a.last_heartbeat_at).getTime() : 0;
    const tb = b.last_heartbeat_at ? new Date(b.last_heartbeat_at).getTime() : 0;
    return tb - ta;
  });
  return sorted[0] ?? null;
}
