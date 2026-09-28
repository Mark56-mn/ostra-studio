// Centralizes env access. Secrets are server-only; NEXT_PUBLIC_* is safe for the browser.
// Rationale: prevents accidental frontend leakage and makes adapter availability checkable.
//
// NOTE (production integration): the runtime supervisor does NOT use *_SCRIPT_URL / *_IMAGE_URL /
// *_VOICE_URL endpoints any more. Providers are driven through the Kaggle/Colab APIs and a worker
// self-registration + heartbeat. Configuration presence is therefore derived from real credentials,
// and presence alone never means ONLINE (see ./providers/health.ts).

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

// ── Supabase (server-side source of truth) ───────────────────────────────────
// The Render backend may be configured with any of these; prefer the explicit server vars.
export type SupabaseUrlSource = "SUPABASE_URL" | "SUPABASE_CONNECTION_STRING" | "NEXT_PUBLIC_SUPABASE_URL";

export function supabaseServerUrl(): string | undefined {
  return (
    clean(process.env.SUPABASE_URL) ??
    clean(process.env.SUPABASE_CONNECTION_STRING) ??
    clean(process.env.NEXT_PUBLIC_SUPABASE_URL)
  );
}

export function supabaseServerKey(): string | undefined {
  return (
    clean(process.env.SUPABASE_SERVICE_ROLE_KEY) ??
    clean(process.env.SUPABASE_ANON_KEY) ??
    clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

export function supabaseUrlSource(): SupabaseUrlSource | undefined {
  if (clean(process.env.SUPABASE_URL)) return "SUPABASE_URL";
  if (clean(process.env.SUPABASE_CONNECTION_STRING)) return "SUPABASE_CONNECTION_STRING";
  if (clean(process.env.NEXT_PUBLIC_SUPABASE_URL)) return "NEXT_PUBLIC_SUPABASE_URL";
  return undefined;
}

/** True when a server-side Supabase client can be constructed. Never implies "healthy". */
export function supabaseServerConfigured(): boolean {
  return Boolean(supabaseServerUrl() && supabaseServerKey());
}

/** Missing-key description for NOT_CONFIGURED reasons (never prints values). */
export function supabaseConfigReason(): string | undefined {
  if (!supabaseServerUrl()) {
    return "Set SUPABASE_URL (or SUPABASE_CONNECTION_STRING / NEXT_PUBLIC_SUPABASE_URL) on Render";
  }
  if (!supabaseServerKey()) {
    return "Set SUPABASE_SERVICE_ROLE_KEY on Render";
  }
  return undefined;
}

/** Browser/legacy helper — client-side only, anonymous key only. */
export function supabaseConfigured(): boolean {
  return Boolean(
    clean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      (clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) || clean(process.env.SUPABASE_SERVICE_ROLE_KEY))
  );
}

export function flagAutoPublish(): boolean {
  return process.env.AUTO_PUBLISH === "true";
}

// ── Kaggle (Script AI runtime) ───────────────────────────────────────────────
// Real execution is a two-part requirement: an API token AND the kernel ref.
export type KaggleConfig = { apiToken?: string; kernelRef?: string; configured: boolean; reason?: string };

export function kaggleConfig(): KaggleConfig {
  const apiToken = clean(process.env.KAGGLE_API_TOKEN);
  const kernelRef = clean(process.env.KAGGLE_KERNEL_REF);
  if (!apiToken && !kernelRef) {
    return { configured: false, reason: "Set KAGGLE_API_TOKEN and KAGGLE_KERNEL_REF on Render" };
  }
  if (!apiToken) {
    return { kernelRef, configured: false, reason: "Set KAGGLE_API_TOKEN on Render (Kaggle JSON key or username:key)" };
  }
  if (!kernelRef) {
    return { apiToken, configured: false, reason: "Set KAGGLE_KERNEL_REF on Render (e.g. bettertrade/notebook7eae283a4a)" };
  }
  return { apiToken, kernelRef, configured: true };
}

// ── Colab (Image / Voice runtimes) ───────────────────────────────────────────
// Managed Colab runtimes need project + OAuth scope, and a bootstrap that actually starts the
// worker inside the runtime. Without the bootstrap the runtime would be a dangling VM, so we
// report NOT_CONFIGURED rather than pretending it is ready.
export type ColabConfig = {
  projectId?: string;
  accessToken?: string;
  bootstrapUrl?: string;
  runtimeSpec?: string;
  configured: boolean;
  reason?: string;
};

export function colabConfig(workerType: string): ColabConfig {
  const projectId =
    clean(process.env.GOOGLE_CLOUD_PROJECT) ??
    clean(process.env.COLAB_PROJECT_ID) ??
    clean(process.env.GCP_PROJECT_ID) ??
    clean(process.env.GOOGLE_PROJECT_ID);
  const accessToken =
    clean(process.env.GOOGLE_OAUTH_TOKEN) ??
    clean(process.env.COLAB_OAUTH_TOKEN) ??
    clean(process.env.COLAB_ACCESS_TOKEN) ??
    clean(process.env.GOOGLE_ACCESS_TOKEN) ??
    clean(process.env.GOOGLE_OAUTH_ACCESS_TOKEN);
  const runtimeSpec = clean(process.env.COLAB_RUNTIME_SPEC);
  const bootstrapUrl = clean(
    workerType === "image"
      ? process.env.COLAB_IMAGE_BOOTSTRAP_URL ?? process.env.COLAB_BOOTSTRAP_URL
      : workerType === "voice"
        ? process.env.COLAB_VOICE_BOOTSTRAP_URL ?? process.env.COLAB_BOOTSTRAP_URL
        : process.env.COLAB_BOOTSTRAP_URL
  );

  const base = { projectId, accessToken, bootstrapUrl, runtimeSpec };
  if (!projectId) {
    return { ...base, configured: false, reason: "Set GOOGLE_CLOUD_PROJECT (Colab API project) on Render" };
  }
  if (!accessToken) {
    return { ...base, configured: false, reason: "Set GOOGLE_OAUTH_TOKEN with the Colab scope on Render" };
  }
  if (!bootstrapUrl) {
    return {
      ...base,
      configured: false,
      reason:
        "Set COLAB_IMAGE_BOOTSTRAP_URL / COLAB_VOICE_BOOTSTRAP_URL so the runtime actually starts the Ostra worker",
    };
  }
  return { ...base, configured: true };
}

// Server-only getter that throws if called from the browser for secret keys.
export function getServerSecret(key: "SUPABASE_SERVICE_ROLE_KEY" | "KAGGLE_API_TOKEN" | "YOUTUBE_CLIENT_SECRET") {
  if (typeof window !== "undefined") throw new Error(`${key} is server-only`);
  return process.env[key];
}
