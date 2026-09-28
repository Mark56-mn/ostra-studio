import type { Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkSupabaseHealth,
  getServerSupabase as createServerSupabase,
  isSupabaseConfigured as sharedIsSupabaseConfigured,
  supabaseConfigReason as sharedSupabaseConfigReason,
  supabaseServerKey,
  supabaseServerUrl,
} from "@ostra/shared";

/** Server-side Supabase URL, honoring SUPABASE_URL / SUPABASE_CONNECTION_STRING / NEXT_PUBLIC_SUPABASE_URL. */
export function getSupabaseUrl(): string | undefined {
  return supabaseServerUrl();
}

/** Server-side Supabase key (prefers SUPABASE_SERVICE_ROLE_KEY). Never logged or returned. */
export function getSupabaseServiceKey(): string | undefined {
  return supabaseServerKey();
}

export function getServerSupabase(): SupabaseClient | null {
  return createServerSupabase();
}

export function isSupabaseConfigured(): boolean {
  return sharedIsSupabaseConfigured();
}

/** Real, lightweight check — never "configured = healthy". */
export function checkSupabase(client?: SupabaseClient | null, timeoutMs?: number) {
  return checkSupabaseHealth(client, timeoutMs);
}

/** Human-readable, secret-free description of the missing Supabase config (if any). */
export function supabaseConfigReason(): string | undefined {
  return sharedSupabaseConfigReason();
}

export function requireSupabase(res: Response): SupabaseClient | null {
  const c = getServerSupabase();
  if (!c) {
    res.status(503).json({
      error: "Supabase not configured",
      reason: sharedSupabaseConfigReason() ?? "Supabase is not configured on the backend",
      hint:
        "Set SUPABASE_URL (or SUPABASE_CONNECTION_STRING / NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY on Render. Run supabase/migrations/001_initial.sql in the Supabase SQL editor.",
    });
    return null;
  }
  return c;
}
