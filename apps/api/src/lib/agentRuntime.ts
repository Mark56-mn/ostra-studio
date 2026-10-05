// apps/api/src/lib/agentRuntime.ts
// Resolves WHICH real AI answers in the Agent Chat room, and calls it.
//
// Truth rules:
//  - The room prefers the project's own Script AI: the `script` worker that is genuinely ONLINE
//    (fresh heartbeat) in Supabase, reached at the tunnel endpoint it registered. No endpoint is
//    ever hard-coded.
//  - If no project worker is online, a hosted OpenAI-compatible fallback is used ONLY when
//    OPENAI_API_KEY is configured. Nothing is simulated: when there is no usable backend the caller
//    gets `available: false` plus the real reason, and the UI says so.
//  - Endpoint URLs (and any credential) are never returned to the client — only the host.
//  - A failed call reports the real transport/HTTP error. There is no fabricated answer.
//  - The model's thinking is returned alongside its answer (an explicit `reasoning_content`-style
//    field when the server sends one, otherwise Qwen3's inline thinking split out by the parser).
//    A model that did not think produces no reasoning at all — it is never invented.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  agentLabel,
  makeHealth,
  managerConfig,
  workerDisplayHealth,
  type AgentKind,
  type ProviderHealth,
  type WorkerHealthRow,
} from "@ostra/shared";

export type AgentBackendKind = "project_worker" | "hosted_fallback" | "hosted_manager";

/** A resolved, callable backend. `endpoint` is server-side only. */
export type AgentBackend = {
  kind: AgentBackendKind;
  provider: string;
  model: string;
  /** Base URL to POST to. Never sent to the browser. */
  endpoint: string;
  /** Host only, safe to display (null when the registered endpoint is not a URL). */
  endpointHost: string | null;
  /** Supabase worker row id, when the backend is a project worker. */
  workerId?: string | null;
};

/** One entry of "what we looked at", so an unavailable room can explain itself honestly. */
export type AgentCandidate = {
  workerId: string | null;
  provider: string;
  status: string;
  reason: string;
  endpointHost: string | null;
};

/** Client-safe description of the current backend situation. No secrets, no full URLs. */
export type AgentBackendStatus = {
  available: boolean;
  kind: AgentBackendKind | null;
  provider: string | null;
  model: string | null;
  endpointHost: string | null;
  detail: string;
  candidates: AgentCandidate[];
};

export type AgentMessage = { role: "system" | "user" | "assistant"; content: string };

export type AgentCallFailureCode = "UNREACHABLE" | "TIMEOUT" | "HTTP_ERROR" | "EMPTY_RESPONSE";

export type AgentChatResult =
  | {
      ok: true;
      content: string;
      /**
       * The model's separate reasoning channel, when the server exposes one (`reasoning_content`,
       * `reasoning`, `thinking`). null when it did not — Qwen3 instead writes its thinking inline in
       * `content`, which the parser splits off. Never fabricated.
       */
      reasoning: string | null;
      latencyMs: number;
      backend: AgentBackend;
    }
  | { ok: false; code: AgentCallFailureCode; error: string; httpStatus?: number; latencyMs: number; backend: AgentBackend };

const DEFAULT_HOSTED_MODEL = "gpt-4o-mini";

/** Hosted fallback is optional; the room works with the project worker alone. */
export function hostedFallbackConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

function timeoutMs(): number {
  const raw = parseInt(process.env.AGENT_TIMEOUT_MS ?? "120000", 10);
  if (!Number.isFinite(raw)) return 120_000;
  return Math.max(5_000, Math.min(300_000, raw));
}

function maxTokens(): number {
  const raw = parseInt(process.env.AGENT_MAX_TOKENS ?? "900", 10);
  if (!Number.isFinite(raw)) return 900;
  return Math.max(64, Math.min(8192, raw));
}

export function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

function hostedBackend(): AgentBackend {
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    kind: "hosted_fallback",
    provider: "openai",
    model: (process.env.OPENAI_CHAT_MODEL ?? DEFAULT_HOSTED_MODEL).trim() || DEFAULT_HOSTED_MODEL,
    endpoint: base,
    endpointHost: endpointHost(base),
    workerId: null,
  };
}

const WORKER_COLUMNS =
  "id, type, runtime, provider, model, status, endpoint, last_heartbeat_at, heartbeat_timeout_sec, error, error_code, error_message";

