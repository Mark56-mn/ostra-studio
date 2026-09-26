// Domain schemas — Zod + TypeScript types
// Source of truth for the Ostra control plane. The SQL migrations mirror these names.
import { z } from "zod";

// ── enums ────────────────────────────────────────────────────────────────────
export const workerTypeSchema = z.enum(["script", "image", "voice", "video", "youtube"]);
export const workerStatusSchema = z.enum([
  "OFFLINE","CONNECTING","ONLINE","IDLE","QUEUED","WORKING","WAITING","COMPLETED","FAILED","RETRYING",
]);
export const taskTypeSchema = z.enum([
  "script.develop","script.outline","script.write","script.scene_breakdown","script.image_spec","script.narration",
  "image.generate","image.thumbnail",
  "voice.narration","voice.dialogue",
  "video.render","video.rerender",
  "youtube.upload",
  "qc.check","approval.request",
]);
export const taskStatusSchema = z.enum(["pending","queued","working","waiting","completed","failed","retrying","cancelled"]);
export const eventTypeSchema = z.enum([
  "worker.connected","worker.disconnected","worker.heartbeat",
  "task.created","task.started","task.waiting","task.completed","task.failed","task.retried",
  "artifact.created","artifact.versioned",
  "agent.message",
  "approval.requested","approval.granted","approval.rejected",
  "episode.created","episode.updated",
  "youtube.upload.started","youtube.upload.completed","youtube.upload.failed",
]);
export const approvalDecisionSchema = z.enum(["pending","approved","rejected","changes_requested"]);
export const episodeStatusSchema = z.enum([
  "idea","writing","scenes","imaging","voicing","rendering","qc","ready_for_review","approved","uploading","published","archived"
]);
export const artifactKindSchema = z.enum([
  "script","outline","scene_spec","image","narration","audio","subtitle","thumbnail","draft_video","final_video","qc_report","other"
]);
export const pipelineStepSchema = z.enum([
  "IDEA","SCRIPT","SCENES","IMAGES","VOICE","VIDEO","QC","REVIEW","YOUTUBE"
]);

// Deriving TS types
export type WorkerType = z.infer<typeof workerTypeSchema>;
export type WorkerStatus = z.infer<typeof workerStatusSchema>;
export type TaskType = z.infer<typeof taskTypeSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type EpisodeStatus = z.infer<typeof episodeStatusSchema>;
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type PipelineStep = z.infer<typeof pipelineStepSchema>;

// ── entities ─────────────────────────────────────────────────────────────────
export const storyBibleSchema = z.object({
  premise: z.string().optional(),
  worldRules: z.string().optional(),
  timeline: z.string().optional(),
  arcs: z.array(z.string()).optional(),
  visualStyle: z.string().optional(),
  productionSettings: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const projectSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(2).max(64),
  title: z.string().min(1).max(120),
  logline: z.string().max(500).nullable().optional(),
  story_bible: storyBibleSchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const characterSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  role: z.string().optional(),
  description: z.string().optional(),
  visual_ref: z.string().url().nullable().optional(),
  created_at: z.string(),
});
export type Character = z.infer<typeof characterSchema>;

export const locationSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  visual_ref: z.string().url().nullable().optional(),
  created_at: z.string(),
});
export type Location = z.infer<typeof locationSchema>;

export const episodeSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  number: z.number().int().min(1),
  title: z.string().min(1).max(160),
  concept: z.string().max(4000).nullable().optional(),
  outline: z.string().max(20000).nullable().optional(),
  script: z.string().max(60000).nullable().optional(),
  narration: z.string().max(60000).nullable().optional(),
  status: episodeStatusSchema,
  auto_publish: z.boolean().default(false),
  youtube_video_id: z.string().nullable().optional(),
  youtube_url: z.string().url().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Episode = z.infer<typeof episodeSchema>;

