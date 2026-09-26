import type { SupabaseClient } from "@supabase/supabase-js";

// Acquire a lease iff no unreleased lease exists for (worker_type, runtime) and no unexpired lease exists.
// Uses partial unique index `one_active` as a safety net. Returns the new lease id or null when busy.
export async function tryAcquireLease(
  supa: SupabaseClient,
  args: { worker_type: string; runtime: string; trigger_source: string; schedule_id?: string | null; provider_run_id?: string | null; ttlMinutes: number }
): Promise<{ acquired: true; leaseId: string } | { acquired: false; reason: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.ttlMinutes * 60000).toISOString();

  // First, expire stale leases (released_at null but expires_at <= now) — we don't delete them, we mark released_at
  await supa
    .from("runtime_startup_leases")
    .update({ released_at: now.toISOString() })
    .is("released_at", null)
    .eq("worker_type", args.worker_type)
    .eq("runtime", args.runtime)
    .lte("expires_at", now.toISOString());

  // Check active lease still exists after expiry sweep
  const { data: existing } = await supa
    .from("runtime_startup_leases")
    .select("id, trigger_source, acquired_at, expires_at")
    .eq("worker_type", args.worker_type)
    .eq("runtime", args.runtime)
    .is("released_at", null)
    .maybeSingle();

  if (existing) {
    return { acquired: false, reason: `lease_held_by_${(existing as { trigger_source?: string }).trigger_source ?? "unknown"}` };
  }

  const { data, error } = await supa
    .from("runtime_startup_leases")
    .insert({
      worker_type: args.worker_type,
      runtime: args.runtime,
      trigger_source: args.trigger_source,
      schedule_id: args.schedule_id ?? null,
      provider_run_id: args.provider_run_id ?? null,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error) {
    // Unique violation means someone else won the race between our check and insert
    if (error.message?.includes("duplicate") || error.code === "23505") {
      return { acquired: false, reason: "lease_race" };
    }
    return { acquired: false, reason: error.message };
  }
  return { acquired: true, leaseId: (data as { id: string }).id };
}

export async function releaseLease(supa: SupabaseClient, leaseId: string): Promise<void> {
  await supa.from("runtime_startup_leases").update({ released_at: new Date().toISOString() }).eq("id", leaseId);
}

export async function heartbeatLease(supa: SupabaseClient, leaseId: string, extendMinutes: number): Promise<void> {
  const newExpires = new Date(Date.now() + extendMinutes * 60000).toISOString();
  await supa.from("runtime_startup_leases").update({ expires_at: newExpires }).eq("id", leaseId).is("released_at", null);
}
