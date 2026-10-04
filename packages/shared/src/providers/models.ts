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
  /**
   * Runtime that hosts it (e.g. `kaggle`, `colab`, `local`, `api`). This is the **planned/autostart**
   * home; the runtime a worker actually registered on is reported by health (`health.detail.runtime`)
   * and surfaced as `liveModel`'s siblings on the model row.
   */
  runtime: string;
  /**
   * Can the orchestrator start this slot itself (Run Now / scheduler tick)? Only Script AI can: it is
   * the one notebook wired to `KAGGLE_KERNEL_REF`. The other agents live on their own Kaggle
   * notebooks that a human starts, so pressing Run Now for them must be refused with the real reason
   * rather than re-pushing somebody else's kernel.
   */
  autostart: boolean;
  /** The exact blocker when `autostart` is false. Never a secret. */
  autostartNote?: string;
};

/**
 * Which models exist right now. This mirrors the real provider definitions in
 * apps/api/src/lib/providerHealth.ts — the health, never this list, decides ONLINE.
 *
 * The four AI agents (script / image / voice / overseer) are real Kaggle notebooks in production
 * and each serves Qwen3-4B on the Kaggle T4 (14.6 GiB). The catalog names the *intended* model; the
 * model a worker actually loaded is reported by the worker itself in `health.detail.model` and
 * surfaced as `liveModel` (see liveModelFromHealth).
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    key: "script-qwen3-4b",
    providerId: "script",
    modelRef: "qwen3-4b",
    label: "Script AI · Qwen3 4B",
    description: "Story development, scripts, scene breakdowns and narration text.",
    provider: "kaggle",
    runtime: "kaggle",
    autostart: true,
  },
  {
    key: "image-qwen3-4b",
    providerId: "image",
    modelRef: "qwen3-4b",
    label: "Image AI · Qwen3 4B",
    description: "Character, environment and scene artwork plus thumbnails.",
    provider: "kaggle",
    runtime: "kaggle",
    autostart: false,
    autostartNote:
      "Image AI runs from its own Kaggle notebook (emmanuelofoye/ostra-image-agent), which a human starts in Kaggle. Run Now cannot start it: no managed runtime is configured for it, and the only other start path would re-push the Script AI kernel.",
  },
  {
    key: "voice-qwen3-4b",
    providerId: "voice",
    modelRef: "qwen3-4b",
    label: "Voice AI · Qwen3 4B",
    description: "Narration, dialogue and scene audio at segment level.",
    provider: "kaggle",
    runtime: "kaggle",
    autostart: false,
    autostartNote:
      "Voice AI runs from its own Kaggle notebook (bettertrade/ostra-voice-agent), which a human starts in Kaggle. Run Now cannot start it for the same reason as Image AI.",
  },
  {
    key: "overseer-qwen3-4b",
    providerId: "overseer",
    modelRef: "qwen3-4b",
    label: "Showrunner · Qwen3 4B",
    description: "Oversees the agent channel, resolves conflicts and reports real status to the director.",
    provider: "kaggle",
    runtime: "kaggle",
    autostart: false,
    autostartNote:
      "The Showrunner runs from kidscity/ostra-showrunner-agent, started by hand in Kaggle. Run Now cannot start it and must never re-push the Script AI kernel as a Showrunner.",
  },
  {
    key: "video-ffmpeg",
    providerId: "video",
    modelRef: "ffmpeg",
    label: "Video Engine · FFmpeg",
    description: "Deterministic assembly: images + audio, subtitles, transitions, encode.",
    provider: "ffmpeg",
    runtime: "local",
    autostart: false,
    autostartNote: "Video rendering (FFmpeg) is not deployed yet",
  },
  {
    key: "youtube-youtube-api",
    providerId: "youtube",
    modelRef: "youtube-api",
    label: "YouTube Publisher",
    description: "Uploads approved videos. Requires OAuth; human approval still gates publishing.",
    provider: "youtube-api",
    runtime: "api",
    autostart: false,
    autostartNote: "YouTube OAuth is not configured",
  },
] as const;

/**
 * The honest refusal for a Run Now request against a slot the orchestrator cannot start itself.
 * Returns null when the slot may be started (or is not switchable), so the caller can let the normal
 * path run. Pure, so the rule is unit-tested without starting anything.
 */
export function autostartRefusal(providerSlot: string | null | undefined): string | null {
  const entry = modelForProvider(providerSlot);
  if (!entry || entry.autostart) return null;
  return entry.autostartNote ?? `${entry.label} has no autostart path configured`;
}

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

/**
 * Stored switch keys from before the agent notebooks moved to Qwen3-4B on Kaggle, mapped to the
 * catalog key that replaced them. An operator's ON/OFF intent must survive a model upgrade instead
 * of being silently dropped with the retired key.
 */
export const LEGACY_MODEL_KEYS: Readonly<Record<string, string>> = {
  "script-qwen3-1-7b": "script-qwen3-4b",
  "image-colab-image": "image-qwen3-4b",
  "voice-kokoro-82m": "voice-qwen3-4b",
};

/** Normalize a stored switch key: current key unchanged, retired key → its successor, else null. */
export function resolveStoredModelKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  if (MODEL_CATALOG.some((m) => m.key === k)) return k;
  return LEGACY_MODEL_KEYS[k] ?? null;
}

/**
 * The model a live worker actually reported (e.g. "Qwen/Qwen3-4B"), or null when no worker row is
 * attached to the health. Never inferred from configuration.
 */
export function liveModelFromHealth(health: ProviderHealth | null | undefined): string | null {
  const model = health?.detail?.["model"];
  return typeof model === "string" && model.trim() !== "" ? model.trim() : null;
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
  /** The model the live worker reported, when one has registered. Null ⇒ not observed. */
  liveModel?: string | null;
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
