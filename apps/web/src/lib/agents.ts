// apps/web/src/lib/agents.ts
// Client for the AI Studio channel routes on the Render API. No secrets, no mock data: every function
// returns what the backend actually said, and a failure is returned as a failure.
//
// Participant labels and the roster come from @ostra/shared so the UI and the backend prompts can
// never drift apart.

import { agentLabel, AGENT_ROSTER, type AgentKind } from "@ostra/shared";
import { apiFetch } from "./api";

export type { AgentKind };
export { agentLabel, AGENT_ROSTER };

export type StudioRoom = {
  id: string;
  project_id: string | null;
  title: string;
  kind: string;
  created_at: string;
  updated_at: string;
};

/** One roster role with its REAL live status. */
export type RosterEntry = {
  kind: AgentKind;
  label: string;
  workerType: string;
  specialty: string;
  accent: string;
  capabilities: string[];
  available: boolean;
  provider: string | null;
  model: string | null;
  endpointHost: string | null;
  detail: string;
  candidates: Array<{ workerId: string | null; provider: string; status: string; reason: string; endpointHost: string | null }>;
};

export type ChannelMessage = {
  id: string;
  room_id: string;
  project_id: string | null;
  from_agent: string;
  to_agent: string;
  kind: string;
  content: string;
  payload: Record<string, unknown> | null;
  status: "sent" | "delivered" | "failed" | "reported" | string;
  backend: { kind?: string; provider?: string; model?: string; endpointHost?: string | null; latencyMs?: number; parse?: string } | null;
  error: { code?: string; reason?: string } | null;
  created_at: string;
};

export type AgentTurnResult = {
  agent: AgentKind;
  ok: boolean;
  backend: { kind: string; provider: string; model: string; endpointHost: string | null } | null;
  latencyMs: number | null;
  reply: string | null;
  outgoing: number;
  applied: Array<{ op: string; ok: boolean; entity: string | null; ref: string | null; id: string | null; summary: string; error?: string }>;
  rejected: string[];
  error: string | null;
};

export type DispatchResponse = {
  turns: AgentTurnResult[];
  changed: number;
  failedWrites: number;
  messages: ChannelMessage[];
  roster: RosterEntry[];
};

export type ProjectRef = { id: string; slug: string; title: string };

// ── transport ────────────────────────────────────────────────────────────────
export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function readJson(res: Response): Promise<{ json: Record<string, unknown> | null; text: string }> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = text ? JSON.parse(text) : null;
    return { json: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null, text };
  } catch {
    return { json: null, text };
  }
}

function failure(res: Response, json: Record<string, unknown> | null, text: string): string {
  const err = typeof json?.error === "string" ? json.error : null;
  const reason = typeof json?.reason === "string" ? json.reason : null;
  if (err && reason) return `${err} — ${reason}`;
  if (reason) return reason;
  if (err) return err;
  return `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

export async function fetchRoster(): Promise<FetchResult<RosterEntry[]>> {
  try {
    const res = await apiFetch("/api/agents/roster");
    const { json, text } = await readJson(res);
    if (!res.ok) return { ok: false, error: failure(res, json, text) };
    return { ok: true, data: (json?.roster as RosterEntry[]) ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listStudioRooms(): Promise<FetchResult<StudioRoom[]>> {
  try {
    const res = await apiFetch("/api/agents/rooms");
    const { json, text } = await readJson(res);
    if (!res.ok) return { ok: false, error: failure(res, json, text) };
    return { ok: true, data: (json?.rooms as StudioRoom[]) ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createStudioRoom(projectId: string | null, title?: string): Promise<FetchResult<StudioRoom>> {
  try {
    const res = await apiFetch("/api/agents/rooms", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, title }),
    });
    const { json, text } = await readJson(res);
    if (!res.ok || !json?.room) return { ok: false, error: failure(res, json, text) };
    return { ok: true, data: json.room as StudioRoom };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function patchStudioRoom(
  roomId: string,
  patch: { project_id?: string | null; title?: string }
): Promise<FetchResult<StudioRoom>> {
  try {
    const res = await apiFetch(`/api/agents/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify(patch) });
    const { json, text } = await readJson(res);
    if (!res.ok || !json?.room) return { ok: false, error: failure(res, json, text) };
    return { ok: true, data: json.room as StudioRoom };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type ChannelSnapshot = { messages: ChannelMessage[]; roster: RosterEntry[]; room: StudioRoom | null };

export async function listChannel(roomId: string): Promise<FetchResult<ChannelSnapshot>> {
  try {
    const res = await apiFetch(`/api/agents/rooms/${roomId}/messages`);
    const { json, text } = await readJson(res);
    if (!res.ok) return { ok: false, error: failure(res, json, text) };
    return {
      ok: true,
      data: {
        messages: (json?.messages as ChannelMessage[]) ?? [],
        roster: (json?.roster as RosterEntry[]) ?? [],
        room: (json?.room as StudioRoom) ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function dispatchRound(
  roomId: string,
  body: { brief?: string; note?: string; overseer?: boolean } = {}
): Promise<FetchResult<DispatchResponse>> {
  try {
    const res = await apiFetch(`/api/agents/rooms/${roomId}/dispatch`, { method: "POST", body: JSON.stringify(body) });
    const { json, text } = await readJson(res);
    if (!res.ok) return { ok: false, error: failure(res, json, text) };
    return { ok: true, data: json as unknown as DispatchResponse };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── pure presentation helpers (unit-tested) ──────────────────────────────────

/** The accent class for a participant, falling back to a neutral tone for the director. */
export function participantAccent(kind: string): string {
  if (kind === "director") return "text-white";
  return AGENT_ROSTER.find((a) => a.kind === kind)?.accent ?? "text-zinc-300";
}

/** How a message status chip should read. A failed/unsettled message is never hidden. */
export function statusLabel(status: string): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  switch (status) {
    case "delivered":
      return { text: "delivered", tone: "ok" };
    case "reported":
      return { text: "to director", tone: "muted" };
    case "failed":
      return { text: "delivery failed", tone: "bad" };
    case "sent":
      return { text: "waiting", tone: "warn" };
    default:
      return { text: status, tone: "muted" };
  }
}

/** One sentence describing one agent's turn, built only from what really happened. */
export function turnSentence(turn: AgentTurnResult): string {
  const label = agentLabel(turn.agent);
  if (!turn.ok) return `${label} did not run — ${turn.error ?? "unknown reason"}`;
  const parts: string[] = [];
  parts.push(turn.reply ? "answered the director" : "sent no director reply");
  if (turn.outgoing > 0) parts.push(`messaged ${turn.outgoing} peer${turn.outgoing === 1 ? "" : "s"}`);
  const applied = turn.applied.filter((a) => a.ok).length;
  if (applied > 0) parts.push(`applied ${applied} store change${applied === 1 ? "" : "s"}`);
  const failed = turn.applied.length - applied;
  if (failed > 0) parts.push(`${failed} write${failed === 1 ? "" : "s"} refused`);
  if (turn.rejected.length > 0) parts.push(`ignored: ${turn.rejected.join(", ")}`);
  const backend = turn.backend ? ` · ${turn.backend.model}` : "";
  return `${label} ${parts.join(", ")}${backend}`;
}

/** The number of agents that actually answered in a round. */
export function answeredCount(turns: AgentTurnResult[]): number {
  return turns.filter((t) => t.ok).length;
}
