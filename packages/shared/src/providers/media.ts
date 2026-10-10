// packages/shared/src/providers/media.ts
// MEDIA PROVIDERS — image generation, image-to-video and text-to-speech (spec §3C/3D/3E, §6).
//
// One registry, one capability contract, so a provider can be swapped by configuration and the
// workflow never changes. Every entry below was verified against NVIDIA's own model pages on
// 2026-10-09 (see docs/AUDIT-2026-10-09.md §C) — NOT from memory:
//
//   * `nvidia/cosmos3-nano` is the ONLY visual model with a verified free hosted endpoint, and the
//     SAME endpoint serves both `text2image` and `image2video`.
//   * `nvidia/magpie-tts-multilingual` has a documented hosted HTTPS synthesis route.
//   * FLUX.1-schnell / Seedance / Wan / LTX were NOT verified free-hosted and are therefore NOT in
//     this registry. A model that could not be verified stays out rather than being advertised.
//
// Truth rules (CONSTRAINTS.md):
//  - "free" here means NVIDIA's trial/development tier: no published quota, throttling allowed.
//    The registry records that honestly instead of implying a guarantee.
//  - Availability for a GIVEN account is a runtime fact, discovered by a real probe — never assumed
//    from the presence of an entry here.
//
// LIVE PROBE, this workspace's key, 2026-10-09 (see `POST /api/media/probe` and the audit):
//   * TTS  `…nvcf.nvidia.com/v1/audio/synthesize`  → HTTP 200, real 67,628-byte WAV (RIFF verified).
//   * Text→image and image→video (`ai.api.nvidia.com/v1/cosmos/…`, and every image model tried on
//     `integrate.api.nvidia.com/v1/images/generations` — flux.1-schnell, sdxl-turbo,
//     diffusiongemma) → HTTP 404 "page not found". The route authenticates (a missing `model` field
//     correctly returns 400), so this is an ENABLED-FOR-THIS-ACCOUNT problem, not a bad key.
//   The adapters below stay wired so that enabling a visual model on build.nvidia.com makes the
//   pipeline work with no code change; until then every call reports the real 404 instead of
//   fabricating an asset (`CONSTRAINTS.md` 2).

export const MEDIA_CAPABILITIES = ["text2image", "image2video", "tts"] as const;
export type MediaCapability = (typeof MEDIA_CAPABILITIES)[number];

export type MediaProviderSpec = {
  /** Stable key used by configuration and the dashboard. */
  key: string;
  provider: "nvidia";
  model: string;
  capability: MediaCapability;
  /** The REAL endpoint. Never a placeholder — this is what the client calls. */
  endpoint: string;
  requestStyle: "cosmos" | "riva-multipart";
  /** The field the response carries the bytes in, base64-encoded. */
  outputField: string;
  mediaType: "image/jpeg" | "video/mp4" | "audio/wav";
  /** How "free" this really is, in NVIDIA's own terms. */
  tier: "trial" | "self-hosted";
  /** Documented input limits, so the caller refuses oversized input instead of guessing. */
  maxPromptChars: number;
  maxInputImageBytes: number;
  /** Documented output constraints (from the model card), surfaced to the UI. */
  limits: Record<string, string | number>;
  note: string;
};

/** A 4 MB ceiling on an input image: above that the request is refused before any network call. */
export const MAX_INPUT_IMAGE_BYTES = 4 * 1024 * 1024;

