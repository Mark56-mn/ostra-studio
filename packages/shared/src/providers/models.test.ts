// packages/shared/src/providers/models.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  MODEL_CATALOG,
  findModel,
  isModelKey,
  modelDispatchState,
  modelForProvider,
  modelKey,
} from "./models.js";
import type { ProviderHealth } from "./contracts.js";

// The constraint the migration enforces: check (key ~ '^[a-z0-9-]{2,120}$')
const KEY_PATTERN = /^[a-z0-9-]{2,120}$/;

function health(status: ProviderHealth["status"]): ProviderHealth {
  return { ok: status === "ONLINE", status, checkedAt: new Date().toISOString() };
}

describe("MODEL_CATALOG", () => {
  it("uses URL-safe keys the model_controls check constraint accepts", () => {
    for (const m of MODEL_CATALOG) {
      assert.equal(KEY_PATTERN.test(m.key), true, `bad key ${m.key}`);
      assert.equal(isModelKey(m.key), true, `isModelKey rejected ${m.key}`);
    }
  });

  it("keeps keys unique", () => {
    const keys = MODEL_CATALOG.map((m) => m.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("keeps provider slots unique (one switch per provider)", () => {
    const slots = MODEL_CATALOG.map((m) => m.providerId);
    assert.equal(new Set(slots).size, slots.length);
  });

  it("derives each key from its provider slot and model ref", () => {
    for (const m of MODEL_CATALOG) {
      assert.equal(m.key, modelKey(m.providerId, m.modelRef));
    }
  });

  it("covers exactly the switchable AI slots, and never storage", () => {
    assert.deepEqual(
      [...MODEL_CATALOG.map((m) => m.providerId)].sort(),
      ["image", "script", "video", "voice", "youtube"]
    );
  });
});

describe("lookups", () => {
  it("finds a model by key, case-insensitively", () => {
    assert.equal(findModel("script-qwen3-1-7b")?.providerId, "script");
    assert.equal(findModel("  SCRIPT-QWEN3-1-7B ")?.providerId, "script");
  });

  it("returns null for unknown/empty keys", () => {
    assert.equal(findModel("nope"), null);
    assert.equal(findModel(""), null);
    assert.equal(findModel(null), null);
    assert.equal(findModel(undefined), null);
  });

  it("maps a provider slot to its switchable model", () => {
    assert.equal(modelForProvider("voice")?.modelRef, "kokoro-82m");
    assert.equal(modelForProvider("storage"), null);
    assert.equal(modelForProvider(null), null);
  });
});

describe("modelDispatchState", () => {
  it("is DISABLED whenever the switch is off, whatever the health says", () => {
    assert.equal(modelDispatchState(false, health("ONLINE")), "DISABLED");
    assert.equal(modelDispatchState(false, health("OFFLINE")), "DISABLED");
    assert.equal(modelDispatchState(false, null), "DISABLED");
  });

  it("is READY only when switched on AND really ONLINE", () => {
    assert.equal(modelDispatchState(true, health("ONLINE")), "READY");
  });

  it("is NOT_READY when switched on but not usable — never a fake READY", () => {
    for (const s of ["OFFLINE", "STARTING", "NOT_CONFIGURED", "ERROR", "DEGRADED", "UNKNOWN"] as const) {
      assert.equal(modelDispatchState(true, health(s)), "NOT_READY", `status ${s}`);
    }
    assert.equal(modelDispatchState(true, null), "NOT_READY");
  });

  it("never reports DISABLED as ONLINE (the two answers stay independent)", () => {
    const off = modelDispatchState(false, health("ONLINE"));
    assert.notEqual(off, "READY");
  });
});