export const sceneSchema = z.object({
  id: z.string().uuid(),
  episode_id: z.string().uuid(),
  index: z.number().int().min(0),
  title: z.string().max(120).nullable().optional(),
  script_excerpt: z.string().max(8000).nullable().optional(),
  image_spec: z.string().max(8000).nullable().optional(),
  narration_segment: z.string().max(8000).nullable().optional(),
  duration_sec: z.number().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Scene = z.infer<typeof sceneSchema>;

export const artifactSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional(),
  episode_id: z.string().uuid().nullable().optional(),
  scene_id: z.string().uuid().nullable().optional(),
  task_id: z.string().uuid().nullable().optional(),
  kind: artifactKindSchema,
  version: z.number().int().min(1),
  storage_path: z.string().nullable().optional(), // Supabase Storage path; null for inline text artifacts
  inline_text: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  created_at: z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const workerSchema = z.object({
  id: z.string().uuid(),
  type: workerTypeSchema,
  provider: z.string().max(64), // e.g. kaggle, colab-kokoro, ffmpeg, youtube
  model: z.string().max(120).nullable().optional(),
  runtime: z.string().max(64).nullable().optional(), // kaggle | colab | local | vercel
  status: workerStatusSchema,
  capabilities: z.array(z.string()).default([]),
  current_task_id: z.string().uuid().nullable().optional(),
  last_heartbeat_at: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Worker = z.infer<typeof workerSchema>;

export const taskSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional(),
  episode_id: z.string().uuid().nullable().optional(),
  scene_id: z.string().uuid().nullable().optional(),
  type: taskTypeSchema,
  worker_type: workerTypeSchema,
  worker_id: z.string().uuid().nullable().optional(),
  status: taskStatusSchema,
  depends_on: z.array(z.string().uuid()).nullable().optional(), // task ids
  input: z.record(z.string(), z.unknown()).nullable().optional(),
  output: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  attempts: z.number().int().min(0).default(0),
  max_attempts: z.number().int().min(1).max(10).default(3),
  created_at: z.string(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const eventSchema = z.object({
  id: z.string().uuid(),
  type: eventTypeSchema,
  project_id: z.string().uuid().nullable().optional(),
  episode_id: z.string().uuid().nullable().optional(),
  task_id: z.string().uuid().nullable().optional(),
  worker_id: z.string().uuid().nullable().optional(),
  actor: z.string().max(64).nullable().optional(), // orchestrator | worker id | user
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  created_at: z.string(),
});
export type Event = z.infer<typeof eventSchema>;

export const approvalSchema = z.object({
  id: z.string().uuid(),
  episode_id: z.string().uuid(),
  requested_by: z.string().nullable().optional(),
  decision: approvalDecisionSchema,
  note: z.string().max(4000).nullable().optional(),
  decided_by: z.string().nullable().optional(),
  decided_at: z.string().nullable().optional(),
  created_at: z.string(),
});
export type Approval = z.infer<typeof approvalSchema>;

// ── helpers ──────────────────────────────────────────────────────────────────
export const PIPELINE_ORDER: PipelineStep[] = ["IDEA","SCRIPT","SCENES","IMAGES","VOICE","VIDEO","QC","REVIEW","YOUTUBE"];

export function episodeToPipelineStep(ep: Episode): PipelineStep {
  const m: Record<EpisodeStatus, PipelineStep> = {
    idea: "IDEA",
    writing: "SCRIPT",
    scenes: "SCENES",
    imaging: "IMAGES",
    voicing: "VOICE",
    rendering: "VIDEO",
    qc: "QC",
    ready_for_review: "REVIEW",
    approved: "REVIEW",
    uploading: "YOUTUBE",
    published: "YOUTUBE",
    archived: "YOUTUBE",
  };
  return m[ep.status];
}

export function nextEpisodeStatus(s: EpisodeStatus): EpisodeStatus | null {
  const order: EpisodeStatus[] = ["idea","writing","scenes","imaging","voicing","rendering","qc","ready_for_review","approved","uploading","published"];
  const i = order.indexOf(s);
  return i >= 0 && i < order.length - 1 ? (order[i + 1] as EpisodeStatus) : null;
}
