// apps/web/src/lib/chat.ts
// Client for the Agent Chat routes on the Render API. No secrets, no mock data: every function
// returns what the backend actually said, and a failure is returned as a failure.

import { apiFetch } from "./api";

export type ChatRoom = {
  id: string;
  project_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
};

export type AppliedAction = {
  op: string;
  ok: boolean;
  entity: string | null;
  ref: string | null;
  id: string | null;
  summary: string;
  error?: string;
};

export type ChatBackend = {
  kind: "project_worker" | "hosted_nvidia" | "hosted_fallback" | "hosted_manager";
  provider: string;
  model: string;
  endpointHost: string | null;
  latencyMs?: number;
  parse?: "json" | "text_fallback";
};

export type AgentCandidate = {
  workerId: string | null;
  provider: string;
  status: string;
  reason: string;
  endpointHost: string | null;
};

/** What the backend says about the AI that would answer right now. */
export type AgentStatus = {
  available: boolean;
  kind: "project_worker" | "hosted_nvidia" | "hosted_fallback" | "hosted_manager" | null;
  provider: string | null;
  model: string | null;
  endpointHost: string | null;
  detail: string;
  candidates: AgentCandidate[];
};

export type ChatMessage = {
  id: string;
  room_id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * The model's own thinking for this turn, when the backend produced it. null means the model
   * answered without a separate reasoning trace — the UI then shows no thinking block.
   */
  reasoning: string | null;
  actions: AppliedAction[];
  backend: ChatBackend | null;
  error: { code?: string; reason?: string } | null;
  created_at: string;
};

export type StoreSnapshot = {
  project: { id: string; slug: string; title: string; logline: string | null; story_bible: Record<string, unknown> } | null;
  characters: Array<{ name: string; role: string | null; description: string | null }>;
  locations: Array<{ name: string; description: string | null }>;
  episodes: Array<{ number: number; title: string; status: string; concept: string | null }>;
  scenes: Array<{ episode_number: number; index: number; title: string | null }>;
  taken_at: string;
};

export type ProjectRef = { id: string; slug: string; title: string };

export type SendResponse = {
  user_message: ChatMessage;
  message: ChatMessage;
  applied: AppliedAction[];
  store: { changed: number; failed: number };
  backend: ChatBackend;
  agent: AgentStatus;
  rejected: string[];
};

// ── transport ────────────────────────────────────────────────────────────────
export type ChatFetch<T> = { ok: true; data: T } | { ok: false; error: string };

export type SendResult =
  | { ok: true; data: SendResponse }
  /**
   * The turn failed. `userMessage` is present only when the backend stored the human's message
   * before the AI call failed (it always tries) — so the transcript can show what was said with an
   * honest error, and never a fabricated answer.
   */
  | {
      ok: false;
      error: string;
      code: string | null;
      /** The backend's real Retry-After (seconds) when it refused with 429 RATE_LIMITED. */
      retryAfterSec: number | null;
      userMessage: ChatMessage | null;
      agent: AgentStatus | null;
    };

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

export async function listRooms(): Promise<ChatFetch<ChatRoom[]>> {
  try {
    const res = await apiFetch("/api/chat/rooms");
    const { json, text } = await readJson(res);
    if (!res.ok) return { ok: false, error: failure(res, json, text) };
    return { ok: true, data: (json?.rooms as ChatRoom[]) ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createRoom(projectId: string | null, title?: string): Promise<ChatFetch<ChatRoom>> {
  try {
    const res = await apiFetch("/api/chat/rooms", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, title }),
    });
    const { json, text } = await readJson(res);
    if (!res.ok || !json?.room) return { ok: false, error: failure(res, json, text) };
    return { ok: true, data: json.room as ChatRoom };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function patchRoom(
  roomId: string,
  patch: { project_id?: string | null; title?: string }
): Promise<ChatFetch<ChatRoom>> {
  try {
    const res = await apiFetch(`/api/chat/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify(patch) });
    const { json, text } = await readJson(res);
    if (!res.ok || !json?.room) return { ok: false, error: failure(res, json, text) };
    return { ok: true, data: json.room as ChatRoom };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type RoomTranscript = { messages: ChatMessage[]; agent: AgentStatus | null; room: ChatRoom | null };

export async function listMessages(roomId: string): Promise<ChatFetch<RoomTranscript>> {
  try {
    const res = await apiFetch(`/api/chat/rooms/${roomId}/messages`);
    const { json, text } = await readJson(res);
    if (!res.ok) return { ok: false, error: failure(res, json, text) };
    return {
      ok: true,
      data: {
        messages: (json?.messages as ChatMessage[]) ?? [],
        agent: (json?.agent as AgentStatus) ?? null,
        room: (json?.room as ChatRoom) ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendMessage(roomId: string, content: string): Promise<SendResult> {
  try {
    const res = await apiFetch(`/api/chat/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    const { json, text } = await readJson(res);
    if (res.ok && json?.message) {
      return { ok: true, data: json as unknown as SendResponse };
    }
    const retry = json?.retry_after_sec;
    return {
      ok: false,
      error: failure(res, json, text),
      code: typeof json?.error === "string" ? json.error : null,
      retryAfterSec: typeof retry === "number" && Number.isFinite(retry) ? retry : null,
      userMessage: (json?.user_message as ChatMessage) ?? null,
      agent: (json?.agent as AgentStatus) ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      code: null,
      retryAfterSec: null,
      userMessage: null,
      agent: null,
    };
  }
}

export async function fetchStore(projectId: string | null): Promise<ChatFetch<{ projects: ProjectRef[]; snapshot: StoreSnapshot | null }>> {
  try {
    const path = projectId ? `/api/chat/store?projectId=${encodeURIComponent(projectId)}` : "/api/chat/store";
    const res = await apiFetch(path);
    const { json, text } = await readJson(res);
    if (!res.ok) return { ok: false, error: failure(res, json, text) };
    return {
      ok: true,
      data: {
        projects: (json?.projects as ProjectRef[]) ?? [],
        snapshot: (json?.snapshot as StoreSnapshot) ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── pure presentation helpers (unit-tested) ──────────────────────────────────

/**
 * Merge a freshly fetched transcript into the one on screen: newest server state wins, duplicates
 * are dropped by id and the order is stable ascending by `created_at`.
 */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of [...existing, ...incoming]) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return ta - tb;
  });
}

/** One line describing what the agent actually changed in the store. */
export function actionLabel(action: AppliedAction): string {
  if (action.ok) return action.summary;
  return `${action.op} failed — ${action.error ?? "unknown error"}`;
}

/** How a change chip should be coloured. Failed writes are always visible, never hidden. */
export function actionTone(action: AppliedAction): "ok" | "bad" {
  return action.ok ? "ok" : "bad";
}

/** Short label for the model that produced an answer. Names the real answer source. */
export function backendLabel(backend: ChatBackend | null): string | null {
  if (!backend) return null;
  const where =
    backend.kind === "project_worker"
      ? "project runtime"
      : backend.kind === "hosted_nvidia"
        ? "NVIDIA backup"
        : backend.kind === "hosted_manager"
          ? "hosted management team"
          : "hosted fallback";
  return `${backend.model} · ${where}`;
}

export function formatClock(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Approximate word count of a reasoning trace, used for the collapsed "thinking" label. */
export function reasoningWords(reasoning: string | null | undefined): number {
  const text = (reasoning ?? "").trim();
  if (!text) return 0;
  return text.split(/\s+/).length;
}
