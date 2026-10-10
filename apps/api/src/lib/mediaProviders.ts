// apps/api/src/lib/mediaProviders.ts
// The REAL network client for the media registry (image / image-to-video / TTS). Server-side only:
// the NVIDIA key never leaves this process (`CONSTRAINTS.md` 15).
//
// Truth rules (CONSTRAINTS.md 2, 3, 21):
//  - Every failure is returned as itself: 401/403 says the endpoint is not enabled for this account,
//    429 carries the provider's real Retry-After, a timeout says the request timed out and NOT that
//    generation failed (a client timeout does not prove the provider stopped).
//  - Nothing here fabricates bytes. A 200 without the documented field is a failure.

import {
  buildCosmosRequest,
  buildTtsFields,
  looksLikeWav,
  mediaProviderFor,
  parseCosmosResponse,
  toImageDataUri,
  MAX_INPUT_IMAGE_BYTES,
  type MediaCapability,
} from "@ostra/shared";

export type MediaCallResult =
  | {
      ok: true;
      base64: string;
      mediaType: string;
      provider: string;
      model: string;
      latencyMs: number;
      bytes: number;
    }
  | { ok: false; code: string; error: string; retryAfterSec?: number };

export function nvidiaKeyConfigured(): boolean {
  return Boolean(process.env.NVIDIA_API_KEY?.trim());
}

const DEFAULT_TIMEOUT_MS: Record<MediaCapability, number> = {
  text2image: 90_000,
  image2video: 240_000,
  tts: 60_000,
};

/**
 * Map an upstream HTTP failure onto an honest local outcome. Pure, so the exact wording the API
 * returns is unit-tested instead of being invented inside a network call.
 */
export function mapMediaHttpError(
  status: number,
  retryAfterHeader: string | null,
  bodyText: string,
  model: string
): MediaCallResult & { ok: false } {
  const snippet = bodyText.slice(0, 300);
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: "NOT_AUTHORIZED",
      error: `NVIDIA refused (${status}) for ${model}. This free hosted endpoint may not be enabled for this account — check the model's page on build.nvidia.com while signed in. ${snippet}`,
    };
  }
  if (status === 429) {
    const retryAfterSec = Number.parseInt(retryAfterHeader ?? "", 10);
    return {
      ok: false,
      code: "RATE_LIMITED",
      error: `NVIDIA rate-limited this ${model} request (429). The trial tier may throttle at any time. ${snippet}`,
      retryAfterSec: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 60,
    };
  }
  return {
    ok: false,
    code: "UPSTREAM_ERROR",
    error: `${model} answered HTTP ${status}. ${snippet}`,
  };
}

export type GenerateMediaOptions = {
  capability: MediaCapability;
  prompt: string;
  /** Raw base64 (with or without a data: prefix) of the source image for image2video. */
  imageDataUri?: string | null;
  language?: string;
  voice?: string;
  resolution?: string;
  numFrames?: number;
  fps?: number;
  timeoutMs?: number;
};

/** Call the provider for real. Never throws — a transport failure is a returned, reportable failure. */
export async function generateMedia(opts: GenerateMediaOptions): Promise<MediaCallResult> {
  const spec = mediaProviderFor(opts.capability);
  if (!spec) {
    return { ok: false, code: "NO_PROVIDER", error: `no verified provider is registered for '${opts.capability}'` };
  }
  const key = process.env.NVIDIA_API_KEY?.trim();
  if (!key) {
    return {
      ok: false,
      code: "NO_API_KEY",
      error: "NVIDIA_API_KEY is not set on the backend, so no media can be generated. Set it server-side (Render → Environment).",
    };
  }

  const prompt = opts.prompt.trim();
  if (!prompt) return { ok: false, code: "BAD_INPUT", error: "prompt is required" };
  if (prompt.length > spec.maxPromptChars) {
    return { ok: false, code: "BAD_INPUT", error: `prompt is too long (max ${spec.maxPromptChars} characters for ${spec.model})` };
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS[opts.capability];
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    let response: Response;

    if (spec.requestStyle === "cosmos") {
      if (opts.capability === "image2video" && !opts.imageDataUri) {
        return { ok: false, code: "BAD_INPUT", error: "image2video needs the source image (image_base64)" };
      }
      if (opts.capability === "image2video" && opts.imageDataUri) {
        const approxBytes = Math.floor(opts.imageDataUri.replace(/^data:[^;]+;base64,/, "").length * 0.75);
        if (approxBytes > MAX_INPUT_IMAGE_BYTES) {
          return {
            ok: false,
            code: "BAD_INPUT",
            error: `source image is too large (${approxBytes} bytes; max ${MAX_INPUT_IMAGE_BYTES})`,
          };
        }
      }
      const body = buildCosmosRequest(opts.capability === "tts" ? "text2image" : opts.capability, {
        prompt,
        imageDataUri: opts.imageDataUri ?? null,
        resolution: opts.resolution,
        numFrames: opts.numFrames,
        fps: opts.fps,
      });
      response = await fetch(spec.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } else {
      const form = new FormData();
      for (const [k, v] of Object.entries(buildTtsFields({ text: prompt, language: opts.language, voice: opts.voice }))) {
        form.append(k, v);
      }
      response = await fetch(spec.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, Accept: "audio/wav" },
        body: form,
        signal: controller.signal,
      });
    }

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return mapMediaHttpError(response.status, response.headers.get("retry-after"), text, spec.model);
    }

    if (spec.requestStyle === "riva-multipart") {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!looksLikeWav(bytes)) {
        return {
          ok: false,
          code: "BAD_OUTPUT",
          error: `${spec.model} answered 200 but the body is not WAV audio (${bytes.length} bytes) — refusing to call it generated audio.`,
        };
      }
      return {
        ok: true,
        base64: Buffer.from(bytes).toString("base64"),
        mediaType: spec.mediaType,
        provider: spec.provider,
        model: spec.model,
        latencyMs,
        bytes: bytes.length,
      };
    }

    const json: unknown = await response.json().catch(() => null);
    const parsed = parseCosmosResponse(json, opts.capability === "tts" ? "text2image" : opts.capability);
    if (!parsed.ok) return { ok: false, code: "BAD_OUTPUT", error: `${spec.model}: ${parsed.error}` };
    const bytes = Math.floor(parsed.base64.length * 0.75);
    return {
      ok: true,
      base64: parsed.base64,
      mediaType: spec.mediaType,
      provider: spec.provider,
      model: spec.model,
      latencyMs,
      bytes,
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "TIMEOUT" : "UNREACHABLE",
      error: aborted
        ? `${spec.model} did not answer within ${Math.round(timeoutMs / 1000)}s. A timeout does NOT prove the provider stopped generating — check before retrying so the same clip is not generated twice.`
        : `could not reach ${spec.endpoint}: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export { toImageDataUri };
