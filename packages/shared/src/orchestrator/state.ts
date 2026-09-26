// Orchestrator state — pure, testable, no I/O.
// Every transition is validated here; handlers that touch Supabase just call these.

// ── Worker status ────────────────────────────────────────────────────────────
export type WorkerStatus =
  | "OFFLINE" | "CONNECTING" | "ONLINE" | "IDLE"
  | "QUEUED" | "WORKING" | "WAITING" | "COMPLETED" | "FAILED" | "RETRYING";

const workerTransitions: Record<WorkerStatus, WorkerStatus[]> = {
  OFFLINE:    ["CONNECTING"],
  CONNECTING: ["ONLINE","OFFLINE","FAILED"],
  ONLINE:     ["IDLE","OFFLINE","FAILED"],
  IDLE:       ["QUEUED","WORKING","OFFLINE"],
  QUEUED:     ["WORKING","FAILED","OFFLINE"],
  WORKING:    ["WAITING","COMPLETED","FAILED","RETRYING","IDLE","OFFLINE"],
  WAITING:    ["WORKING","FAILED","RETRYING","OFFLINE"],
  COMPLETED:  ["IDLE","OFFLINE"],
  FAILED:     ["RETRYING","OFFLINE","IDLE"],
  RETRYING:   ["CONNECTING","QUEUED","WORKING","FAILED","OFFLINE"],
};
export function canTransitionWorker(from: WorkerStatus, to: WorkerStatus): boolean {
  return (workerTransitions[from] ?? []).includes(to);
}
export function assertWorkerTransition(from: WorkerStatus, to: WorkerStatus) {
  if (!canTransitionWorker(from, to)) throw new Error(`Illegal worker transition ${from} → ${to}`);
}

// ── Task status ──────────────────────────────────────────────────────────────
export type TaskStatus = "pending"|"queued"|"working"|"waiting"|"completed"|"failed"|"retrying"|"cancelled";
const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  pending:   ["queued","cancelled"],
  queued:    ["working","failed","cancelled"],
  working:   ["waiting","completed","failed","retrying","cancelled"],
  waiting:   ["working","failed","retrying","cancelled"],
  completed: [],
  failed:    ["retrying","cancelled"],
  retrying:  ["queued","working","failed","cancelled"],
  cancelled: [],
};
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return (taskTransitions[from] ?? []).includes(to);
}
export function assertTaskTransition(from: TaskStatus, to: TaskStatus) {
  if (!canTransitionTask(from, to)) throw new Error(`Illegal task transition ${from} → ${to}`);
}
export function canRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

// ── Episode status ───────────────────────────────────────────────────────────
export type EpisodeStatus =
  | "idea"|"writing"|"scenes"|"imaging"|"voicing"|"rendering"|"qc"|"ready_for_review"|"approved"|"uploading"|"published"|"archived";

const episodeOrder: EpisodeStatus[] = ["idea","writing","scenes","imaging","voicing","rendering","qc","ready_for_review","approved","uploading","published"];
export function episodeIndex(s: EpisodeStatus): number { return episodeOrder.indexOf(s); }
export function isTerminalEpisodeStatus(s: EpisodeStatus): boolean { return s === "published" || s === "archived"; }
export function canAdvanceEpisode(from: EpisodeStatus, to: EpisodeStatus): boolean {
  const a = episodeOrder.indexOf(from), b = episodeOrder.indexOf(to);
  if (a === -1 || b === -1) return false;
  // allow forward step or rewind for revision; forbid jumping over the approval gate
  if (b === a + 1) return true;
  if (b < a) return true; // revision — orchestrator must log an event for this
  return false;
}

// ── Approval gate ────────────────────────────────────────────────────────────
export function isPublishBlocked(autoPublish: boolean, approvalDecision: string | null | undefined): boolean {
  if (autoPublish) return false;
  return approvalDecision !== "approved";
}

// ── Dependency check ─────────────────────────────────────────────────────────
export function dependenciesSatisfied(deps: string[] | null | undefined, completedIds: Set<string>): boolean {
  if (!deps || deps.length === 0) return true;
  return deps.every(id => completedIds.has(id));
}

// ── Heartbeat staleness ──────────────────────────────────────────────────────
export function isHeartbeatStale(lastHeartbeatAt: string | null | undefined, nowMs = Date.now(), thresholdMs = 60_000): boolean {
  if (!lastHeartbeatAt) return true;
  return nowMs - new Date(lastHeartbeatAt).getTime() > thresholdMs;
}
