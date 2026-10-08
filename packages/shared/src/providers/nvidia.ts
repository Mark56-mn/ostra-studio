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
 * The vetted catalog — THE DISPATCH ALLOWLIST. Model ids are copied from NVIDIA's published catalog;
 * the hosted catalog changes over time, so an operator who needs a different id adds it here (a
 * deliberate, reviewable change) rather than pointing the backend at an arbitrary model string.
 *
 * A retired id must NEVER sit in here. A dead pin is worse than a missing one: it passes every config
 * check, answers nothing, and spends a retry slot plus a share of the caller's deadline on every
 * request forever. Retired ids are recorded in `NVIDIA_RETIRED_MODELS` instead, so a stale env pin
 * gets a precise re-pin instruction instead of a mystery.
 *
 * Each `note` says whether the id was checked against the live account (a `GET /v1/models` plus a real
 * completion), because a listed model is not necessarily a model this key can call.
 */
//
// Every entry below was verified CALLABLE on the operator's own key on 2026-10-08 — a real
// `POST /chat/completions` that returned content — not merely "present in GET /v1/models". Those are
// different things and the difference is the whole lesson: on that date seven catalogued ids were
// listed live but answered `404 Function … not found for account`, i.e. listed ≠ callable by this key.
// The measured latency in each note is from that same probe run, so the notes are evidence, not
// marketing.
export const NVIDIA_MODEL_CATALOG: readonly NvidiaModelEntry[] = [
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron 3 Super 120B",
    thinkingKwargs: { enable_thinking: true },
    note: "The shipped default. Callable 2026-10-08 (~1.1s) and it answers WITH the documented enable_thinking switch, returning a real reasoning channel (~135 chars) — so thinking-on requests work.",
  },
  {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    label: "Nemotron 3.5 Lightning 30B",
    thinkingKwargs: { enable_thinking: true },
    note: "Smallest/fastest Nemotron 3 lane, for cheap fallback chatter. Callable 2026-10-08 (~3.4s) with enable_thinking and a reasoning channel.",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    label: "Nemotron 3 Ultra 550B",
    thinkingKwargs: { enable_thinking: true },
    note: "Largest Nemotron 3 lane. Callable 2026-10-08 (~15s) with enable_thinking, but one probe that day hit 503 'Service temporarily overloaded' — heaviest and most contended lane, not a good default.",
  },
  {
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    thinkingKwargs: null,
    note: "Fastest verified lane: callable 2026-10-08 in ~0.9s. Returns a reasoning channel on its own, with no chat_template_kwargs needed, so none are sent.",
  },
  {
    id: "moonshotai/kimi-k3",
    label: "Kimi K3",
    thinkingKwargs: null,
    note: "Callable 2026-10-08 but by far the slowest measured (~29s) — avoid it for latency-sensitive slots. No template kwarg is sent; a reasoning channel comes back anyway.",
  },
];

/** One id NVIDIA has end-of-lifed, kept only to turn a stale pin into an actionable message. */
export type NvidiaRetiredModel = {
  id: string;
  /** The EOL date NVIDIA reported in the 410 body, or null when the id went without a live check. */
  retiredOn: string | null;
  /** A live catalog id to pin instead. */
  successor: string;
  note: string;
};

/**
 * Ids a live request can never succeed against. They are NOT dispatchable and never re-added blindly:
 *
 *  - `meta/llama-3.3-70b-instruct` was this project's shipped default until 2026-08-26, when NVIDIA
 *    end-of-lifed it. Every call now answers `410 Gone: … reached its end of life on
 *    2026-08-26T09:00:00Z`. The same batch also took `meta/llama-4-maverick-17b-128e-instruct`.
 *  - the three Qwen/DeepSeek ids this catalog used to ship (`qwen/qwen3-next-80b-a3b-instruct`,
 *    `deepseek-ai/deepseek-r1`, `qwen/qwen2.5-coder-32b-instruct`) and `meta/llama-3.1-8b-instruct`
 *    were each confirmed GONE from the live account's `GET /v1/models` on 2026-10-08 — they are in no
 *    list, so no per-id EOL date was ever reported. `retiredOn` stays null for those and the note says
 *    what was actually observed: absent from the live catalog on that date.
 *
 * Re-pinning is the operator's job, and it is one env var: `NVIDIA_CHAT_MODEL` for every slot, or
 * `NVIDIA_MODEL_<SLOT>` for one.
 */
export const NVIDIA_RETIRED_MODELS: readonly NvidiaRetiredModel[] = [
  {
    id: "meta/llama-3.3-70b-instruct",
    retiredOn: "2026-08-26",
    successor: "nvidia/nemotron-3-super-120b-a12b",
    note: "This was the shipped default. NVIDIA answers every request with 410 Gone, permanently.",
  },
  {
    id: "meta/llama-3.1-8b-instruct",
    retiredOn: null,
    successor: "nvidia/nemotron-3.5-lightning-30b-a3b",
    note: "Absent from the live account catalog on 2026-10-08 (no EOL date was ever reported for this id). Do not re-add it without a live check.",
  },
  {
    id: "qwen/qwen3-next-80b-a3b-instruct",
    retiredOn: null,
    successor: "nvidia/nemotron-3-super-120b-a12b",
    note: "Absent from the live account catalog on 2026-10-08; it was the reasoning lane this catalog shipped.",
  },
  {
    id: "deepseek-ai/deepseek-r1",
    retiredOn: null,
    successor: "nvidia/nemotron-3-super-120b-a12b",
    note: "Absent from the live account catalog on 2026-10-08.",
  },
  {
    id: "qwen/qwen2.5-coder-32b-instruct",
    retiredOn: null,
    successor: "openai/gpt-oss-20b",
    note: "Absent from the live account catalog on 2026-10-08. No code-specialised lane could be verified callable that day, so the successor is the fastest verified general one.",
  },
];

/** The retirement record for an exact id, or null when the id was not retired by us. */
export function nvidiaRetiredModel(id: string | null | undefined): NvidiaRetiredModel | null {
  if (!id) return null;
  const wanted = id.trim();
  return NVIDIA_RETIRED_MODELS.find((m) => m.id === wanted) ?? null;
}

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

/**
 * Default model when the operator has not chosen one. It is the single source of truth (env.ts and
 * the tests import it rather than restating the string), and it must be in the catalog above — a
 * default that is not dispatchable would make every backup call a refusal.
 */
export const NVIDIA_DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";

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
