// Provider registry
// Resolves provider adapters. Status is derived from REAL configuration/credentials and, for
// storage, from a real Supabase query — never from a hand-maintained URL that must be kept alive.
//
// The runtime supervisor (apps/api) enriches these config-level statuses with live worker
// heartbeat + startup-attempt truth (see apps/api/src/lib/providerHealth.ts).
//
// ONLINE is never produced here: configuration presence alone is NOT health.

import type { ProviderRegistry, ProviderHealth } from "./contracts";
import { offlineResult } from "./contracts";
import { makeHealth } from "./health";
import { checkSupabaseHealth } from "../lib/supabase";
import { colabConfig, kaggleConfig } from "../lib/env";

type Adapter = ProviderRegistry[keyof ProviderRegistry];

function makeTaskStubs(reason: string) {
  // Task execution is not wired for these adapters yet; they must never claim success.
  return {
    developStory: async () => offlineResult(reason),
    writeScript: async () => offlineResult(reason),
    breakdownScenes: async () => offlineResult(reason),
    narration: async () => offlineResult(reason),
    generate: async () => offlineResult(reason),
    thumbnail: async () => offlineResult(reason),
    synthesize: async () => offlineResult(reason),
    synthesizeBatch: async () => offlineResult(reason),
    render: async () => offlineResult(reason),
    upload: async () => offlineResult(reason),
    signUrl: async () => null,
  };
}

/** Adapter whose health is a fixed, truthful status derived from configuration. */
function makeConfiguredAdapter(
  id: string,
  providerName: string,
  status: ProviderHealth["status"],
  reason: string
): Adapter {
  return {
    id: id as never,
    providerName,
    health: async () => makeHealth(status, { provider: providerName, reason }),
    ...makeTaskStubs(reason),
  } as unknown as Adapter;
}

export function resolveRegistry(): ProviderRegistry {
  const kaggle = kaggleConfig();
  const image = colabConfig("image");
  const voice = colabConfig("voice");

  return {
    script: makeConfiguredAdapter(
      "script",
      "kaggle",
      kaggle.configured ? "OFFLINE" : "NOT_CONFIGURED",
      kaggle.configured
        ? "Kaggle API configured but the Script runtime has not registered a worker yet"
        : kaggle.reason ?? "Kaggle is not configured"
    ) as ProviderRegistry["script"],

    image: makeConfiguredAdapter(
      "image",
      "colab-image",
      image.configured ? "OFFLINE" : "NOT_CONFIGURED",
      image.configured
        ? "Colab Image runtime configured but no Image worker has registered yet"
        : image.reason ?? "Image runtime is not configured"
    ) as ProviderRegistry["image"],

    voice: makeConfiguredAdapter(
      "voice",
      "kokoro-82m",
      voice.configured ? "OFFLINE" : "NOT_CONFIGURED",
      voice.configured
        ? "Colab Voice runtime configured but no Voice worker has registered yet"
        : voice.reason ?? "Voice runtime is not configured"
    ) as ProviderRegistry["voice"],

    video: makeConfiguredAdapter(
      "video",
      "ffmpeg",
      "NOT_CONFIGURED",
      "Video renderer runs as a local/edge worker — not deployed yet"
    ) as ProviderRegistry["video"],

    storage: {
      id: "storage",
      providerName: "supabase-storage",
      // Real, lightweight check against the configured Supabase — never "configured = ONLINE".
      health: async () => ({ ...(await checkSupabaseHealth()), provider: "supabase-storage" }),
      upload: async () => offlineResult("Storage upload pending Supabase Storage bucket setup"),
      signUrl: async () => null,
    } as ProviderRegistry["storage"],

    youtube: makeConfiguredAdapter(
      "youtube",
      "youtube-api",
      "NOT_CONFIGURED",
      "YouTube OAuth is not configured"
    ) as ProviderRegistry["youtube"],
  };
}

// Cached singleton for server usage
let cached: ProviderRegistry | null = null;
export function getRegistry(): ProviderRegistry {
  if (!cached) cached = resolveRegistry();
  return cached;
}
