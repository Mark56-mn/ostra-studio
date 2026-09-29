// packages/shared/src/providers/models.ts
// The catalog of AI models/providers the operator can switch on and off, plus the pure rule that
// turns (enabled, real health) into a dispatch state.
//
// Truth rules this file exists to protect:
//  - A toggle changes INTENT (may the orchestrator use this model?), never observed reality.
//    A disabled model is never reported as ONLINE and is never reported as OFFLINE either.
//  - `health` always stays the real, derived health (see ./health.ts). Disabling hides nothing.
//  - Only `enabled === true` AND `health.status === "ONLINE"` can be dispatched to.

import type { ProviderHealth } from "./contracts";
import type { ProviderId } from "./health";

/** One switchable AI model/provider. `key` is URL-safe and stable (used as the API path segment). */
export type ModelCatalogEntry = {
  /** Stable, URL-safe identifier: `<providerId>-<modelRef>` (matches ^[a-z0-9-]{2,120}$). */
  key: string;
  /** The owning provider slot in the registry (script / image / voice / video / youtube). */
  providerId: ProviderId;
  /** The concrete model/provider adapter behind the slot, e.g. `qwen3-1-7b`, `ffmpeg`. */
  modelRef: string;
  /** Human label for the control room. */
  label: string;
  /** Non-secret operational description: where it runs and what it produces. */
  description: string;
  /** Provider label as reported by provider health (e.g. `kaggle`, `colab-image`, `ffmpeg`). */
  provider: string;
  /** Runtime that hosts it (e.g. `kaggle`, `colab`, `local`, `api`). */
  runtime: string;
};

/**
 * Which models exist right now. This mirrors the real provider definitions in
 * apps/api/src/lib/providerHealth.ts — the health, never this list, decides ONLINE.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    key: "script-qwen3-1-7b",
    providerId: "script",
    modelRef: "qwen3-1-7b",
    label: "Script AI · Qwen3 1.7B",
    description: "Story development, scripts, scene breakdowns and narration text.",
    provider: "kaggle",
    runtime: "kaggle",
  },
  {
    key: "image-colab-image",
    providerId: "image",
    modelRef: "colab-image",
    label: "Image AI · Colab",
    description: "Character, environment and scene artwork plus thumbnails.",
    provider: "colab-image",
    runtime: "colab",
  },
  {
    key: "voice-kokoro-82m",
    providerId: "voice",
    modelRef: "kokoro-82m",
    label: "Voice AI · Kokoro-82M",
    description: "Narration, dialogue and scene audio at segment level.",
    provider: "kokoro-82m",
    runtime: "colab",
  },
  {
    key: "video-ffmpeg",
    providerId: "video",
    modelRef: "ffmpeg",
    label: "Video Engine · FFmpeg",
    description: "Deterministic assembly: images + audio, subtitles, transitions, encode.",
    provider: "ffmpeg",
    runtime: "local",
  },
  {
    key: "youtube-youtube-api",
    providerId: "youtube",
    modelRef: "youtube-api",
    label: "YouTube Publisher",
    description: "Uploads approved videos. Requires OAuth; human approval still gates publishing.",
    provider: "youtube-api",
    runtime: "api",
  },
] as const;

/** Build the canonical key for a provider slot + model ref. Pure, lowercases and hyphenates. */
export function modelKey(providerId: string, modelRef: string): string {
  return `${providerId}-${modelRef}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Look up a catalog entry by its key. Returns null for unknown keys (caller answers 404). */
export function findModel(key: string | null | undefined): ModelCatalogEntry | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  return MODEL_CATALOG.find((m) => m.key === k) ?? null;
}

/** The catalog entry matching a provider slot, or null when the slot is not switchable. */
export function modelForProvider(providerId: string | null | undefined): ModelCatalogEntry | null {
  if (!providerId) return null;
  const id = providerId.trim().toLowerCase();
  return MODEL_CATALOG.find((m) => m.providerId === id) ?? null;
}

/**
 * What the orchestrator will actually do with this model right now.
 *  - DISABLED   → the operator switched it off; dispatch is refused regardless of health.
 *  - READY      → switched on AND a real heartbeat/check says ONLINE.
 *  - NOT_READY  → switched on but the model is not usable yet (real health explains why).
 */
export type ModelDispatchState = "DISABLED" | "READY" | "NOT_READY";

export function modelDispatchState(
  enabled: boolean,
  health: ProviderHealth | null | undefined
): ModelDispatchState {
  if (!enabled) return "DISABLED";
  return health?.status === "ONLINE" ? "READY" : "NOT_READY";
}

/** A model row as returned by GET /api/models — catalog + stored toggle + REAL health. */
export type ModelView = {
  key: string;
  providerId: ProviderId;
  modelRef: string;
  label: string;
  description: string;
  provider: string;
  runtime: string;
  /** The stored operator intent. Defaults to true (models are on until switched off). */
  enabled: boolean;
  /** Derived from `enabled` + real health. Never a substitute for `health`. */
  dispatch: ModelDispatchState;
  /** Real provider health. May be null when the report could not be collected. */
  health: ProviderHealth | null;
  /** Optional operator note persisted with the toggle. */
  note?: string | null;
  /** When the toggle was last changed (null ⇒ never changed, still on by default). */
  updatedAt?: string | null;
  updatedBy?: string | null;
};

/** Validation for the toggle endpoint — keeps the API surface honest about what it accepts. */
export function isModelKey(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[a-z0-9-]{2,120}$/.test(value);
}
