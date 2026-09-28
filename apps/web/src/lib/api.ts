// apps/web — API client
// In production (Vercel) set NEXT_PUBLIC_API_URL to the Render API URL:
//   NEXT_PUBLIC_API_URL=https://ostra-studio-1.onrender.com
// Only NEXT_PUBLIC_* values may be bundled into the browser. No secrets live here.
//
// `apiUrl("/api/health")` must produce `https://ostra-studio-1.onrender.com/api/health`
// (never `/api/api/health`, never a bare `/health` when the caller asked for `/api/health`).

/** Normalized API base: trimmed, trailing slashes removed ("" when unset → same-origin dev shim). */
export function apiBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

/** True when a Render API base is configured for production. */
export function isBackendConfigured(): boolean {
  return apiBase() !== "";
}

export function apiUrl(path: string): string {
  const base = apiBase();
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
}

// Helper to surface 503 hints (Supabase not configured on Render) to the UI
export async function parseApiJson<T>(res: Response): Promise<T & { _error?: string; _hint?: string }> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as T & { error?: string; hint?: string };
    if (!res.ok && (j as { error?: string }).error) {
      return { ...(j as object), _error: (j as { error?: string }).error, _hint: (j as { hint?: string }).hint } as T & { _error?: string; _hint?: string };
    }
    return j as T & { _error?: string; _hint?: string };
  } catch {
    return { _error: `Bad JSON (${res.status}): ${text.slice(0, 400)}` } as T & { _error?: string };
  }
}
