// Provider capability contracts
// Every provider speaks one of these interfaces. Workflow logic must not depend on the implementation.
// A provider that is not configured returns { ok: false, status: "NOT_CONFIGURED", reason } — never a fake success.
// Only status "ONLINE" (ok:true) means the provider is actually usable.

// Canonical provider status vocabulary. Every surface (backend + dashboard) uses exactly these.
// ONLINE is the ONLY status that may ever be presented as "working".
export type ProviderStatus =
  | "ONLINE"
  | "OFFLINE"
  | "DEGRADED"
  | "NOT_CONFIGURED"
  | "STARTING"
  | "ERROR"
  | "UNKNOWN";

export type ProviderHealth = {
  ok: boolean;
  status: ProviderStatus;
  /** Provider/runtime label, e.g. "kaggle", "colab-image", "supabase". Never contains secrets. */
  provider?: string;
  latencyMs?: number;
  reason?: string;
  checkedAt: string;
  /** Last observed heartbeat (worker-backed providers only). */
  lastHeartbeatAt?: string | null;
  /** Seconds since the last heartbeat, when known. */
  heartbeatAgeSec?: number | null;
  /** Non-secret operational detail (attempt ids, endpoint host, error codes). */
  detail?: Record<string, unknown>;
};

export type ProviderTaskResult<TOutput = Record<string, unknown>> = {
  ok: boolean;
  status: "COMPLETED" | "FAILED" | "WAITING" | "OFFLINE";
  output?: TOutput;
  error?: string;
  artifacts?: Array<{ kind: string; storagePath?: string; inlineText?: string; metadata?: Record<string, unknown> }>;
};

// Inputs are deliberately generic — callers pass the structured domain object, provider maps it.
export interface ScriptProvider {
  readonly id: "script";
  readonly providerName: string; // "kaggle" | "openai" | "anthropic" | ...
  health(): Promise<ProviderHealth>;
  developStory(input: { project: unknown; episode: unknown; prompt: string }): Promise<ProviderTaskResult>;
  writeScript(input: { project: unknown; episode: unknown; outline?: string }): Promise<ProviderTaskResult>;
  breakdownScenes(input: { project: unknown; episode: unknown; script: string }): Promise<ProviderTaskResult<{ scenes: Array<{ index:number; title?:string; script_excerpt?:string; image_spec?:string; narration_segment?:string }> }>>;
  narration(input: { script: string; scenes: unknown[] }): Promise<ProviderTaskResult<{ narration: string }>>;
}

export interface ImageProvider {
  readonly id: "image";
  readonly providerName: string; // "colab-sdxl" | "replicate" | ...
  health(): Promise<ProviderHealth>;
  generate(input: { sceneSpec: string; style?: string; references?: string[]; seed?: number }): Promise<ProviderTaskResult<{ imageUrl?: string; storagePath?: string }>>;
  thumbnail(input: { episodeTitle: string; prompt: string }): Promise<ProviderTaskResult>;
}

export interface VoiceProvider {
  readonly id: "voice";
  readonly providerName: string; // "kokoro-82m" | "piper" | "elevenlabs" | ...
  health(): Promise<ProviderHealth>;
  synthesize(input: { text: string; voice?: string; language?: string }): Promise<ProviderTaskResult<{ audioUrl?: string; storagePath?: string; durationSec?: number }>>;
  synthesizeBatch(input: { segments: Array<{ id: string; text: string }>; voice?: string }): Promise<ProviderTaskResult<{ segments: Array<{ id:string; audioUrl?: string; storagePath?: string; durationSec?: number }> }>>;
}

export interface VideoRenderer {
  readonly id: "video";
  readonly providerName: string; // "ffmpeg" | "remotion" | ...
  health(): Promise<ProviderHealth>;
  render(input: {
    scenes: Array<{ imageUrl: string; audioUrl?: string; durationSec?: number; subtitle?: string }>;
    settings?: Record<string, unknown>;
  }): Promise<ProviderTaskResult<{ videoUrl?: string; storagePath?: string; durationSec?: number }>>;
}

export interface StorageProvider {
  readonly id: "storage";
  readonly providerName: string; // "supabase-storage" | "s3" | ...
  health(): Promise<ProviderHealth>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<ProviderTaskResult<{ storagePath: string; publicUrl?: string }>>;
  signUrl(path: string, expiresSec?: number): Promise<string | null>;
}

export interface YouTubeProvider {
  readonly id: "youtube";
  readonly providerName: string; // "youtube-api" | ...
  health(): Promise<ProviderHealth>;
  upload(input: { videoPath: string; title: string; description?: string; thumbnailPath?: string; privacy?: "private"|"unlisted"|"public" }): Promise<ProviderTaskResult<{ videoId: string; url: string }>>;
}

// Registry — the orchestrator reads this, never the workflow components directly
export type ProviderRegistry = {
  script?: ScriptProvider;
  image?: ImageProvider;
  voice?: VoiceProvider;
  video?: VideoRenderer;
  storage?: StorageProvider;
  youtube?: YouTubeProvider;
};

export function healthLabel(h: ProviderHealth | null | undefined): string {
  if (!h) return "UNKNOWN";
  return h.status;
}

// A tiny "offline" stub that satisfies any provider's health() contract without pretending to work.
export function offlineHealth(reason = "Not configured"): ProviderHealth {
  return { ok: false, status: "OFFLINE", reason, checkedAt: new Date().toISOString() };
}
export function offlineResult<T>(reason = "Provider not configured"): ProviderTaskResult<T> {
  return { ok: false, status: "OFFLINE", error: reason };
}
