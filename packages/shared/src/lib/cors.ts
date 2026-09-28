// Shared CORS origin policy (pure + testable).
// The API never uses `Access-Control-Allow-Origin: *` — worker registration and heartbeat
// endpoints are token-protected and must not be usable from arbitrary origins.

/** Production frontend origin. Always allowed, even if CORS_ORIGINS is customized. */
export const DEFAULT_ALLOWED_ORIGINS = ["https://ostra-studio-web.vercel.app"];

const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/i;
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function parseAllowedOrigins(raw?: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the effective allowlist: explicit configuration (CORS_ORIGINS / WEB_ORIGIN) plus the
 * production default. `*` is deliberately unsupported.
 */
export function resolveAllowedOrigins(env: { CORS_ORIGINS?: string; WEB_ORIGIN?: string } = {}): string[] {
  const explicit = [...parseAllowedOrigins(env.CORS_ORIGINS), ...parseAllowedOrigins(env.WEB_ORIGIN)].filter(
    (o) => o !== "*"
  );
  return [...new Set([...explicit, ...DEFAULT_ALLOWED_ORIGINS])];
}

export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  // Non-browser callers (curl, server-to-server, Render cron) send no Origin.
  if (!origin) return true;
  if (allowed.includes("*")) return false;
  if (allowed.includes(origin)) return true;
  // Vercel preview deployments of the frontend.
  if (allowed.some((a) => a.endsWith("vercel.app")) && VERCEL_PREVIEW_RE.test(origin)) return true;
  // Local development on any port.
  if (LOCALHOST_RE.test(origin)) return true;
  return false;
}
