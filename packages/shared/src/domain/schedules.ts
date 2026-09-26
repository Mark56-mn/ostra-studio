import { z } from "zod";

// ── Schedule schema ──────────────────────────────────────────────────────────
// NOTE: local_time is stored as "HH:MM" in the schedule's own timezone.

export const startupModeSchema = z.enum(["kaggle_kernel","colab_notebook","not_autostartable"]);

export const runtimeScheduleSchema = z.object({
  id: z.string().uuid(),
  worker_type: z.enum(["script","image","voice","video","youtube"]),
  runtime: z.string().min(1).max(64),   // kaggle | colab | local | …
  provider: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  local_time: z.string().regex(/^[0-2][0-9]:[0-5][0-9]$/, "must be HH:MM"),
  timezone: z.string().min(1), // IANA zone
  days_of_week: z.array(z.number().int().min(0).max(6)).default([0,1,2,3,4,5,6]),
  label: z.string().max(64).nullable().optional(),
  startup_mode: startupModeSchema.default("kaggle_kernel"),
  max_start_attempts: z.number().int().min(1).max(10).default(3),
  cooldown_minutes: z.number().int().min(0).max(1440).default(15),
  created_at: z.string(),
  updated_at: z.string(),
});
export type RuntimeSchedule = z.infer<typeof runtimeScheduleSchema>;

export const runtimeScheduleCreateSchema = z.object({
  worker_type: z.enum(["script","image","voice","video","youtube"]),
  runtime: z.string().min(1).max(64),
  provider: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  local_time: z.string().regex(/^[0-2][0-9]:[0-5][0-9]$/),
  timezone: z.string().min(1),
  days_of_week: z.array(z.number().int().min(0).max(6)).optional(),
  label: z.string().max(64).optional().nullable(),
  startup_mode: startupModeSchema.optional(),
  max_start_attempts: z.number().int().min(1).max(10).optional(),
  cooldown_minutes: z.number().int().min(0).max(1440).optional(),
});
export type RuntimeScheduleCreate = z.infer<typeof runtimeScheduleCreateSchema>;

// ── Startup history ──────────────────────────────────────────────────────────
export const startupResultSchema = z.enum([
  "pending","requested","skipped_already_online","skipped_in_progress","skipped_cooldown",
  "not_autostartable","failed","timed_out","registered","health_passed",
]);
export type StartupResult = z.infer<typeof startupResultSchema>;

export const startupHistoryCreateSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  worker_type: z.string().min(1),
  runtime: z.string().min(1),
  provider: z.string().min(1),
  trigger_source: z.string().min(1), // scheduler:<id> | run_now | …
  provider_run_id: z.string().nullable().optional(),
  provider_response: z.record(z.string(), z.unknown()).nullable().optional(),
  result: startupResultSchema.optional(),
  error: z.string().nullable().optional(),
});
export type StartupHistoryCreate = z.infer<typeof startupHistoryCreateSchema>;

// ── Time helpers ─────────────────────────────────────────────────────────────
// We avoid heavy date-fns-tz / luxon runtime on the API by using Intl + UTC math.
// The logic is: "local_time" is wall-clock in schedule.timezone; we compare against UTC `now`.
// This implementation handles Africa/Lagos and other IANA zones via Intl.

export function parseLocalTime(hhmm: string): { h: number; m: number } {
  const [hs, ms] = hhmm.split(":");
  return { h: parseInt(hs!, 10) || 0, m: parseInt(ms!, 10) || 0 };
}

// Returns offset minutes for a given instant in a given IANA zone (positive east of UTC).
// E.g. Africa/Lagos (+01:00) → 60.
export function tzOffsetMinutes(zone: string, at: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, timeZoneName: "short",
    });
    const parts = fmt.formatToParts(at);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? "0";
    const wall = Date.UTC(
      parseInt(get("year"),10), parseInt(get("month"),10)-1, parseInt(get("day"),10),
      parseInt(get("hour"),10), parseInt(get("minute"),10), parseInt(get("second"),10)
    );
    return Math.round((wall - at.getTime()) / 60000);
  } catch {
    // Unknown zone → treat as UTC
    return 0;
  }
}

// Convert a (Y-M-D h:m in zone) → UTC Date.
export function zonedToUtc(year: number, month1: number, day: number, hour: number, minute: number, zone: string): Date {
  // Start with naive UTC, then subtract the zone's offset at that instant.
  const naive = new Date(Date.UTC(year, month1 - 1, day, hour, minute, 0, 0));
  // Offset can shift due to DST; iterate once to stabilize
  let offset = tzOffsetMinutes(zone, naive);
  let utc = new Date(naive.getTime() - offset * 60000);
  const offset2 = tzOffsetMinutes(zone, utc);
  if (offset2 !== offset) utc = new Date(naive.getTime() - offset2 * 60000);
  return utc;
}

