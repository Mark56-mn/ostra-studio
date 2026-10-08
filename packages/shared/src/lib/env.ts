// Centralizes env access. Secrets are server-only; NEXT_PUBLIC_* is safe for the browser.
// Rationale: prevents accidental frontend leakage and makes adapter availability checkable.
import { NVIDIA_DEFAULT_BASE_URL, NVIDIA_DEFAULT_MODEL } from "../providers/nvidia";
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

/**
 * All configured Kaggle API tokens, in priority order.
 *
 * Kaggle tokens belong to ONE account each, and several accounts are in play (the agent notebooks
 * may live under a different owner than the operator-managed Script AI kernel). The workspace may
 * therefore hold several tokens under numbered/named keys:
 *
 *   KAGGLE_API_TOKEN          — original single-token name (still supported first for Render parity)
 *   KAGGLE_API_TOKEN_1..9     — numbered tokens (1 is preferred when no plain name exists)
 *   KAGGLE_API_TOKEN_<NAME>   — any other suffixed name (e.g. KAGGLE_API_TOKEN_BETTERTRADE)
 *   <NAME>_KAGGLE_API_TOKEN   — labelled-by-owner variant (e.g. EMMANUEL_OFOYE_KAGGLE_API_TOKEN), read
 *                             after the numbered/suffixed ones so slot numbers stay predictable
 *
 * Values are returned verbatim in config order and never logged; callers pick one and pass it
 * through getKaggleAuthHeader(). An empty/blank value is skipped, not an error.
 */
export function kaggleApiTokens(): string[] {
  const tokens: string[] = [];
  const push = (v: string | undefined) => {
    const t = clean(v);
    if (t && !tokens.includes(t)) tokens.push(t);
  };
  push(process.env.KAGGLE_API_TOKEN);
  const numbered: Array<{ key: string; n: number }> = [];
  const named: string[] = [];
  const labelled: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("KAGGLE_API_TOKEN")) {
      const suffix = key.slice("KAGGLE_API_TOKEN".length);
      if (!suffix) continue; // plain name already pushed
      const m = /^_(\d+)$/.exec(suffix);
      if (m) numbered.push({ key, n: Number(m[1]) });
      else named.push(key);
      continue;
    }
    // Operators also label tokens by account (EMMANUEL_OFOYE_KAGGLE_API_TOKEN). Accept that shape too,
    // otherwise a correctly-pasted key is silently ignored and the agent looks "unconfigured".
    if (key.length > "KAGGLE_API_TOKEN".length && key.endsWith("KAGGLE_API_TOKEN")) labelled.push(key);
  }
  numbered.sort((a, b) => a.n - b.n);
  for (const { key } of numbered) push(process.env[key]);
  for (const key of named.sort()) push(process.env[key]);
  for (const key of labelled.sort()) push(process.env[key]);
  return tokens;
}

