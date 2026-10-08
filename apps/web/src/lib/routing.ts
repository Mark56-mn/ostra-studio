// apps/web/src/lib/routing.ts
// Client for the provider-routing switch (GET /api/routing, PATCH /api/routing).
// The dashboard never guesses: the mode, the per-slot answer source and the NVIDIA probe health all
// come from the Render API, and a failure is returned as a failure.

import { apiUrl } from "./api";
import type { ProviderHealth } from "./health";

export type RoutingMode = "own" | "auto" | "nvidia";
export type RoutableSlot = "script" | "image" | "voice" | "overseer" | "manager";

export const ROUTING_MODE_LABEL: Record<RoutingMode, string> = {
  own: "Own models only",
  auto: "Auto — own first, backup second",
  nvidia: "NVIDIA for everything",
};

export const ROUTING_MODE_HINT: Record<RoutingMode, string> = {
  own: "Only the project's own Kaggle/Colab runtime may answer. If nothing is ONLINE the room says so instead of using a hosted API.",
  auto: "The project's own runtime answers when it is genuinely ONLINE; otherwise the hosted backup does (NVIDIA first, then OPENAI_*).",
  nvidia: "Every agent answers through NVIDIA NIM, even while a project runtime is ONLINE.",
};

export type RoutingSettings = {
  mode: RoutingMode;
  slots: Partial<Record<RoutableSlot, RoutingMode>>;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type NvidiaModelOption = { id: string; label: string; thinking: boolean; note: string };

export type NVIDIAStatus = {
  configured: boolean;
  host: string | null;
  model: string;
  thinking: boolean;
  reason: string | null;
  /** Real completion probe (cached ~60s on the backend). Null when no key is configured. */
  health: ProviderHealth | null;
  catalog: NvidiaModelOption[];
};

export type SlotRouteView = {
  slot: RoutableSlot;
  mode: string;
  available: boolean;
  kind: string | null;
  provider: string | null;
  model: string | null;
  endpointHost: string | null;
  detail: string;
};

export type RoutingView = {
  settings: RoutingSettings;
  read_reason: string | null;
  nvidia: NVIDIAStatus;
  slots: SlotRouteView[];
};

export type RoutingResult =
  | { ok: true; data: RoutingView }
  | { ok: false; error: string };

async function readJson(res: Response): Promise<{ json: Record<string, unknown> | null; text: string }> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = text ? JSON.parse(text) : null;
    return { json: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null, text };
  } catch {
    return { json: null, text };
  }
}

function failure(json: Record<string, unknown> | null, text: string, status: number): string {
  const err = typeof json?.error === "string" ? json.error : null;
  const reason = typeof json?.reason === "string" ? json.reason : null;
  if (err && reason) return `${err} — ${reason}`;
  return err ?? reason ?? `HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

export async function fetchRouting(): Promise<RoutingResult> {
  try {
    const res = await fetch(apiUrl("/api/routing"), { cache: "no-store" });
    const { json, text } = await readJson(res);
    if (!res.ok || !json) return { ok: false, error: failure(json, text, res.status) };
    return { ok: true, data: json as unknown as RoutingView };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type RoutingPatch = { mode?: RoutingMode } | { slot: RoutableSlot; slotMode: RoutingMode | null };

export async function saveRouting(patch: RoutingPatch): Promise<RoutingResult> {
  try {
    const res = await fetch(apiUrl("/api/routing"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const { json, text } = await readJson(res);
    if (!res.ok || !json) return { ok: false, error: failure(json, text, res.status) };
    return { ok: true, data: json as unknown as RoutingView };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── pure presentation helpers (unit-tested) ──────────────────────────────────

/** One line describing what answers a slot right now, from what the backend actually reported. */
export function slotAnswerLabel(row: SlotRouteView): string {
  if (!row.available || !row.provider) return "nothing will answer";
  if (row.kind === "project_worker") return `${row.provider} · own runtime`;
  if (row.kind === "hosted_nvidia") return `NVIDIA NIM · backup`;
  if (row.kind === "hosted_manager") return `${row.provider} · hosted management team`;
  return `${row.provider} · hosted backup`;
}

/** The mode a slot's select should show: its own override, or "" when it inherits the global mode. */
export function slotOverride(settings: RoutingSettings, slot: RoutableSlot): RoutingMode | "" {
  return settings.slots[slot] ?? "";
}

export const SLOT_LABEL: Record<RoutableSlot, string> = {
  manager: "Management Team",
  script: "Script AI",
  image: "Image AI",
  voice: "Voice AI",
  overseer: "Showrunner",
};
