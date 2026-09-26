// Event helpers — shape audit events consistently.
// The real persistence is api/events (Supabase). These helpers keep callers honest.

import type { EventType } from "../domain/schemas.js";

export function eventPayload(type: EventType, data: Record<string, unknown> = {}): { type: EventType; payload: Record<string, unknown> } {
  return { type, payload: { ...data, at: new Date().toISOString() } };
}

export const EVT = {
  workerConnected: (workerId: string, meta?: Record<string, unknown>) =>
    eventPayload("worker.connected", { workerId, ...meta }),
  workerDisconnected: (workerId: string, reason?: string) =>
    eventPayload("worker.disconnected", { workerId, reason }),
  taskCreated: (taskId: string) => eventPayload("task.created", { taskId }),
  taskStarted: (taskId: string) => eventPayload("task.started", { taskId }),
  taskWaiting: (taskId: string, reason?: string) => eventPayload("task.waiting", { taskId, reason }),
  taskCompleted: (taskId: string) => eventPayload("task.completed", { taskId }),
  taskFailed: (taskId: string, error: string) => eventPayload("task.failed", { taskId, error }),
  artifactCreated: (artifactId: string, kind: string) => eventPayload("artifact.created", { artifactId, kind }),
  approvalRequested: (episodeId: string) => eventPayload("approval.requested", { episodeId }),
  approvalGranted: (episodeId: string) => eventPayload("approval.granted", { episodeId }),
  approvalRejected: (episodeId: string, note?: string) => eventPayload("approval.rejected", { episodeId, note }),
} as const;
