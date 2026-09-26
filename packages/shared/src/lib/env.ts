// Centralizes env access. Secrets are server-only; NEXT_PUBLIC_* is safe for the browser.
// Rationale: prevents accidental frontend leakage and makes adapter availability checkable.

export function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

export function flagAutoPublish(): boolean {
  return process.env.AUTO_PUBLISH === "true";
}

export const workerEndpoints = {
  scriptKaggle: process.env.KAGGLE_SCRIPT_URL as string | undefined,
  imageColab: process.env.COLAB_IMAGE_URL as string | undefined,
  voiceColab: process.env.COLAB_VOICE_URL as string | undefined,
  kokoro: process.env.KOKORO_VOICE_URL as string | undefined,
} as const;

// Server-only getter that throws if called from the browser for secret keys.
export function getServerSecret(key: "SUPABASE_SERVICE_ROLE_KEY" | "KAGGLE_API_TOKEN" | "YOUTUBE_CLIENT_SECRET") {
  if (typeof window !== "undefined") throw new Error(`${key} is server-only`);
  return process.env[key];
}
