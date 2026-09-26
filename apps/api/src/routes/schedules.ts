import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";
import { validateScheduleCreate } from "@ostra/shared";

export async function listSchedules(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const workerType = (req.query.worker_type as string) ?? null;
  const runtime = (req.query.runtime as string) ?? null;
  let q = supa.from("runtime_schedules").select("*").order("local_time", { ascending: true });
  if (workerType) q = q.eq("worker_type", workerType);
  if (runtime) q = q.eq("runtime", runtime);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ schedules: data ?? [] });
}

export async function createSchedule(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const v = validateScheduleCreate(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.data;
  const { data, error } = await supa
    .from("runtime_schedules")
    .insert({
      worker_type: d.worker_type,
      runtime: d.runtime,
      provider: d.provider,
      enabled: d.enabled ?? true,
      local_time: d.local_time,
      timezone: d.timezone,
      days_of_week: d.days_of_week ?? [0,1,2,3,4,5,6],
      label: d.label ?? null,
      startup_mode: d.startup_mode ?? "kaggle_kernel",
      max_start_attempts: d.max_start_attempts ?? 3,
      cooldown_minutes: d.cooldown_minutes ?? 15,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await supa.from("events").insert({ type: "scheduler.schedule_created", actor: "api", payload: { schedule_id: data.id, worker_type: d.worker_type, runtime: d.runtime, local_time: d.local_time, timezone: d.timezone } });
  res.status(201).json({ schedule: data });
}

export async function getSchedule(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { data, error } = await supa.from("runtime_schedules").select("*").eq("id", id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json({ schedule: data });
}

export async function patchSchedule(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const body = req.body as Record<string, unknown>;
  // Only allow known fields; validate local_time / timezone / days_of_week if present
  const patch: Record<string, unknown> = {};
  for (const k of ["worker_type","runtime","provider","enabled","local_time","timezone","days_of_week","label","startup_mode","max_start_attempts","cooldown_minutes"]) {
    if (k in body) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No updatable fields" });
  if ("local_time" in patch && typeof patch.local_time === "string" && !/^[0-2][0-9]:[0-5][0-9]$/.test(patch.local_time)) {
    return res.status(400).json({ error: "local_time must be HH:MM" });
  }
  if ("timezone" in patch) {
    try { void new Intl.DateTimeFormat("en", { timeZone: patch.timezone as string }); } catch { return res.status(400).json({ error: `Invalid timezone: ${patch.timezone}` }); }
  }
  if ("startup_mode" in patch) {
    const allowed = ["kaggle_kernel","colab_notebook","not_autostartable"];
    if (typeof patch.startup_mode !== "string" || !allowed.includes(patch.startup_mode)) return res.status(400).json({ error: "Invalid startup_mode" });
  }
  if ("days_of_week" in patch) {
    const v = patch.days_of_week as unknown;
    if (!Array.isArray(v) || (v as unknown[]).some(x => typeof x !== "number" || x < 0 || x > 6)) return res.status(400).json({ error: "days_of_week must be int[] 0..6" });
    if ((v as unknown[]).length === 0) return res.status(400).json({ error: "days_of_week must not be empty" });
  }
  const { data, error } = await supa.from("runtime_schedules").update(patch).eq("id", id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await supa.from("events").insert({ type: "scheduler.schedule_updated", actor: "api", payload: { schedule_id: id, patch: Object.keys(patch) } });
  res.json({ schedule: data });
}

export async function deleteSchedule(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const { id } = req.params as { id: string };
  const { error } = await supa.from("runtime_schedules").delete().eq("id", id);
  if (error) return res.status(400).json({ error: error.message });
  await supa.from("events").insert({ type: "scheduler.schedule_deleted", actor: "api", payload: { schedule_id: id } });
  res.json({ ok: true });
}

// Seed helper: idempotently ensure the three daily windows exist (Morning 09:00, Afternoon 14:00, Evening 20:00)
// Not called automatically — PATCH /api/schedules/seed or called from scheduler on first tick when empty.
export async function seedDefaultSchedules(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const timezone = (req.body as { timezone?: string } | null)?.timezone ?? (req.query.timezone as string) ?? "Africa/Lagos";
  try { void new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { return res.status(400).json({ error: `Invalid timezone: ${timezone}` }); }

  const defaults = [
    { label: "Morning",   local_time: "09:00", worker_type: "script", runtime: "kaggle", provider: "kaggle", startup_mode: "kaggle_kernel" as const },
    { label: "Afternoon", local_time: "14:00", worker_type: "script", runtime: "kaggle", provider: "kaggle", startup_mode: "kaggle_kernel" as const },
    { label: "Evening",   local_time: "20:00", worker_type: "script", runtime: "kaggle", provider: "kaggle", startup_mode: "kaggle_kernel" as const },
  ];

  const created: unknown[] = [];
  for (const d of defaults) {
    const { data: existing } = await supa
      .from("runtime_schedules")
      .select("id")
      .eq("worker_type", d.worker_type)
      .eq("runtime", d.runtime)
      .eq("local_time", d.local_time)
      .maybeSingle();
    if (existing) continue;
    const { data, error } = await supa.from("runtime_schedules").insert({
      worker_type: d.worker_type, runtime: d.runtime, provider: d.provider,
      enabled: true, local_time: d.local_time, timezone, days_of_week: [0,1,2,3,4,5,6],
      label: d.label, startup_mode: d.startup_mode, max_start_attempts: 3, cooldown_minutes: 15,
    }).select().single();
    if (!error && data) created.push(data);
  }
  res.json({ created, timezone });
}
