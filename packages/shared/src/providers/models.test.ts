// packages/shared/src/providers/models.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  LEGACY_MODEL_KEYS,
  MODEL_CATALOG,
  autostartRefusal,
  findModel,
  isModelKey,
  liveModelFromHealth,
  modelDispatchState,
  modelForProvider,
  modelKey,
  resolveStoredModelKey,
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
      ["image", "manager", "overseer", "script", "video", "voice", "youtube"]
    );
  });

  it("names the model the Kaggle agents actually serve", () => {
    for (const id of ["script", "image", "voice", "overseer"] as const) {
      const entry = modelForProvider(id);
      assert.equal(entry?.modelRef, "qwen3-4b", `${id} modelRef`);
      assert.equal(entry?.runtime, "kaggle", `${id} runtime`);
      assert.equal(entry?.provider, "kaggle", `${id} provider`);
    }
  });

  it("marks every Kaggle agent autostartable and explains every refusal", () => {
    const startable = MODEL_CATALOG.filter((m) => m.autostart).map((m) => m.providerId);
    assert.deepEqual(startable, ["script", "image", "voice", "overseer"]);
    for (const m of MODEL_CATALOG.filter((e) => !e.autostart)) {
      assert.ok(m.autostartNote && m.autostartNote.length > 20, `${m.key} must explain why it cannot start`);
      assert.ok(!/secret|token/i.test(m.autostartNote), `${m.key} note must not mention secrets`);
    }
  });

  it("resolves every retired key to a key that exists in the catalog", () => {
    for (const [oldKey, newKey] of Object.entries(LEGACY_MODEL_KEYS)) {
      assert.equal(findModel(newKey)?.key, newKey, `${oldKey} → ${newKey} must exist`);
    }
  });
});

describe("resolveStoredModelKey", () => {
  it("keeps a current key as-is", () => {
    assert.equal(resolveStoredModelKey("script-qwen3-4b"), "script-qwen3-4b");
    assert.equal(resolveStoredModelKey("  IMAGE-QWEN3-4B "), "image-qwen3-4b");
  });

  it("maps a retired key to the entry that replaced it", () => {
    assert.equal(resolveStoredModelKey("script-qwen3-1-7b"), "script-qwen3-4b");
    assert.equal(resolveStoredModelKey("voice-kokoro-82m"), "voice-qwen3-4b");
  });

  it("returns null for keys with no successor", () => {
    assert.equal(resolveStoredModelKey("ghost-model"), null);
    assert.equal(resolveStoredModelKey(null), null);
  });
});

describe("liveModelFromHealth", () => {
  it("reads the model a worker reported", () => {
    const h: ProviderHealth = {
      ok: true,
      status: "ONLINE",
      checkedAt: new Date().toISOString(),
      detail: { model: "Qwen/Qwen3-4B" },
    };
    assert.equal(liveModelFromHealth(h), "Qwen/Qwen3-4B");
  });

  it("is null when no worker reported a model (never inferred from config)", () => {
    assert.equal(liveModelFromHealth(null), null);
    assert.equal(liveModelFromHealth(health("OFFLINE")), null);
    assert.equal(liveModelFromHealth({ ...health("ONLINE"), detail: { model: "  " } }), null);
  });
});

describe("lookups", () => {
  it("finds a model by key, case-insensitively", () => {
    assert.equal(findModel("script-qwen3-4b")?.providerId, "script");
    assert.equal(findModel("  SCRIPT-QWEN3-4B ")?.providerId, "script");
  });

  it("returns null for unknown/empty keys", () => {
    assert.equal(findModel("nope"), null);
    assert.equal(findModel(""), null);
    assert.equal(findModel(null), null);
    assert.equal(findModel(undefined), null);
  });

  it("maps a provider slot to its switchable model", () => {
    assert.equal(modelForProvider("voice")?.modelRef, "qwen3-4b");
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

describe("autostartRefusal", () => {
  it("allows every Kaggle agent slot, each of which pushes its own notebook", () => {
    for (const id of ["script", "image", "voice", "overseer"]) {
      assert.equal(autostartRefusal(id), null, `${id} must have an autostart path`);
    }
  });

  it("refuses the not-deployed slots too", () => {
    assert.match(String(autostartRefusal("video")), /not deployed/);
    assert.match(String(autostartRefusal("youtube")), /YouTube OAuth/);
  });

  it("does not refuse an unknown slot (the caller answers normally)", () => {
    assert.equal(autostartRefusal("ghost"), null);
    assert.equal(autostartRefusal(null), null);
  });
});
