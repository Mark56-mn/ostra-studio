import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ProviderHealth } from "../providers/contracts";
import { makeHealth } from "../providers/health";
import { supabaseServerUrl, supabaseServerKey, supabaseServerConfigured, supabaseConfigReason, supabaseUrlSource } from "./env";

let browserClient: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  if (!browserClient) browserClient = createClient(url, key);
  return browserClient;
}

/**
 * Server-side Supabase client. Recognizes SUPABASE_URL, SUPABASE_CONNECTION_STRING and
 * NEXT_PUBLIC_SUPABASE_URL (preferring the service-role key). Returns null when unwired.
 */
export function getServerSupabase(): SupabaseClient | null {
  const url = supabaseServerUrl();
  const key = supabaseServerKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export function isSupabaseConfigured(): boolean {
  return supabaseServerConfigured();
}

function withTimeout<T>(value: PromiseLike<T> | T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(value).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Real, lightweight Supabase health check: performs an authenticated `head` query against the
 * existing `workers` table (no rows transferred, no service-role key exposed).
 *
 * NEVER returns ONLINE merely because configuration exists — the query must actually succeed.
 */
export async function checkSupabaseHealth(
  client?: SupabaseClient | null,
  timeoutMs = 5000
): Promise<ProviderHealth> {
  const c = client === undefined ? getServerSupabase() : client;
  if (!c) {
    return makeHealth("NOT_CONFIGURED", {
      provider: "supabase",
      reason: supabaseConfigReason() ?? "Supabase is not configured on the backend",
    });
  }
  const start = Date.now();
  try {
    const query = c.from("workers").select("id", { head: true, count: "exact" }).limit(1);
    const { error } = await withTimeout(query, timeoutMs, "Supabase health check");
    const latencyMs = Date.now() - start;
    if (error) {
      const code = (error as { code?: string }).code;
      const missingSchema = code === "42P01" || code === "PGRST205" || /does not exist|schema cache/i.test(error.message);
      return makeHealth(missingSchema ? "DEGRADED" : "ERROR", {
        provider: "supabase",
        latencyMs,
        reason: missingSchema
          ? `connected, but the schema is missing — run supabase/migrations (${error.message})`
          : `Supabase query failed: ${error.message}`,
        detail: { code: code ?? null, table: "workers" },
      });
    }
    return makeHealth("ONLINE", {
      provider: "supabase",
      latencyMs,
      reason: `connected via ${supabaseUrlSource() ?? "supabase"}`,
      detail: { urlSource: supabaseUrlSource() ?? null, table: "workers" },
    });
  } catch (e) {
    return makeHealth("OFFLINE", {
      provider: "supabase",
      latencyMs: Date.now() - start,
      reason: `Supabase unreachable: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
