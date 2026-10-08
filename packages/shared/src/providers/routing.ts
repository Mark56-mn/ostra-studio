// packages/shared/src/providers/routing.ts
// WHICH MODEL ANSWERS, per agent slot. One explicit, persisted operator decision — never inferred.
//
// Modes
//   own     → only the project's own runtime (Kaggle notebook / Colab). No hosted model is used, so a
//             room with nothing ONLINE says so instead of quietly answering from somebody's API.
//   auto    → the project's own runtime when it is genuinely ONLINE; otherwise the hosted backup
//             (NVIDIA NIM first, then the OPENAI_* fallback). This is the default.
//   nvidia  → every agent answers through NVIDIA NIM, regardless of runtime state.
//
// The resolver is pure so the rule is unit-testable without a database, a network or an env var, and
// "presence" is never treated as health: `nvidia` says a key is configured, the probe decides ONLINE.

export const ROUTING_MODES = ["own", "auto", "nvidia"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** Every slot the operator can route. `manager` is hosted-only, the rest are the four AI agents. */
export const ROUTABLE_SLOTS = ["script", "image", "voice", "overseer", "manager"] as const;
export type RoutableSlot = (typeof ROUTABLE_SLOTS)[number];

export function isRoutingMode(value: unknown): value is RoutingMode {
  return typeof value === "string" && (ROUTING_MODES as readonly string[]).includes(value);
}

export function isRoutableSlot(value: unknown): value is RoutableSlot {
  return typeof value === "string" && (ROUTABLE_SLOTS as readonly string[]).includes(value);
}

/** Stored routing decision. An absent slot follows the global `mode`. */
export type RoutingSettings = {
  mode: RoutingMode;
  slots: Partial<Record<RoutableSlot, RoutingMode>>;
  updatedAt: string | null;
  updatedBy: string | null;
};

export const DEFAULT_ROUTING: RoutingSettings = {
  mode: "auto",
  slots: {},
  updatedAt: null,
  updatedBy: null,
};

/** Anything unrecognised degrades to the default — an unknown value never grants a bigger change. */
export function normalizeRoutingMode(raw: unknown): RoutingMode {
  if (typeof raw !== "string") return DEFAULT_ROUTING.mode;
  const v = raw.trim().toLowerCase();
  return isRoutingMode(v) ? v : DEFAULT_ROUTING.mode;
}

/** Keep only known slots with a valid mode, so a hand-edited JSONB row cannot invent a slot. */
export function normalizeRoutingSlots(raw: unknown): Partial<Record<RoutableSlot, RoutingMode>> {
  const out: Partial<Record<RoutableSlot, RoutingMode>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const slot = key.trim().toLowerCase();
    if (!isRoutableSlot(slot)) continue;
    if (!isRoutingMode(value)) continue;
    out[slot] = value;
  }
  return out;
}

/** The effective mode for one slot: its own override, else the global mode. */
export function routingModeFor(settings: RoutingSettings | null | undefined, slot: string): RoutingMode {
  const s = settings ?? DEFAULT_ROUTING;
  const key = slot.trim().toLowerCase();
  if (isRoutableSlot(key) && s.slots[key]) return s.slots[key]!;
  return s.mode;
}

/** Who actually produces the answer. `none` means the request is refused, honestly. */
export type AnsweringProvider = "project" | "nvidia" | "openai" | "none";

export type RouteDecision = {
  provider: AnsweringProvider;
  /** Human-readable, secret-free explanation of the decision. Shown in the UI. */
  reason: string;
};

/**
 * Resolve one slot's answer source. `workerOnline` must come from a real heartbeat check and
 * `nvidiaConfigured`/`openaiConfigured` from real key presence — this function never probes.
 */
export function decideRoute(args: {
  mode: RoutingMode;
  /** Label used in the refusal text, e.g. "Script AI". */
  label: string;
  workerOnline: boolean;
  nvidiaConfigured: boolean;
  openaiConfigured: boolean;
}): RouteDecision {
  const { mode, label, workerOnline, nvidiaConfigured, openaiConfigured } = args;

  if (mode === "nvidia") {
    if (!nvidiaConfigured) {
      return {
        provider: "none",
        reason: `Every agent is routed to NVIDIA, but NVIDIA_API_KEY is not set on the backend — set it (or switch the routing mode back to auto).`,
      };
    }
    return { provider: "nvidia", reason: `Routing mode is "nvidia": ${label} answers from the NVIDIA NIM backup, even while a project runtime is ONLINE.` };
  }

  if (mode === "own") {
    if (workerOnline) return { provider: "project", reason: `${label} is ONLINE on its own runtime, and the routing mode is "own".` };
    return {
      provider: "none",
      reason: `Routing mode is "own": only project runtimes may answer, and no ${label} worker is ONLINE (fresh heartbeat + registered endpoint).`,
    };
  }

  // auto
  if (workerOnline) return { provider: "project", reason: `${label} is ONLINE on its own runtime — the project's own model answers first.` };
  if (nvidiaConfigured) return { provider: "nvidia", reason: `No ${label} worker is ONLINE, so the configured NVIDIA NIM backup answers.` };
  if (openaiConfigured) return { provider: "openai", reason: `No ${label} worker is ONLINE and no NVIDIA key is set, so the configured OPENAI_* fallback answers.` };
  return {
    provider: "none",
    reason: `No ${label} worker is ONLINE and no hosted backup is configured (set NVIDIA_API_KEY or OPENAI_API_KEY on the backend).`,
  };
}
