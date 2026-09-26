// Provider registry
// Resolves adapters from environment. If an env var is absent, that provider is OFFLINE — not mocked.
// Replace KAGGLE_* / COLAB_* / KOKORO_* env vars to go ONLINE without changing any workflow code.

import type { ProviderRegistry } from "./contracts";
import { offlineHealth, offlineResult } from "./contracts";

type Adapter = ProviderRegistry[keyof ProviderRegistry];

function makeOfflineAdapter(id: string, providerName: string, reason: string): Adapter {
  const health = async () => offlineHealth(reason);
  // Each adapter shares the same offline shape; extra methods just return OFFLINE results.
  return {
    id: id as never,
    providerName,
    health,
    // Script
    developStory: async () => offlineResult(reason),
    writeScript: async () => offlineResult(reason),
    breakdownScenes: async () => offlineResult(reason),
    narration: async () => offlineResult(reason),
    // Image / voice / video / storage / youtube shared fallbacks
    generate: async () => offlineResult(reason),
    thumbnail: async () => offlineResult(reason),
    synthesize: async () => offlineResult(reason),
    synthesizeBatch: async () => offlineResult(reason),
    render: async () => offlineResult(reason),
    upload: async () => offlineResult(reason),
    signUrl: async () => null,
  } as unknown as Adapter;
}

// Concrete HTTP adapters live here once credentials exist. For now they probe the configured URL
// and report real health — no fake COMPLETED states.
function makeHttpProbingAdapter(
  id: string,
  providerName: string,
  baseUrl: string | undefined,
  extraReason: string
): Adapter {
  if (!baseUrl) return makeOfflineAdapter(id, providerName, extraReason);
  const health = async () => {
    const start = Date.now();
    try {
      const r = await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(4000) });
      const latencyMs = Date.now() - start;
      if (r.ok) return { ok: true, status: "ONLINE" as const, latencyMs, checkedAt: new Date().toISOString() };
      return { ok: false, status: "DEGRADED" as const, latencyMs, reason: `HTTP ${r.status}`, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, status: "OFFLINE" as const, reason: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() };
    }
  };
  // Task execution for HTTP adapters is intentionally not implemented in Phase 0/1.
  // They report health truthfully; task submission lands in Phase 4-6 and will POST to the worker URL.
  return {
    id: id as never,
    providerName,
    health,
    developStory: async () => offlineResult("Script task execution not yet wired — worker is reachable, adapter pending (Phase 4)"),
    writeScript: async () => offlineResult("Script task execution not yet wired — Phase 4"),
    breakdownScenes: async () => offlineResult("Script task execution not yet wired — Phase 4"),
    narration: async () => offlineResult("Script task execution not yet wired — Phase 4"),
    generate: async () => offlineResult("Image generation not yet wired — Phase 5"),
    thumbnail: async () => offlineResult("Image generation not yet wired — Phase 5"),
    synthesize: async () => offlineResult("Voice synthesis not yet wired — Phase 6"),
    synthesizeBatch: async () => offlineResult("Voice synthesis not yet wired — Phase 6"),
    render: async () => offlineResult("Video rendering not yet wired — Phase 7"),
    upload: async () => offlineResult("Storage adapter pending env"),
    signUrl: async () => null,
  } as unknown as Adapter;
}

export function resolveRegistry(): ProviderRegistry {
  const kaggleUrl = process.env.KAGGLE_SCRIPT_URL;
  const imageUrl  = process.env.COLAB_IMAGE_URL;
  const voiceUrl  = process.env.COLAB_VOICE_URL || process.env.KOKORO_VOICE_URL;
  const hasSupabase = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);

  return {
    script:  makeHttpProbingAdapter("script",  kaggleUrl ? "kaggle" : "kaggle (unconfigured)", kaggleUrl, "Set KAGGLE_SCRIPT_URL to connect Script AI") as ProviderRegistry["script"],
    image:   makeHttpProbingAdapter("image",   imageUrl  ? "colab-image" : "colab-image (unconfigured)", imageUrl, "Set COLAB_IMAGE_URL to connect Image AI") as ProviderRegistry["image"],
    voice:   makeHttpProbingAdapter("voice",   voiceUrl  ? "kokoro-82m" : "kokoro-82m (unconfigured)", voiceUrl, "Set KOKORO_VOICE_URL or COLAB_VOICE_URL to connect Voice AI") as ProviderRegistry["voice"],
    video:   makeOfflineAdapter("video", "ffmpeg (local)", "Video renderer runs as a local/edge worker — Phase 7") as ProviderRegistry["video"],
    storage: hasSupabase
      ? { id: "storage", providerName: "supabase-storage",
          health: async () => ({ ok: true, status: "ONLINE", checkedAt: new Date().toISOString() }),
          upload: async () => offlineResult("Storage upload pending Supabase Storage bucket setup"),
          signUrl: async () => null,
        } as ProviderRegistry["storage"]
      : makeOfflineAdapter("storage", "supabase-storage (unconfigured)", "Set NEXT_PUBLIC_SUPABASE_URL + keys") as ProviderRegistry["storage"],
    youtube: makeOfflineAdapter("youtube", "youtube-api (unconfigured)", "YouTube OAuth not configured — Phase 9") as ProviderRegistry["youtube"],
  };
}

// Cached singleton for server usage
let cached: ProviderRegistry | null = null;
export function getRegistry(): ProviderRegistry {
  if (!cached) cached = resolveRegistry();
  return cached;
}