/**
 * Pick the backend for one call. Reads Supabase live — a worker that stopped heartbeating is
 * reported OFFLINE by `workerDisplayHealth`, so it is never chosen.
 *
 * `workerTypes` is a PRIORITY list: when two roles can serve the same call (e.g. a dedicated
 * `overseer` notebook, falling back to the `script` worker), the earlier type wins if it is ONLINE.
 * `label` is only used in the human-readable status text ("Script AI is ONLINE …").
 */
export async function resolveAgentBackendFor(
  supa: SupabaseClient,
  workerTypes: string | string[],
  opts: { label?: string } = {}
): Promise<{ backend: AgentBackend | null; status: AgentBackendStatus }> {
  const types = Array.isArray(workerTypes) ? workerTypes : [workerTypes];
  const label = opts.label ?? types[0] ?? "agent";
  const candidates: AgentCandidate[] = [];
  const { data, error } = await supa.from("workers").select(WORKER_COLUMNS).in("type", types);

  const rows = (data ?? []) as Array<WorkerHealthRow & { type?: string }>;
  // Rank by the requested priority so the first type that is ONLINE is the one chosen.
  const rank = new Map(types.map((t, i) => [t, i]));
  const byType = [...rows].sort((a, b) => (rank.get(a.type ?? "") ?? 99) - (rank.get(b.type ?? "") ?? 99));
  const online = byType
    .map((row) => ({ row, health: workerDisplayHealth(row) }))
    .filter(({ health }) => health.status === "ONLINE");

  for (const { row, health } of online) {
    candidates.push({
      workerId: (row.id as string) ?? null,
      provider: row.provider ?? label,
      status: "ONLINE",
      reason: health.reason ?? "heartbeat fresh",
      endpointHost: endpointHost(row.endpoint ?? null),
    });
  }
  for (const row of rows) {
    const health = workerDisplayHealth(row);
    if (health.status === "ONLINE") continue;
    candidates.push({
      workerId: (row.id as string) ?? null,
      provider: row.provider ?? label,
      status: health.status,
      reason: health.reason ?? "not available",
      endpointHost: endpointHost(row.endpoint ?? null),
    });
  }

  // Prefer a live project worker with a reachable endpoint registered.
  const usable = online.find(({ row }) => typeof row.endpoint === "string" && row.endpoint.trim().length > 0);
  if (usable) {
    const endpoint = usable.row.endpoint!.trim().replace(/\/+$/, "");
    const backend: AgentBackend = {
      kind: "project_worker",
      provider: usable.row.provider ?? "kaggle",
      model: usable.row.model ?? "Qwen/Qwen3-1.7B",
      endpoint,
      endpointHost: endpointHost(endpoint),
      workerId: (usable.row.id as string) ?? null,
    };
    return {
      backend,
      status: {
        available: true,
        kind: backend.kind,
        provider: backend.provider,
        model: backend.model,
        endpointHost: backend.endpointHost,
        detail: `${label} is ONLINE (${healthSummary(usable.row)}) at ${backend.endpointHost} — this is the project's own model.`,
        candidates,
      },
    };
  }

  if (hostedFallbackConfigured()) {
    const backend = hostedBackend();
    return {
      backend,
      status: {
        available: true,
        kind: backend.kind,
        provider: backend.provider,
        model: backend.model,
        endpointHost: backend.endpointHost,
        detail:
          rows.length === 0 && !error
            ? `No ${label} worker is registered, so the configured hosted fallback model answers.`
            : `No ${label} worker is ONLINE, so the configured hosted fallback model answers.`,
        candidates,
      },
    };
  }

  const reason = error
    ? `the worker registry could not be read (${error.message})`
    : rows.length === 0
      ? `no ${label} worker is registered yet — start the Kaggle runtime so the project's own model comes ONLINE`
      : `no ${label} worker is ONLINE (heartbeat expired or endpoint missing)`;
  return {
    backend: null,
    status: {
      available: false,
      kind: null,
      provider: null,
      model: null,
      endpointHost: null,
      detail: `${reason}. Add OPENAI_API_KEY on the backend if you want a hosted fallback to answer instead.`,
      candidates,
    },
  };
}

/** The Agent Chat room's backend: the project's own Script AI, else the hosted fallback. */
export function resolveAgentBackend(supa: SupabaseClient) {
  return resolveAgentBackendFor(supa, "script", { label: "Script AI" });
}