export function kaggleConfig(): KaggleConfig {
  const apiToken = clean(process.env.KAGGLE_API_TOKEN) ?? kaggleApiTokens()[0];
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

// ── Per-agent Kaggle notebooks (Image / Voice / Showrunner) ──────────────────
// Each agent has its OWN notebook, and each notebook belongs to ONE Kaggle account. Starting an agent
// therefore needs that agent's kernel ref and the token of the account that owns it — never the Script
// kernel. Script keeps the original KAGGLE_KERNEL_REF name for Render parity; every other slot reads
// its own KAGGLE_KERNEL_REF_<SLOT>, so a start can never silently re-push somebody else's notebook.
export const KAGGLE_AGENT_SLOTS = ["script", "image", "voice", "overseer"] as const;
export type KaggleAgentSlot = (typeof KAGGLE_AGENT_SLOTS)[number];

/** The env var holding a slot's own Kaggle kernel ref. `script` → `KAGGLE_KERNEL_REF`. */
export function kaggleKernelRefEnvName(workerType: string): string {
  const slot = workerType.trim().toLowerCase();
  if (slot === "script") return "KAGGLE_KERNEL_REF";
  return `KAGGLE_KERNEL_REF_${slot.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * The Kaggle kernel ref for one agent slot, or undefined when it is not configured.
 *
 * There is deliberately NO fallback to the Script ref (or any other slot's ref): pushing the Script
 * notebook as Image/Voice/Showrunner would run the wrong worker under the wrong identity, so a missing
 * ref is an honest refusal, not a guess.
 */
export function kaggleKernelRef(workerType: string): string | undefined {
  return clean(process.env[kaggleKernelRefEnvName(workerType)]);
}

/**
 * Candidate Kaggle tokens for a slot, best first: a slot-labelled token, then every configured token
 * (plain name, numbered, named). Kaggle tokens each own ONE account, and the agent notebooks live on
 * different accounts, so the starter picks the token whose account actually owns the kernel ref.
 */
export function kaggleApiTokensFor(workerType: string): string[] {
  const slot = workerType.trim().toLowerCase();
  const out: string[] = [];
  const push = (v: string | undefined) => {
    const t = clean(v);
    if (t && !out.includes(t)) out.push(t);
  };
  const upper = slot.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  push(process.env[`KAGGLE_API_TOKEN_${upper}`]);
  push(process.env[`${upper}_KAGGLE_API_TOKEN`]);
  for (const t of kaggleApiTokens()) push(t);
  return out;
}

// ── NVIDIA NIM (hosted backup for every agent) ───────────────────────────────
// NVIDIA's free NIM endpoints are OpenAI-compatible, so they are a drop-in backup for every agent
// slot when the project's own runtime is not ONLINE. The key is server-only: this function is never
// bundled into a browser response, and `nvidiaConfig()` deliberately returns no key to any caller
// that would serialize it (see apps/api/src/lib/agentRuntime.ts, where it becomes an Authorization
// header and nothing else).
//
// `NVIDIA_API_KEY` is the documented name; `NVIDIA_NIM_API_KEY` is accepted as an alias so an operator
// who copied NVIDIA's own docs does not end up with a silently unconfigured backup.
export type NvidiaConfig = {
  apiKey?: string;
  /** Verified OpenAI-compatible base; only an allowlisted host may receive the key (see providers/nvidia.ts). */
  baseUrl: string;
  /** The model used unless a slot-specific override exists. */
  model: string;
  host: string | null;
  /** Is `NVIDIA_THINKING` on? Reasoning is requested only for models that document a switch. */
  thinking: boolean;
  configured: boolean;
  reason?: string;
};

// Both NVIDIA defaults live in providers/nvidia.ts (the catalog module) so the model that is shipped
// as the default and the model that is allowed to be dispatched cannot drift apart. The previous
// duplication is exactly how a retired id became the default in the first place.

/** Clamp the per-minute hosted-call budget so a typo cannot disable the limiter or open it wide. */
export function nvidiaRateLimitPerMinute(): number {
  const raw = parseInt(process.env.NVIDIA_RATE_LIMIT_PER_MIN ?? "20", 10);
  if (!Number.isFinite(raw)) return 20;
  return Math.max(1, Math.min(600, raw));
}

function nvidiaThinkingEnabled(): boolean {
  const raw = clean(process.env.NVIDIA_THINKING)?.toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

export function nvidiaConfig(): NvidiaConfig {
  const apiKey = clean(process.env.NVIDIA_API_KEY) ?? clean(process.env.NVIDIA_NIM_API_KEY);
  const baseUrl = clean(process.env.NVIDIA_BASE_URL) ?? NVIDIA_DEFAULT_BASE_URL;
  const model = clean(process.env.NVIDIA_CHAT_MODEL) ?? NVIDIA_DEFAULT_MODEL;
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return null;
    }
  })();
  const base: Omit<NvidiaConfig, "configured" | "reason"> = {
    baseUrl,
    model,
    host,
    thinking: nvidiaThinkingEnabled(),
  };
  if (!apiKey) {
    return {
      ...base,
      configured: false,
      reason: "Set NVIDIA_API_KEY on the backend (build.nvidia.com → Get API Key; the key starts with nvapi-)",
    };
  }
  return { ...base, apiKey, configured: true };
}

/** The NVIDIA model for one agent slot: `NVIDIA_MODEL_<SLOT>` when set, else the shared default. */
export function nvidiaModelForSlot(slot: string): string {
  const key = `NVIDIA_MODEL_${slot.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  return clean(process.env[key]) ?? nvidiaConfig().model;
}

// ── Management Team (hosted, OpenAI-compatible) ──────────────────────────────
// The management team is a HOSTED model, not a worker row: there is no notebook to heartbeat. It is
// therefore health-checked with a real (tiny) completion call, never with mere configuration presence.
//
// Any OpenAI-compatible endpoint works (OpenAI, Lightning AI, a self-hosted gateway, …) because only
// `base_url` + bearer key + `POST {base}/chat/completions` is used. The generic OPENAI_* vars are
// accepted as a fallback so an operator who already has one hosted key needs no second key.
export type ManagerConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Provider label derived from the host (e.g. `lightning`, `openai`), for display only. */
  provider: string;
  /** Host of the base URL — safe to show in the UI; the URL itself stays server-side. */
  host: string | null;
  configured: boolean;
  reason?: string;
};

/** How much the management team may do on its own. Never inferred — always an explicit env var. */
export type ManagerAutonomy = "off" | "instruct" | "full";

export const DEFAULT_MANAGED_MODEL = "gpt-4o-mini";

export function managerConfig(): ManagerConfig {
  const apiKey =
    clean(process.env.MANAGER_API_KEY) ??
    clean(process.env.LIGHTNING_API_KEY) ??
    clean(process.env.OPENAI_API_KEY);
  const baseUrl =
    clean(process.env.MANAGER_BASE_URL) ??
    clean(process.env.LIGHTNING_BASE_URL) ??
    clean(process.env.OPENAI_BASE_URL) ??
    "https://api.openai.com/v1";
  const model =
    clean(process.env.MANAGER_CHAT_MODEL) ??
    clean(process.env.LIGHTNING_CHAT_MODEL) ??
    clean(process.env.OPENAI_CHAT_MODEL) ??
    DEFAULT_MANAGED_MODEL;
  const host = hostOfUrl(baseUrl);
  const provider = /lightning/i.test(host ?? "") ? "lightning" : "openai-compatible";
  if (!apiKey) {
    return {
      baseUrl,
      model,
      provider,
      host,
      configured: false,
      reason: "Set MANAGER_API_KEY on Render (any OpenAI-compatible key, e.g. a Lightning AI key)",
    };
  }
  return { apiKey, baseUrl, model, provider, host, configured: true };
}

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Autonomy gate for the management team:
 *  - `off`     → the model may talk, but may not start runtimes (default when the operator did not ask).
 *  - `instruct`→ it may address any agent, including the Showrunner, and write the store.
 *  - `full`    → it may additionally ask the supervisor to start an autostartable runtime.
 * Anything unrecognised degrades to `off` — an unknown value never grants more power.
 */
export function managerAutonomy(): ManagerAutonomy {
  const raw = clean(process.env.MANAGER_AUTONOMY)?.toLowerCase();
  if (raw === "full") return "full";
  if (raw === "instruct") return "instruct";
  return "off";
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
export function getServerSecret(
  key: "SUPABASE_SERVICE_ROLE_KEY" | "KAGGLE_API_TOKEN" | "YOUTUBE_CLIENT_SECRET" | "NVIDIA_API_KEY"
) {
  if (typeof window !== "undefined") throw new Error(`${key} is server-only`);
  return process.env[key];
}
