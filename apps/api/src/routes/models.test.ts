// apps/api/src/routes/models.test.ts
// Unit tests for the model-switch endpoint's pure rules: the catalog/switch/health merge and the
// request validation. No database, no network — those two functions are the whole decision surface.
import assert from "node:assert";
import { describe, it } from "node:test";
import type { ProviderHealth } from "@ostra/shared";
import { MODEL_CATALOG } from "@ostra/shared";
import { mergeModelViews, validateToggle, type ControlRow } from "./models.js";

const NOW = "2026-09-29T07:00:00.000Z";

function health(status: ProviderHealth["status"]): ProviderHealth {
  return { ok: status === "ONLINE", status, provider: "kaggle", reason: `${status} for test`, checkedAt: NOW };
}

function row(over: Partial<ControlRow>): ControlRow {
  return { key: "script-qwen3-1-7b", enabled: true, note: null, updated_by: null, updated_at: null, ...over };
}

describe("mergeModelViews", () => {
  it("returns every catalog entry, defaulting to ON when nothing is stored", () => {
    const views = mergeModelViews([], {});
    assert.equal(views.length, MODEL_CATALOG.length);
    for (const v of views) {
      assert.equal(v.enabled, true, `${v.key} should default to ON`);
      assert.equal(v.health, null);
      assert.equal(v.dispatch, "NOT_READY"); // ON but no verified health ⇒ usable nowhere
      assert.equal(v.updatedAt, null);
    }
  });

  it("defaults to ON when the health report itself failed (empty map)", () => {
    const views = mergeModelViews([], null);
    assert.equal(views.every((v) => v.enabled), true);
    assert.equal(views.every((v) => v.health === null), true);
  });

  it("applies a stored OFF switch and never reports it as ONLINE", () => {
    const views = mergeModelViews(
      [row({ key: "script-qwen3-1-7b", enabled: false, note: "cost control", updated_by: "operator", updated_at: NOW })],
      { script: { health: health("ONLINE") } }
    );
    const script = views.find((v) => v.key === "script-qwen3-1-7b")!;
    assert.equal(script.enabled, false);
    assert.equal(script.dispatch, "DISABLED");
    // health is still the truth — switching off hides nothing
    assert.equal(script.health?.status, "ONLINE");
    assert.equal(script.note, "cost control");
    assert.equal(script.updatedBy, "operator");
    assert.equal(script.updatedAt, NOW);
  });

  it("is READY only when switched ON and the real health says ONLINE", () => {
    const views = mergeModelViews([row({ enabled: true })], { script: { health: health("ONLINE") } });
    assert.equal(views.find((v) => v.key === "script-qwen3-1-7b")!.dispatch, "READY");
  });

  it("is NOT_READY for an ON model whose real health is anything but ONLINE", () => {
    for (const status of ["OFFLINE", "STARTING", "NOT_CONFIGURED", "ERROR", "DEGRADED", "UNKNOWN"] as const) {
      const views = mergeModelViews([row({ enabled: true })], { script: { health: health(status) } });
      const script = views.find((v) => v.key === "script-qwen3-1-7b")!;
      assert.equal(script.dispatch, "NOT_READY", `status ${status}`);
      assert.equal(script.health?.status, status);
    }
  });

  it("only reads the switch that belongs to the matching provider slot", () => {
    const views = mergeModelViews([row({ key: "voice-kokoro-82m", enabled: false })], {});
    assert.equal(views.find((v) => v.key === "voice-kokoro-82m")!.enabled, false);
    assert.equal(views.find((v) => v.key === "script-qwen3-1-7b")!.enabled, true);
  });

  it("ignores stored rows for keys that are no longer in the catalog", () => {
    const views = mergeModelViews([row({ key: "ghost-model", enabled: false })], {});
    assert.equal(views.length, MODEL_CATALOG.length);
    assert.equal(views.every((v) => v.enabled), true);
  });
});

describe("validateToggle", () => {
  it("rejects an unknown model with the known keys (404)", () => {
    const r = validateToggle("not-a-model", { enabled: true });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 404);
    assert.deepEqual(r.known, MODEL_CATALOG.map((m) => m.key));
  });

  it("rejects a missing or non-boolean enabled (400)", () => {
    for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, null, undefined]) {
      const r = validateToggle("script-qwen3-1-7b", body);
      assert.equal(r.ok, false, `body ${JSON.stringify(body)}`);
      if (!r.ok) assert.equal(r.status, 400);
    }
  });

  it("accepts a boolean and normalizes the key + note", () => {
    const r = validateToggle("  SCRIPT-QWEN3-1-7B ", { enabled: false, note: "  pausing for the week  " });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.key, "script-qwen3-1-7b");
    assert.equal(r.providerId, "script");
    assert.equal(r.modelRef, "qwen3-1-7b");
    assert.equal(r.enabled, false);
    assert.equal(r.note, "pausing for the week");
  });

  it("stores an empty/whitespace note as null and caps long notes at 500 chars", () => {
    const blank = validateToggle("voice-kokoro-82m", { enabled: true, note: "   " });
    assert.equal(blank.ok && blank.note, null);

    const long = validateToggle("voice-kokoro-82m", { enabled: true, note: "x".repeat(900) });
    assert.equal(long.ok && long.note?.length, 500);
  });

  it("accepts every catalog key", () => {
    for (const m of MODEL_CATALOG) {
      const r = validateToggle(m.key, { enabled: true });
      assert.equal(r.ok, true, `key ${m.key}`);
    }
  });
});
