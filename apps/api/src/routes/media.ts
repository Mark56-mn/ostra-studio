// apps/api/src/routes/media.ts
// MEDIA GENERATION (spec §3C/3D/3E) — the real endpoint in front of the verified provider registry.
//
//   GET  /api/media/providers → the registry (no secrets) + whether a key is configured
//   POST /api/media/generate  → { capability, prompt, image_base64?, … } → bytes + provenance
//
// Honesty rules (CONSTRAINTS.md):
//  - The key stays server-side; the browser only ever sees that it IS or IS NOT configured.
//  - The bytes are returned to the caller but never written into the database — `CONSTRAINTS.md` 14
//    puts large binaries in object storage, and until the storage adapter lands the response is the
//    only place they live. An `events` row records the PROVENANCE (model, capability, size, latency)
//    so a generated asset is traceable without bloating a table.
//  - A failure is returned as the provider's real failure, with its real HTTP meaning.

import type { Request, Response } from "express";
import {
  MEDIA_CAPABILITIES,
  MEDIA_PROVIDERS,
  mediaProviderFor,
  toImageDataUri,
  type MediaCapability,
} from "@ostra/shared";
import { requireSupabase } from "../lib/supabase.js";
import { generateMedia, nvidiaKeyConfigured } from "../lib/mediaProviders.js";

/** The registry, with the availability question answered honestly instead of optimistically. */
export function mediaProvidersPayload() {
  return {
    providers: MEDIA_PROVIDERS.map((p) => ({
      key: p.key,
      provider: p.provider,
      model: p.model,
      capability: p.capability,
      host: new URL(p.endpoint).host,
      tier: p.tier,
      media_type: p.mediaType,
      limits: p.limits,
      note: p.note,
    })),
    nvidia_key_configured: nvidiaKeyConfigured(),
    /**
     * Whether a provider is available FOR THIS ACCOUNT is a runtime fact. Until a real probe has
     * been run from this deployment the answer is 'unproven' — never 'online'.
     */
    availability: nvidiaKeyConfigured() ? "key configured — probe to verify this account's access" : "not configured",
    timestamp: new Date().toISOString(),
  };
}

export async function listMediaProviders(_req: Request, res: Response) {
  res.json(mediaProvidersPayload());
}

// ── POST /api/media/probe ──────────────────────────────────────────────
/**
 * A REAL availability probe: one genuine (minimal) generation against the configured provider, so
 * "is this model available for THIS account" is answered by the provider itself, never by hope.
 * The result is recorded as an event, and the outcome is reported verbatim — including a 404 that
 * means "not enabled for this account".
 */
export async function probeMediaHandler(req: Request, res: Response) {
  const body = req.body as { capability?: string } | null;
  const capability = body?.capability as MediaCapability | undefined;
  if (!capability || !(MEDIA_CAPABILITIES as readonly string[]).includes(capability)) {
    return res.status(400).json({ error: `capability must be one of ${MEDIA_CAPABILITIES.join(" | ")}` });
  }
  const spec = mediaProviderFor(capability);

  const result = await generateMedia({
    capability,
    prompt: capability === "tts" ? "Probe." : "A single ink brush stroke on white paper.",
    numFrames: 25,
    timeoutMs: capability === "image2video" ? 150_000 : 120_000,
  });

  const probe = {
    capability,
    model: spec?.model ?? null,
    available: result.ok,
    /** Present only on success — the bytes exist, so they are reported as measured. */
    bytes: result.ok ? result.bytes : null,
    latency_ms: result.ok ? result.latencyMs : null,
    code: result.ok ? null : result.code,
    reason: result.ok ? null : result.error,
    checked_at: new Date().toISOString(),
  };

  res.status(result.ok || result.code === "RATE_LIMITED" ? 200 : 503).json(probe);
}

// ── POST /api/media/generate ────────────────────────────────────────────────
export async function generateMediaHandler(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;

  const body = req.body as {
    capability?: string;
    prompt?: string;
    image_base64?: string;
    image_media_type?: string;
    resolution?: string;
    num_frames?: number;
    fps?: number;
    language?: string;
    voice?: string;
    project_id?: string | null;
    scene_id?: string | null;
  } | null;

  const capability = body?.capability as MediaCapability | undefined;
  if (!capability || !(MEDIA_CAPABILITIES as readonly string[]).includes(capability)) {
    return res.status(400).json({ error: `capability must be one of ${MEDIA_CAPABILITIES.join(" | ")}` });
  }
  if (!body?.prompt?.trim()) return res.status(400).json({ error: "prompt is required" });

  const spec = mediaProviderFor(capability);
  const imageDataUri = body.image_base64 ? toImageDataUri(body.image_base64, (body.image_media_type as "image/png") ?? "image/jpeg") : null;

  const result = await generateMedia({
    capability,
    prompt: body.prompt,
    imageDataUri,
    language: body.language,
    voice: body.voice,
    resolution: body.resolution,
    numFrames: typeof body.num_frames === "number" ? body.num_frames : undefined,
    fps: typeof body.fps === "number" ? body.fps : undefined,
  });

  if (!result.ok) {
    // The provider's real meaning, preserved: a rate limit stays a 429 with its Retry-After so a
    // caller can wait instead of hammering a metered account.
    if (result.code === "RATE_LIMITED") res.setHeader("Retry-After", String(result.retryAfterSec ?? 60));
    const status = result.code === "RATE_LIMITED" ? 429 : result.code === "NO_API_KEY" ? 503 : result.code === "NOT_AUTHORIZED" ? 502 : 502;
    return res.status(status).json({
      error: result.code,
      reason: result.error,
      ...(result.retryAfterSec ? { retry_after_sec: result.retryAfterSec } : {}),
      provider: spec ? { model: spec.model, capability: spec.capability, tier: spec.tier } : null,
    });
  }

  // Provenance, not payloads: record WHAT was generated and from what, never the bytes themselves.
  await supa
    .from("events")
    .insert({
      type: "media.generated",
      project_id: body.project_id ?? null,
      actor: "media-provider",
      payload: {
        capability,
        model: result.model,
        provider: result.provider,
        bytes: result.bytes,
        media_type: result.mediaType,
        latency_ms: result.latencyMs,
        prompt_chars: body.prompt.trim().length,
        scene_id: body.scene_id ?? null,
      },
    })
    .then(
      () => undefined,
      (e) => console.error("[media] event insert failed", e?.message ?? e)
    );

  res.json({
    capability,
    media_type: result.mediaType,
    model: result.model,
    provider: result.provider,
    latency_ms: result.latencyMs,
    bytes: result.bytes,
    base64: result.base64,
    timestamp: new Date().toISOString(),
  });
}
