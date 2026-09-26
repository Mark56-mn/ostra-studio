import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function getSupabaseUrl(): string | undefined {
  return (
    process.env.SUPABASE_URL ??
    process.env.SUPABASE_CONNECTION_STRING ??
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}
function getSupabaseServiceKey(): string | undefined {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function getServerSupabase(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const key = getSupabaseServiceKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export function requireSupabase(res: import("express").Response): SupabaseClient | null {
  const c = getServerSupabase();
  if (!c) {
    res.status(503).json({
      error: "Supabase not configured",
      hint: "Set SUPABASE_URL (or SUPABASE_CONNECTION_STRING / NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY on Render. Run supabase/migrations/001_initial.sql in Supabase SQL editor.",
    });
    return null;
  }
  return c;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getSupabaseServiceKey());
}
