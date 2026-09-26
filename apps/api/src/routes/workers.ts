import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

const OFFLINE_FALLBACK = [
  { id: "offline-script",  type: "script",  provider: "kaggle",      runtime: "kaggle", status: "OFFLINE", error: "Set KAGGLE_SCRIPT_URL" },
  { id: "offline-image",   type: "image",   provider: "colab-image", runtime: "colab",  status: "OFFLINE", error: "Set COLAB_IMAGE_URL" },
  { id: "offline-voice",   type: "voice",   provider: "kokoro-82m",  runtime: "colab",  status: "OFFLINE", error: "Set KOKORO_VOICE_URL" },
  { id: "offline-video",   type: "video",   provider: "ffmpeg",      runtime: "local",  status: "OFFLINE", error: "Phase 7 — FFmpeg adapter not yet deployed (replaceable)" },
  { id: "offline-youtube", type: "youtube", provider: "youtube-api", runtime: "api",    status: "OFFLINE", error: "Phase 9 — YouTube OAuth not configured" },
];

export async function listWorkers(_req: Request, res: Response) {
  const supa = requireSupabase(res as unknown as Response);
  // When Supabase is not configured, return truthful offline fallback — do not fake ONLINE
  // We check inside without sending 503 so the dashboard still renders a useful empty state
  const { getServerSupabase } = await import("../lib/supabase.js");
  const c = getServerSupabase();
  if (!c) {
    return res.json({
      workers: OFFLINE_FALLBACK,
      source: "offline-fallback",
      hint: "Configure Supabase on Render (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) to persist workers; configure KAGGLE/COLAB env vars to go ONLINE.",
    });
  }
  const { data, error } = await c.from("workers").select("*").order("type");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ workers: data ?? [], source: "supabase" });
}

export async function createWorker(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { type?: string; provider?: string; model?: string; runtime?: string; capabilities?: string[]; status?: string } | null;
  if (!body?.type || !body?.provider) return res.status(400).json({ error: "type and provider are required" });
  const { data, error } = await supa.from("workers").insert({
    type: body.type, provider: body.provider, model: body.model ?? null, runtime: body.runtime ?? null,
    capabilities: body.capabilities ?? [], status: body.status ?? "OFFLINE",
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await supa.from("events").insert({ type: "worker.connected", worker_id: data.id, actor: "orchestrator", payload: { type: body.type, provider: body.provider } });
  res.status(201).json({ worker: data });
}

export async function patchWorker(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  for (const k of ["status","current_task_id","last_heartbeat_at","error","capabilities","model","runtime","config"]) if (k in body) allowed[k] = body[k];
  if (Object.keys(allowed).length === 0) return res.status(400).json({ error: "No updatable fields" });
  // heartbeat touch
  if (allowed.status === "ONLINE" || allowed.status === "IDLE" || allowed.status === "WORKING") {
    if (!("last_heartbeat_at" in allowed)) allowed["last_heartbeat_at"] = new Date().toISOString();
  }
  const { data, error } = await supa.from("workers").update(allowed).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ worker: data });
}

export async function heartbeatWorker(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data, error } = await supa.from("workers").update({
    last_heartbeat_at: new Date().toISOString(),
    status: (req.body as { status?: string })?.status ?? "ONLINE",
  }).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ worker: data });
}
