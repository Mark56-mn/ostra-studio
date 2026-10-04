// apps/web/src/lib/models.ts
// Client for the model switches (GET /api/models, PATCH /api/models/:key).
// The dashboard never guesses switch state: `enabled` and `health` both come from the Render API.

import { apiUrl } from "./api";
import type { ProviderHealth } from "./health";

/** Mirrors `ModelDispatchState` in @ostra/shared — the derived "will it be used?" answer. */
export type ModelDispatchState = "DISABLED" | "READY" | "NOT_READY";

export type ModelView = {
  key: string;
  providerId: string;
  modelRef: string;
  label: string;
  description: string;
  provider: string;
  runtime: string;
  /** Operator intent, persisted in Supabase `model_controls`. Default true. */
  enabled: boolean;
  /** Derived from `enabled` + real health. Never a substitute for `health`. */
  dispatch: ModelDispatchState;
  /** Real provider health. Null when the report could not be collected. */
  health: ProviderHealth | null;
  /** The model the live worker reported (e.g. "Qwen/Qwen3-4B"). Null ⇒ never observed. */
  liveModel?: string | null;
  note?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

export type ModelCounts = { total: number; enabled: number; disabled: number; ready: number };

export type ModelsResult = {
  reachable: boolean;
  models: ModelView[];
  counts?: ModelCounts;
  error?: string;
};

export async function fetchModels(): Promise<ModelsResult> {
  try {
    const res = await fetch(apiUrl("/api/models"), { cache: "no-store" });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!json || typeof json !== "object") {
      return { reachable: false, models: [], error: `Unexpected response from Render API (HTTP ${res.status})` };
    }
    const obj = json as { models?: ModelView[]; counts?: ModelCounts; error?: string; reason?: string };
    if (!Array.isArray(obj.models)) {
      return {
        reachable: false,
        models: [],
        error: obj.reason ?? obj.error ?? `Model switches unavailable (HTTP ${res.status})`,
      };
    }
    return { reachable: true, models: obj.models, counts: obj.counts, error: obj.reason ?? obj.error };
  } catch (e) {
    return { reachable: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setModelEnabled(
  key: string,
  enabled: boolean,
  note?: string
): Promise<{ ok: boolean; model?: ModelView; error?: string }> {
  try {
    const res = await fetch(apiUrl(`/api/models/${encodeURIComponent(key)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, ...(note ? { note } : {}) }),
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : null) as { model?: ModelView; error?: string } | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
    return { ok: true, model: json?.model ?? undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Tailwind classes per dispatch state — DISABLED is deliberately distinct from OFFLINE/ERROR. */
export const DISPATCH_STYLE: Record<ModelDispatchState, { pill: string; dot: string }> = {
  READY: { pill: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400" },
  NOT_READY: { pill: "bg-amber-500/15 text-amber-300 border-amber-500/30", dot: "bg-amber-400" },
  DISABLED: { pill: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30", dot: "bg-zinc-500" },
};

export function dispatchLabel(state: ModelDispatchState): string {
  if (state === "READY") return "DISPATCHING";
  if (state === "DISABLED") return "SWITCHED OFF";
  return "NOT READY";
}
