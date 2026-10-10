// apps/web/src/lib/seasons.ts
// Client for the SEASON-FIRST APPROVAL workflow (spec §5) and the in-app inbox. No secrets, no mock
// data: every function returns what the backend actually said, and a failure is a failure.

import { apiFetch } from "./api";

export type SeasonEpisode = { number: number; title: string; synopsis: string };
export type SeasonCharacter = { name: string; role: string | null; description: string | null };
export type SeasonAssumption = { question: string; assumption: string | null };

export type SeasonStatus = "draft" | "submitted" | "approved" | "changes_requested" | "rejected";

export type Season = {
  id: string;
  project_id: string;
  title: string;
  premise: string | null;
  episode_count: number;
  episodes: SeasonEpisode[];
  characters: SeasonCharacter[];
  world: Record<string, unknown>;
  arcs: string[];
  ending: string | null;
  assumptions: SeasonAssumption[];
  production_estimate: Record<string, unknown>;
  status: SeasonStatus;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
};

/** What the API says about production for a project — the same rule POST /api/tasks enforces. */
export type ProductionGate =
  | { allowed: true; seasonId: string | null; seasonTitle: string | null }
  | { allowed: false; reason: string; status: string };

export type Notification = {
  id: string;
  kind: string;
  project_id: string | null;
  season_id: string | null;
  title: string;
  body: string | null;
  severity: "info" | "warning" | "critical";
  requires_action: boolean;
  read_at: string | null;
  created_at: string;
};

export type SeasonPackage = {
  title: string;
  premise: string | null;
  episodes: SeasonEpisode[];
  characters: SeasonCharacter[];
  arcs: string[];
  ending: string | null;
  assumptions: SeasonAssumption[];
  productionEstimate: Record<string, unknown>;
};

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(path: string, init?: RequestInit, extract?: (json: Record<string, unknown>) => T): Promise<ApiResult<T>> {
  try {
    const res = await apiFetch(path, init);
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = typeof json?.error === "string" ? (json.error as string) : `HTTP ${res.status}`;
      const reason = typeof json?.reason === "string" ? (json.reason as string) : null;
      const details = Array.isArray(json?.details) ? (json.details as string[]).join("; ") : null;
      return { ok: false, error: [err, reason, details].filter(Boolean).join(" — ") };
    }
    if (!json) return { ok: false, error: `empty response (HTTP ${res.status})` };
    return { ok: true, data: (extract ? extract(json) : (json as unknown as T)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listSeasons(projectId?: string | null): Promise<ApiResult<{ seasons: Season[]; gates: Record<string, ProductionGate> }>> {
  const path = projectId ? `/api/seasons?projectId=${encodeURIComponent(projectId)}` : "/api/seasons";
  return call(path, undefined, (j) => ({
    seasons: (j.seasons as Season[]) ?? [],
    gates: (j.gates as Record<string, ProductionGate>) ?? {},
  }));
}

export function createSeason(projectId: string, pkg: SeasonPackage): Promise<ApiResult<Season>> {
  return call(
    "/api/seasons",
    { method: "POST", body: JSON.stringify({ project_id: projectId, package: pkg }) },
    (j) => j.season as Season
  );
}

export function submitSeason(id: string): Promise<ApiResult<Season>> {
  return call(`/api/seasons/${id}/submit`, { method: "POST" }, (j) => j.season as Season);
}

export function decideSeason(id: string, decision: "approved" | "changes_requested" | "rejected", note?: string): Promise<ApiResult<Season>> {
  return call(
    `/api/seasons/${id}/decision`,
    { method: "POST", body: JSON.stringify({ decision, note, decided_by: "director" }) },
    (j) => j.season as Season
  );
}

export function listNotifications(): Promise<ApiResult<{ notifications: Notification[]; unread: number }>> {
  return call("/api/notifications", undefined, (j) => ({
    notifications: (j.notifications as Notification[]) ?? [],
    unread: (j.unread as number) ?? 0,
  }));
}

export function markNotificationRead(id: string): Promise<ApiResult<{ id: string }>> {
  return call(`/api/notifications/${id}/read`, { method: "POST" }, (j) => ({ id: j.id as string }));
}

// ── presentation helpers (unit-tested) ──────────────────────────────────────

/** The one-line state of a season for a list row. Accepts a raw string so an unknown status from a
 *  newer backend is shown as itself rather than crashing the list. */
export function seasonStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "DRAFT — not submitted";
    case "submitted":
      return "WAITING FOR YOUR DECISION";
    case "approved":
      return "APPROVED — production allowed";
    case "changes_requested":
      return "CHANGES REQUESTED";
    case "rejected":
      return "REJECTED — no production";
    default:
      return status.toUpperCase();
  }
}

/** The gate line the operator reads: what is allowed, and exactly why not when it is not. */
export function gateLabel(gate: ProductionGate | undefined): { text: string; allowed: boolean } {
  if (!gate) return { text: "checking the season gate…", allowed: false };
  if (gate.allowed) return { text: `production allowed — approved season '${gate.seasonTitle ?? "untitled"}'`, allowed: true };
  return { text: gate.reason, allowed: false };
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
