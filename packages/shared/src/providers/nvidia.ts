// packages/shared/src/providers/nvidia.ts
// NVIDIA NIM (build.nvidia.com) — the hosted "backup" model family for every Ostra agent.
//
// Why this file exists
//  - When a project runtime (Kaggle notebook / Colab) is not ONLINE the room has to answer from a
//    hosted model. NIM speaks the same OpenAI-compatible `POST {base}/chat/completions` contract the
//    project workers do, so the only thing that changes is which endpoint is called.
//  - Everything below is pure and enforced SERVER-SIDE, and each rule is a real security control,
//    not a comment:
//      1. ENDPOINT ALLOWLIST — the bearer key is never sent anywhere except an allowlisted NIM host.
//         A mis-set NVIDIA_BASE_URL therefore cannot exfiltrate the operator's key.
//      2. MODEL ALLOWLIST — only catalog model ids are dispatchable. An unknown id is refused with
//         the allowed list instead of being forwarded, so a typo'd/hostile model id cannot turn into
//         an arbitrary upstream call.
//      3. REASONING KWARG SHAPE — reasoning is requested with the switch the chosen model actually
//         understands (Qwen3/Nemotron: `enable_thinking`). A kwarg a model does not know is a 400 and
//         a silently broken agent, so it is per-model data, never a guess.
//  - No secret ever appears in this module: the API key is read from the environment by the caller
//    (see ../../lib/env.ts) and only ever placed in an Authorization header.

/** Verified NIM chat-completions base URL (the OpenAI-compatible surface). */
export const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Hosts the NVIDIA bearer key may be sent to. Anything else is refused BEFORE the request is made,
 * so a wrong/overridden base URL cannot leak the key.
 */
export const NVIDIA_ALLOWED_HOSTS = ["integrate.api.nvidia.com", "api.nvidia.com"] as const;

/** One vetted NIM chat model. `thinkingKwargs` is the model's OWN reasoning switch (null ⇒ none). */
export type NvidiaModelEntry = {
  /** Exact `publisher/model` id as listed on build.nvidia.com. */
  id: string;
  label: string;
  /** Inner `chat_template_kwargs` that turn reasoning on, or null when the model has no switch. */
  thinkingKwargs: Record<string, unknown> | null;
  /** Non-secret operational description (still not a promise that the account has credits). */
  note: string;
};

/**
 * The vetted catalog. Model ids are copied from NVIDIA's published catalog; the hosted catalog
 * changes over time, so an operator who needs a different id adds it here (a deliberate, reviewable
 * change) rather than pointing the backend at an arbitrary model string.
 */
export const NVIDIA_MODEL_CATALOG: readonly NvidiaModelEntry[] = [
  {
    id: "meta/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B Instruct",
    thinkingKwargs: null,
    note: "Fast general-purpose default. Answers without a separate reasoning channel.",
  },
  {
    id: "meta/llama-3.1-8b-instruct",
    label: "Llama 3.1 8B Instruct",
    thinkingKwargs: null,
    note: "Smallest/fastest. Good for cheap fallback chatter, weakest at long-form planning.",
  },
  {
    id: "qwen/qwen3-next-80b-a3b-instruct",
    label: "Qwen3 Next 80B A3B",
    thinkingKwargs: { enable_thinking: true },
    note: "Reasoning-capable: its thinking is requested explicitly and shown as its own block.",
  },
  {
    id: "deepseek-ai/deepseek-r1",
    label: "DeepSeek R1",
    thinkingKwargs: null,
    note: "Always reasons; the separate reasoning channel is surfaced when the server returns one. Slower.",
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron 3 Super 120B",
    thinkingKwargs: { enable_thinking: true },
    note: "Large reasoning-capable NVIDIA model; slower and heavier on credits.",
  },
  {
    id: "qwen/qwen2.5-coder-32b-instruct",
    label: "Qwen2.5 Coder 32B Instruct",
    thinkingKwargs: null,
    note: "Code-oriented; useful when an agent work product is structured data.",
  },
];

/** The catalog entry for an exact model id, or null when the id is not allowed. */
export function nvidiaModelEntry(id: string | null | undefined): NvidiaModelEntry | null {
  if (!id) return null;
  const wanted = id.trim();
  return NVIDIA_MODEL_CATALOG.find((m) => m.id === wanted) ?? null;
}

/** Every allowed model id (used in honest refusal messages). */
export function nvidiaModelIds(): string[] {
  return NVIDIA_MODEL_CATALOG.map((m) => m.id);
}

/** Default model when the operator has not chosen one. */
export const NVIDIA_DEFAULT_MODEL = "meta/llama-3.3-70b-instruct";

/**
 * Is this base URL one the NVIDIA key may be sent to? Parsed with `URL`, so `evil.com/#x` tricks and
 * userinfo (`https://key@evil.com`) cannot slip through, and the scheme must be https.
 */
export function isAllowedNvidiaEndpoint(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  return (NVIDIA_ALLOWED_HOSTS as readonly string[]).includes(host);
}

/** The host of a base URL, safe to show in the UI (null when it is not a URL). */
export function nvidiaEndpointHost(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

/**
 * The exact request body for one NIM call.
 *
 *  - `chat_template_kwargs` is only attached when the operator asked for thinking AND the chosen
 *    model actually documents the switch; otherwise the body stays a plain OpenAI-compatible one.
 *  - `response_format` is deliberately NEVER set: forcing JSON mode suppresses a reasoning model's
 *    thinking channel, and not every NIM model implements json_object. The agent parser already
 *    accepts a fenced/prose answer, so the envelope survives either way.
 *  - `max_tokens` is floored for reasoning models, because thinking and the answer share the budget.
 */
export function buildNvidiaRequestBody(args: {
  model: NvidiaModelEntry;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens: number;
  thinking: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.model.id,
    messages: args.messages,
    temperature: args.temperature ?? 0.4,
    max_tokens: args.model.thinkingKwargs && args.thinking ? Math.max(args.maxTokens, 2048) : args.maxTokens,
    stream: false,
  };
  if (args.thinking && args.model.thinkingKwargs) body["chat_template_kwargs"] = args.model.thinkingKwargs;
  return body;
}
