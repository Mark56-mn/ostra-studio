// apps/api/src/lib/routing.test.ts
// The HTTP rules for PATCH /api/routing. A typo must be a visible 400 that names what IS accepted —
// never a silent no-op that leaves the operator believing the studio was switched.

import assert from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_ROUTING, type RoutingSettings } from "@ostra/shared";
import { applyRoutingPatch, validateRoutingPatch } from "./routing";

const current: RoutingSettings = { mode: "auto", slots: { voice: "own" }, updatedAt: null, updatedBy: null };

describe("validateRoutingPatch", () => {
  it("accepts a global mode (case-insensitively)", () => {
    const v = validateRoutingPatch({ mode: "NVIDIA" });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.mode, "nvidia");
  });

  it("accepts a slot override and an explicit null to inherit", () => {
    const set = validateRoutingPatch({ slot: "IMAGE", slotMode: "nvidia" });
    assert.equal(set.ok, true);
    if (set.ok) {
      assert.equal(set.slot, "image");
      assert.equal(set.slotMode, "nvidia");
    }
    const clear = validateRoutingPatch({ slot: "voice", slotMode: null });
    assert.equal(clear.ok, true);
  });

  it("rejects an unknown mode, slot or slotMode with the accepted values", () => {
    const badMode = validateRoutingPatch({ mode: "everything" });
    assert.equal(badMode.ok, false);
    if (!badMode.ok) {
      assert.equal(badMode.status, 400);
      assert.ok(badMode.known?.includes("nvidia"));
    }
    const badSlot = validateRoutingPatch({ slot: "director", slotMode: "auto" });
    assert.equal(badSlot.ok, false);
    if (!badSlot.ok) assert.ok(badSlot.known?.includes("overseer"));
    const badSlotMode = validateRoutingPatch({ slot: "script", slotMode: "everything" });
    assert.equal(badSlotMode.ok, false);
  });

  it("rejects an empty body and a slot without a mode", () => {
    assert.equal(validateRoutingPatch({}).ok, false);
    assert.equal(validateRoutingPatch(null).ok, false);
    assert.equal(validateRoutingPatch({ slot: "script" }).ok, false);
  });
});

describe("applyRoutingPatch", () => {
  it("changes only the global mode", () => {
    const v = validateRoutingPatch({ mode: "nvidia" });
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.deepEqual(applyRoutingPatch(current, v), { mode: "nvidia", slots: { voice: "own" } });
  });

  it("sets and clears a slot override without touching the others", () => {
    const set = validateRoutingPatch({ slot: "script", slotMode: "own" });
    const clear = validateRoutingPatch({ slot: "voice", slotMode: null });
    assert.ok(set.ok && clear.ok);
    if (!set.ok || !clear.ok) return;
    assert.deepEqual(applyRoutingPatch(current, set).slots, { voice: "own", script: "own" });
    const after = applyRoutingPatch(current, clear);
    assert.deepEqual(after.slots, {});
    assert.equal(after.mode, current.mode, "a slot change must not silently change the global mode");
  });

  it("never mutates the settings it was given", () => {
    const v = validateRoutingPatch({ slot: "script", slotMode: "nvidia" });
    if (!v.ok) return;
    applyRoutingPatch(current, v);
    assert.deepEqual(current, { mode: "auto", slots: { voice: "own" }, updatedAt: null, updatedBy: null });
    assert.equal(DEFAULT_ROUTING.mode, "auto");
  });
});
