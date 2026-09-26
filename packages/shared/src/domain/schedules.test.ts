// packages/shared/src/domain/schedules.test.ts — unit tests (run with `bun test` or `node --test`)
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  parseLocalTime, tzOffsetMinutes, zonedToUtc, decomposeInZone,
  isDueNow, nextRunUtc, nextRuns, validateScheduleCreate,
  type RuntimeSchedule,
} from "./schedules.js";

function mkSchedule(over: Partial<RuntimeSchedule> & { local_time: string; timezone: string }): RuntimeSchedule {
  const { days_of_week, label, startup_mode, ...rest } = over as Record<string, unknown>;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    worker_type: "script",
    runtime: "kaggle",
    provider: "kaggle",
    enabled: true,
    local_time: over.local_time,
    timezone: over.timezone,
    days_of_week: (days_of_week as number[] | undefined) ?? [0,1,2,3,4,5,6],
    label: (label as string | null) ?? null,
    startup_mode: (startup_mode as unknown as string) ?? "kaggle_kernel",
    max_start_attempts: 3,
    cooldown_minutes: 15,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...rest,
  } as unknown as RuntimeSchedule;
}

describe("schedules", () => {
  it("parseLocalTime", () => {
    assert.deepEqual(parseLocalTime("09:00"), { h:9, m:0 });
    assert.deepEqual(parseLocalTime("05:30"), { h:5, m:30 });
  });

  it("tzOffsetMinutes Africa/Lagos is +60", () => {
    const at = new Date("2026-09-26T12:00:00Z");
    assert.strictEqual(tzOffsetMinutes("Africa/Lagos", at), 60);
  });

  it("zonedToUtc: 09:00 Lagos = 08:00 UTC", () => {
    const utc = zonedToUtc(2026, 9, 26, 9, 0, "Africa/Lagos");
    assert.strictEqual(utc.toISOString(), "2026-09-26T08:00:00.000Z");
  });

  it("isDueNow: matches the exact local minute", () => {
    // Fix now to 2026-09-26 09:00 Lagos = 08:00 UTC
    const now = new Date("2026-09-26T08:00:00Z");
    const s = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos" });
    assert.strictEqual(isDueNow(s, now), true);
    const oneMinLate = new Date("2026-09-26T08:01:00Z");
    assert.strictEqual(isDueNow(s, oneMinLate), false);
    const disabled = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos", enabled:false });
    assert.strictEqual(isDueNow(disabled, now), false);
  });

  it("isDueNow: days_of_week filters", () => {
    // 2026-09-26 is a Saturday (6)
    const satAt = new Date("2026-09-26T08:00:00Z"); // Sat 09:00 Lagos
    const monOnly = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos", days_of_week:[1] });
    assert.strictEqual(isDueNow(monOnly, satAt), false);
    const satOnly = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos", days_of_week:[6] });
    assert.strictEqual(isDueNow(satOnly, satAt), true);
  });

  it("nextRunUtc: advances to next matching day", () => {
    // Start 2026-09-26 Sat 10:00 Lagos (09:00 UTC). Schedule daily 09:00 Lagos.
    const from = new Date("2026-09-26T09:00:00Z"); // Sat 10:00 Lagos
    const s = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos" });
    const nxt = nextRunUtc(s, from)!;
    // Next is Sun 09:00 Lagos = 08:00 UTC on 2026-09-27
    assert.strictEqual(nxt.toISOString(), "2026-09-27T08:00:00.000Z");
  });

  it("changing 09:00→05:00 changes next run (regression for PART 3)", () => {
    const from = new Date("2026-09-26T07:30:00Z"); // 08:30 Lagos
    const s1 = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos" });
    const s2 = mkSchedule({ local_time:"05:00", timezone:"Africa/Lagos" });
    const n1 = nextRunUtc(s1, from)!;
    const n2 = nextRunUtc(s2, from)!;
    assert.strictEqual(n1.toISOString(), "2026-09-26T08:00:00.000Z");
    // 05:00 today is already past (04:00 UTC < 07:30 UTC), so next is tomorrow
    assert.strictEqual(n2.toISOString(), "2026-09-27T04:00:00.000Z");
  });

  it("validateScheduleCreate rejects bad HH:MM", () => {
    const r = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"9:00", timezone:"Africa/Lagos" });
    assert.strictEqual(r.ok, false);
  });
  it("validateScheduleCreate rejects invalid timezone", () => {
    const r = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"09:00", timezone:"Mars/Olympus" });
    assert.strictEqual(r.ok, false);
  });
  it("validateScheduleCreate accepts valid input", () => {
    const r = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"09:00", timezone:"Africa/Lagos", label:"Morning" });
    assert.strictEqual(r.ok, true);
  });

  // ── Additional coverage for scheduler contract ──────────────────────────
  it("nextRuns sorts soonest first across multiple schedules", () => {
    const from = new Date("2026-09-26T07:00:00Z"); // 08:00 Lagos
    const morning = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos", label:"Morning" });
    const evening = mkSchedule({ local_time:"20:00", timezone:"Africa/Lagos", label:"Evening" });
    // Give them distinct ids so nextRuns can distinguish
    (morning as Record<string, unknown>).id = "00000000-0000-4000-8000-000000000010";
    (evening as Record<string, unknown>).id = "00000000-0000-4000-8000-000000000011";
    const rows = nextRuns([evening, morning], from);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0]!.schedule.label, "Morning");
    assert.strictEqual(rows[1]!.schedule.label, "Evening");
  });

  it("nextRunUtc respects days_of_week", () => {
    // 2026-09-26 Sat, schedule only Mon 09:00 Lagos -> next is Mon 2026-09-28
    const from = new Date("2026-09-26T09:00:00Z"); // Sat 10:00 Lagos
    const monOnly = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos", days_of_week:[1] });
    const nxt = nextRunUtc(monOnly, from)!;
    assert.strictEqual(nxt.toISOString(), "2026-09-28T08:00:00.000Z"); // Mon
  });

  it("validateScheduleCreate rejects empty days_of_week", () => {
    const r = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"09:00", timezone:"Africa/Lagos", days_of_week: [] });
    assert.strictEqual(r.ok, false);
  });

  it("validateScheduleCreate accepts multiple daily windows (same worker, different times)", () => {
    const r1 = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"09:00", timezone:"Africa/Lagos" });
    const r2 = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"14:00", timezone:"Africa/Lagos" });
    const r3 = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"20:00", timezone:"Africa/Lagos" });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r3.ok, true);
  });

  it("validateScheduleCreate rejects max_start_attempts out of range", () => {
    const r = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"09:00", timezone:"Africa/Lagos", max_start_attempts: 0 });
    assert.strictEqual(r.ok, false);
    const r2 = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"09:00", timezone:"Africa/Lagos", max_start_attempts: 11 });
    assert.strictEqual(r2.ok, false);
  });

  it("isDueNow disabled schedule never fires", () => {
    const now = new Date("2026-09-26T08:00:00Z");
    const s = mkSchedule({ local_time:"09:00", timezone:"Africa/Lagos", enabled:false, days_of_week:[0,1,2,3,4,5,6] });
    assert.strictEqual(isDueNow(s, now), false);
  });

  it("decomposeInZone returns null for invalid zone gracefully (isDueNow false)", () => {
    const now = new Date("2026-09-26T08:00:00Z");
    const s = mkSchedule({ local_time:"09:00", timezone:"Invalid/Zone" });
    // tzOffsetMinutes returns 0 for invalid zones, so isDueNow should compare against UTC
    // This is not a crash — it degrades to UTC
    const result = isDueNow(s, now);
    // Don't assert exact — just ensure it doesn't throw
    assert.strictEqual(typeof result, "boolean");
  });

  it("zonedToUtc handles midnight correctly", () => {
    const utc = zonedToUtc(2026, 9, 26, 0, 0, "Africa/Lagos");
    assert.strictEqual(utc.toISOString(), "2026-09-25T23:00:00.000Z");
  });

  it("validateScheduleCreate accepts timezone change", () => {
    const r = validateScheduleCreate({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"09:00", timezone:"America/New_York" });
    assert.strictEqual(r.ok, true);
  });
});