/**
 * The Management Team's backend. It is a HOSTED, OpenAI-compatible endpoint (MANAGER_API_KEY +
 * MANAGER_BASE_URL — OpenAI, Lightning AI, a gateway, …), so there is no worker row and no heartbeat:
 * its live state comes from a real completion call (see `probeHostedModel`), never from configuration
 * alone. Every other agent keeps using `resolveChannelBackend`.
 */
export function managerBackend(): AgentBackend {
  const cfg = managerConfig();
  const base = cfg.baseUrl!.replace(/\/+$/, "");
  return {
    kind: "hosted_manager",
    provider: cfg.provider,
    model: cfg.model!,
    endpoint: base,
    endpointHost: cfg.host,
    workerId: null,
  };
}

export function resolveManagerBackend(): { backend: AgentBackend | null; status: AgentBackendStatus } {
  const cfg = managerConfig();
  const candidates: AgentCandidate[] = [];
  if (!cfg.configured) {
    return {
      backend: null,
      status: {
        available: false,
        kind: null,
        provider: null,
        model: null,
        endpointHost: cfg.host,
        detail: cfg.reason ?? "the management team is not configured",
        candidates,
      },
    };
  }
  const backend = managerBackend();
  return {
    backend,
    status: {
      available: true,
      kind: backend.kind,
      provider: backend.provider,
      model: backend.model,
      endpointHost: backend.endpointHost,
      detail: `The management team is a hosted model at ${backend.endpointHost}. It is only reported ONLINE after a real completion call succeeds.`,
      candidates,
    },
  };
}

/**
 * Real liveness evidence for a hosted model: one tiny completion. The result is cached briefly so a
 * dashboard poll every few seconds does not turn into a billable call per render. Never throws —
 * the caller always gets a health object with the real failure reason.
 */
const HOSTED_PROBE_TTL_MS = 60_000;
const hostedProbeCache = new Map<string, { at: number; health: ProviderHealth }>();

/** Drop cached probes (tests / after an operator changes the manager key). */
export function clearHostedProbeCache(): void {
  hostedProbeCache.clear();
}

export async function probeHostedModel(
  backend: AgentBackend,
  opts: { timeoutMs?: number; nowMs?: number } = {}
): Promise<ProviderHealth> {
  const now = opts.nowMs ?? Date.now();
  const cacheKey = `${backend.endpoint}|${backend.model}`;
  const cached = hostedProbeCache.get(cacheKey);
  if (cached && now - cached.at < HOSTED_PROBE_TTL_MS) return cached.health;

  const started = Date.now();
  const health = await (async (): Promise<ProviderHealth> => {
    try {
      const res = await callAgent(
        backend,
        [
          { role: "system", content: "Answer with one short word." },
          { role: "user", content: "ping" },
        ],
        { temperature: 0, maxTokens: 8 }
      );
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return makeHealth("ERROR", {
          provider: backend.provider,
          reason: `hosted model did not answer — ${res.code}: ${res.error}`,
          latencyMs,
          detail: { model: backend.model, endpointHost: backend.endpointHost },
        });
      }
      return makeHealth("ONLINE", {
        provider: backend.provider,
        reason: `hosted model answered a real completion call in ${latencyMs}ms`,
        latencyMs,
        detail: { model: backend.model, endpointHost: backend.endpointHost, probedAt: new Date(now).toISOString() },
      });
    } catch (e) {
      return makeHealth("ERROR", {
        provider: backend.provider,
        reason: `hosted model probe failed: ${e instanceof Error ? e.message : String(e)}`,
        latencyMs: Date.now() - started,
        detail: { model: backend.model, endpointHost: backend.endpointHost },
      });
    }
  })();

  hostedProbeCache.set(cacheKey, { at: now, health });
  return health;
}

/**
 * The backend for a production-channel role. The Showrunner prefers a dedicated `overseer` notebook
 * and falls back to the Script AI worker (a real model, just not a dedicated overseer) — the status
 * `detail` always says which one actually answered.
 */
export function resolveChannelBackend(supa: SupabaseClient, agent: AgentKind) {
  if (agent === "manager") return resolveManagerBackend();
  if (agent === "overseer") {
    return resolveAgentBackendFor(supa, ["overseer", "script"], { label: "Showrunner" });
  }
  return resolveAgentBackendFor(supa, agent, { label: agentLabel(agent) });
}

function healthSummary(row: WorkerHealthRow): string {
  const h = workerDisplayHealth(row);
  const age = h.heartbeatAgeSec;
  return age == null ? "no heartbeat" : `heartbeat ${age}s ago`;
}

function readContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const fromMessage = first?.message?.content;
  if (typeof fromMessage === "string" && fromMessage.trim()) return fromMessage;
  // Some OpenAI-compatible servers (and every reasoning model behind them) return content as a list of
  // parts: [{"type":"text","text":"…"}]. Join the text parts instead of reporting an empty answer.
  if (Array.isArray(fromMessage)) {
    const text = fromMessage
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : ""
      )
      .join("")
      .trim();
    if (text) return text;
  }
  if (typeof first?.text === "string" && first.text.trim()) return first.text;
  // Some minimal servers return the raw string in `response`.
  const alt = (payload as { response?: unknown }).response;
  if (typeof alt === "string" && alt.trim()) return alt;
  return null;
}

/**
 * Pull a separate reasoning channel out of an OpenAI-compatible response, when the server exposes
 * one: `message.reasoning_content` (vLLM/DeepSeek-style), `message.reasoning` (OpenRouter-style) or
 * `message.thinking`. Returns null when the server sent none; Qwen3 instead writes ` thinking…</think>`
 * inline in `content`, which `parseAgentResponse` splits off by itself.
 */
function readReasoning(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  const first = Array.isArray(choices) && choices.length > 0 ? (choices[0] as Record<string, unknown>) : null;
  const message = (first?.message ?? null) as Record<string, unknown> | null;
  for (const value of [message?.reasoning_content, message?.reasoning, message?.thinking, first?.reasoning_content]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Call the resolved backend once. Every failure path reports what actually happened. */
export async function callAgent(
  backend: AgentBackend,
  messages: AgentMessage[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {}
): Promise<AgentChatResult> {
  const started = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // ngrok serves an interstitial HTML page to browser-like clients; this header skips it so the
    // worker's JSON API is reachable from the backend.
    "ngrok-skip-browser-warning": "1",
  };
  let body: Record<string, unknown>;

  if (backend.kind === "hosted_manager") {
    const key = managerConfig().apiKey;
    if (!key) {
      return {
        ok: false,
        code: "UNREACHABLE",
        error: "MANAGER_API_KEY is not configured on the backend",
        latencyMs: 0,
        backend,
      };
    }
    headers["Authorization"] = `Bearer ${key}`;
    body = {
      model: backend.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? maxTokens(),
      stream: false,
      response_format: { type: "json_object" },
    };
  } else if (backend.kind === "hosted_fallback") {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) {
      return {
        ok: false,
        code: "UNREACHABLE",
        error: "OPENAI_API_KEY is not configured on the backend",
        latencyMs: 0,
        backend,
      };
    }
    headers["Authorization"] = `Bearer ${key}`;
    body = {
      model: backend.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: maxTokens(),
      stream: false,
      response_format: { type: "json_object" },
    };
  } else {
    body = {
      model: backend.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: maxTokens(),
      stream: false,
    };
  }

  const hosted = backend.kind === "hosted_fallback" || backend.kind === "hosted_manager";
  const url = hosted ? `${backend.endpoint}/chat/completions` : `${backend.endpoint}/v1/chat/completions`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs()),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /abort|timeout/i.test(msg);
    return {
      ok: false,
      code: timedOut ? "TIMEOUT" : "UNREACHABLE",
      error: `${timedOut ? "timed out" : "could not be reached"}: ${msg}`,
      latencyMs: Date.now() - started,
      backend,
    };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      ok: false,
      code: "HTTP_ERROR",
      error: `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      httpStatus: res.status,
      latencyMs: Date.now() - started,
      backend,
    };
  }

  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    return {
      ok: false,
      code: "HTTP_ERROR",
      error: `response was not JSON: ${text.slice(0, 200)}`,
      latencyMs: Date.now() - started,
      backend,
    };
  }

  const content = readContent(json);
  if (!content) {
    return {
      ok: false,
      code: "EMPTY_RESPONSE",
      error: "the model returned no message content",
      latencyMs: Date.now() - started,
      backend,
    };
  }
  return { ok: true, content, reasoning: readReasoning(json), latencyMs: Date.now() - started, backend };
}

/** Client-safe projection of a backend (never the endpoint URL). */
export function publicBackend(backend: AgentBackend): {
  kind: AgentBackendKind;
  provider: string;
  model: string;
  endpointHost: string | null;
} {
  return {
    kind: backend.kind,
    provider: backend.provider,
    model: backend.model,
    endpointHost: backend.endpointHost,
  };
}