// Return { y,m,d, wd, hh, mm } of `at` in `zone` (month 1-indexed, wd 0=Sun).
export function decomposeInZone(at: Date, zone: string): { y:number; mo1:number; d:number; wd:number; hh:number; mm:number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    // We parse via formatToParts to get reliable fields
    const parts = fmt.formatToParts(at);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
    const y = parseInt(get("year"),10);
    const mo1 = parseInt(get("month"),10);
    const d = parseInt(get("day"),10);
    const hh = parseInt(get("hour"),10);
    const mm = parseInt(get("minute"),10);
    const wdStr = get("weekday"); // e.g. Sun, Mon
    const map: Record<string,number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
    const wd = map[wdStr] ?? at.getUTCDay();
    if (!y || !mo1) return null;
    return { y, mo1, d, wd, hh, mm };
  } catch { return null; }
}

// ── Schedule matching ────────────────────────────────────────────────────────
// A schedule "fires" at the exact minute of local_time on one of its days_of_week.
// Scheduler ticks once per minute; we compare `now` floored to the minute in the schedule's zone.

export function isDueNow(schedule: RuntimeSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  const du = decomposeInZone(now, schedule.timezone);
  if (!du) return false;
  const { h, m } = parseLocalTime(schedule.local_time);
  const days = schedule.days_of_week && schedule.days_of_week.length ? schedule.days_of_week : [0,1,2,3,4,5,6];
  return du.hh === h && du.mm === m && days.includes(du.wd);
}

// Also: does this schedule fall on the given local day?
export function isDueOnLocalDay(_schedule: RuntimeSchedule, _now: Date): boolean {
  // Not used independently; covered by isDueNow via decomposeInZone
  return true;
}

// ── Next run calculation ─────────────────────────────────────────────────────
// Find the next UTC instant after `from` that matches the schedule.

export function nextRunUtc(schedule: RuntimeSchedule, from: Date): Date | null {
  let probe = new Date(from.getTime() + 60_000); // strictly after `from`, minute granularity
  const days = schedule.days_of_week && schedule.days_of_week.length ? schedule.days_of_week : [0,1,2,3,4,5,6];
  const { h, m } = parseLocalTime(schedule.local_time);
  for (let i = 0; i < 366; i++) {
    const du = decomposeInZone(probe, schedule.timezone);
    if (!du) return null;
    if (days.includes(du.wd)) {
      const cand = zonedToUtc(du.y, du.mo1, du.d, h, m, schedule.timezone);
      if (cand.getTime() > from.getTime()) return cand;
      // cand was today at h:m but already past — advance one local day
      const nextDayProbe = new Date(probe.getTime() + 24*3600*1000);
      probe = nextDayProbe;
      // ensure we re-evaluate at h:m of the next day — just loop, caller will pick the correct h:m
      // To avoid landing on a non-matching day's wrong time, rebuild probe as the *start* of next day
      // at h:m in the zone, then check day filter
      const nd = decomposeInZone(probe, schedule.timezone)!;
      const cand2 = zonedToUtc(nd.y, nd.mo1, nd.d, h, m, schedule.timezone);
      // If that day's h:m is not matching `days`, the loop will skip it; but borrow cand2 as probe hint
      probe = cand2;
      // Re-check immediately for this candidate
      const checkDu = decomposeInZone(cand2, schedule.timezone);
      if (checkDu && days.includes(checkDu.wd) && cand2.getTime() > from.getTime()) return cand2;
      // else continue scanning
      probe = new Date(cand2.getTime() + 60_000);
      continue;
    }
    // day not in set — jump to next day at h:m
    const nd = decomposeInZone(new Date(probe.getTime() + 24*3600*1000), schedule.timezone);
    if (!nd) return null;
    const cand = zonedToUtc(nd.y, nd.mo1, nd.d, h, m, schedule.timezone);
    probe = cand;
    // loop will validate
  }
  return null;
}

// Convenience: next run across many schedules, sorted ascending (soonest first)
export function nextRuns(schedules: RuntimeSchedule[], from: Date, limit = 10): Array<{ schedule: RuntimeSchedule; at: Date }> {
  const rows: Array<{ schedule: RuntimeSchedule; at: Date }> = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    const at = nextRunUtc(s, from);
    if (at) rows.push({ schedule: s, at });
  }
  rows.sort((a,b) => a.at.getTime()-b.at.getTime());
  return rows.slice(0, limit);
}

// Validate schedule input in a single place (also called by API routes)
export function validateScheduleCreate(input: unknown): { ok: true; data: RuntimeScheduleCreate } | { ok: false; error: string } {
  const r = runtimeScheduleCreateSchema.safeParse(input);
  if (!r.success) return { ok: false, error: r.error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; ") };
  // Validate IANA zone broadly: must be accepted by Intl
  try {
    void new Intl.DateTimeFormat("en", { timeZone: r.data.timezone });
  } catch {
    return { ok: false, error: `Invalid timezone: ${r.data.timezone}` };
  }
  if (r.data.days_of_week && r.data.days_of_week.length === 0) {
    return { ok: false, error: "days_of_week must not be empty (use 0-6; empty means every day, but the array must be omitted to mean every day)" };
  }
  return { ok: true, data: r.data };
}