export const MEDIA_PROVIDERS: MediaProviderSpec[] = [
  {
    key: "nvidia-cosmos3-image",
    provider: "nvidia",
    model: "nvidia/cosmos3-nano",
    capability: "text2image",
    endpoint: "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano",
    requestStyle: "cosmos",
    outputField: "b64_image",
    mediaType: "image/jpeg",
    tier: "trial",
    maxPromptChars: 4000,
    maxInputImageBytes: MAX_INPUT_IMAGE_BYTES,
    limits: { resolution: "720_1_1", inference_steps: 50, frames: 1 },
    note: "Free hosted preview endpoint; NVIDIA publishes no fixed quota. PROBED 2026-10-09 from this account: HTTP 404 — the endpoint is not enabled for this account. Enable it on build.nvidia.com and this adapter works with no code change.",
  },
  {
    key: "nvidia-cosmos3-video",
    provider: "nvidia",
    model: "nvidia/cosmos3-nano",
    capability: "image2video",
    endpoint: "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano",
    requestStyle: "cosmos",
    outputField: "b64_video",
    mediaType: "video/mp4",
    tier: "trial",
    maxPromptChars: 4000,
    maxInputImageBytes: MAX_INPUT_IMAGE_BYTES,
    limits: {
      resolutions: "256p | 480p | 720p (with aspect suffix, e.g. 480_16_9)",
      max_frames_720p: 197,
      max_frames_480p: 297,
      max_frames_256p: 397,
      fps: 24,
      codec: "VP9 in MP4 container",
    },
    note: "Same endpoint as text2image with model_mode=image2video; PROBED 2026-10-09: HTTP 404 for this account. Synchronous POST; a client timeout does NOT prove generation stopped.",
  },
  {
    key: "nvidia-magpie-tts",
    provider: "nvidia",
    model: "nvidia/magpie-tts-multilingual",
    capability: "tts",
    endpoint:
      "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize",
    requestStyle: "riva-multipart",
    outputField: "audio",
    mediaType: "audio/wav",
    tier: "trial",
    maxPromptChars: 2000,
    maxInputImageBytes: 0,
    limits: { max_input_chars: 2000, encoding: "wav", sample_rate_hz: 22050 },
    note: "Hosted development API, multipart form, throttling allowed. PROBED 2026-10-09: HTTP 200, real WAV returned — this capability is LIVE for this account. Self-hosted Kokoro-82M (Apache-2.0 weights) remains the quota-free alternative adapter.",
  },
];

/** The registry entry for a capability, or null when nothing verified exists. */
export function mediaProviderFor(capability: MediaCapability): MediaProviderSpec | null {
  return MEDIA_PROVIDERS.find((p) => p.capability === capability) ?? null;
}

export type CosmosRequest = {
  model_mode: "text2image" | "image2video";
  prompt: string;
  input_reference?: string;
  resolution?: string;
  num_frames?: number;
  fps?: number;
};

/**
 * Build the REAL request body for the Cosmos endpoint. Pure, so the exact payload the provider
 * receives is unit-tested rather than assembled inline in a network call.
 */
export function buildCosmosRequest(
  capability: "text2image" | "image2video",
  opts: { prompt: string; imageDataUri?: string | null; resolution?: string; numFrames?: number; fps?: number }
): CosmosRequest {
  const prompt = opts.prompt.trim();
  const body: CosmosRequest = { model_mode: capability, prompt };
  if (capability === "image2video") {
    if (opts.imageDataUri) body.input_reference = opts.imageDataUri;
    body.resolution = opts.resolution ?? "480_16_9";
    body.num_frames = opts.numFrames ?? 49;
    body.fps = opts.fps ?? 24;
  } else {
    body.resolution = opts.resolution ?? "720_1_1";
  }
  return body;
}

/** The multipart fields for the Riva-style TTS route. Pure — the client turns this into FormData. */
export function buildTtsFields(opts: { text: string; language?: string; voice?: string; sampleRateHz?: number }): Record<string, string> {
  const fields: Record<string, string> = { text: opts.text.trim(), language: opts.language ?? "en-US" };
  if (opts.voice) fields.voice = opts.voice;
  if (opts.sampleRateHz) fields.sample_rate_hz = String(opts.sampleRateHz);
  return fields;
}

export type MediaParseResult = { ok: true; base64: string } | { ok: false; error: string };

/**
 * Read a Cosmos response. The model card documents `b64_image` / `b64_video`; anything else is a
 * failure to report verbatim, never an empty success.
 */
export function parseCosmosResponse(json: unknown, capability: "text2image" | "image2video"): MediaParseResult {
  const field = capability === "text2image" ? "b64_image" : "b64_video";
  const obj = (json ?? {}) as Record<string, unknown>;
  const value = obj[field];
  if (typeof value !== "string" || !value) {
    const detail = typeof obj.error === "string" ? obj.error : JSON.stringify(obj).slice(0, 300);
    return { ok: false, error: `no ${field} in the response — ${detail}` };
  }
  return { ok: true, base64: value };
}

/** Reject audio that is not actually WAV bytes, so a silent 200 never becomes a "generated" clip. */
export function looksLikeWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // "RIFF"
}

/** Normalize an image into the data-URI form the Cosmos endpoint accepts. */
export function toImageDataUri(base64: string, mediaType: "image/jpeg" | "image/png" = "image/jpeg"): string {
  const clean = base64.replace(/^data:[^;]+;base64,/, "").trim();
  return `data:${mediaType};base64,${clean}`;
}
