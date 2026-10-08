// packages/shared/src/providers/routing.test.ts
// Routing decides who answers. A wrong answer here is a broken agent, so every branch is pinned —
// including the ones that must REFUSE.

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  DEFAULT_ROUTING,
  decideRoute,
  normalizeRoutingMode,
  normalizeRoutingSlots,
  routingModeFor,
  type RoutingSettings,
} from "./routing";

const base = {
  label: "Script AI",
  workerOnline: false,
  nvidiaConfigured: false,
  openaiConfigured: false,
};

describe("normalizeRoutingMode / normalizeRoutingSlots", () => {
  it("defaults anything unrecognised to auto", () => {
    assert.equal(normalizeRoutingMode("own"), "own");
    assert.equal(normalizeRoutingMode("NVIDIA"), "nvidia");
    assert.equal(normalizeRoutingMode("auto"), "auto");
    assert.equal(normalizeRoutingMode("everything"), "auto");
    assert.equal(normalizeRoutingMode(undefined), "auto");
    assert.equal(normalizeRoutingMode(7), "auto");
  });

  it("drops unknown slots and unknown modes from a hand-edited row", () => {
    assert.deepEqual(normalizeRoutingSlots({ script: "nvidia", script2: "nvidia", voice: "loud" }), { script: "nvidia" });
    assert.deepEqual(normalizeRoutingSlots(null), {});
    assert.deepEqual(normalizeRoutingSlots(["script"]), {});
    assert.deepEqual(normalizeRoutingSlots({ manager: "own" }), { manager: "own" });
  });
});

describe("routingModeFor", () => {
  const settings: RoutingSettings = { mode: "nvidia", slots: { voice: "own" }, updatedAt: null, updatedBy: null };

  it("prefers the slot override and otherwise follows the global mode", () => {
    assert.equal(routingModeFor(settings, "voice"), "own");
    assert.equal(routingModeFor(settings, "script"), "nvidia");
    assert.equal(routingModeFor(settings, "SCRIPT"), "nvidia");
  });

  it("falls back to the default when nothing is stored", () => {
    assert.equal(routingModeFor(null, "script"), DEFAULT_ROUTING.mode);
    assert.equal(routingModeFor(undefined, "script"), "auto");
  });
});

describe("decideRoute", () => {
  it("auto prefers the project's own worker", () => {
    const d = decideRoute({ ...base, mode: "auto", workerOnline: true, nvidiaConfigured: true, openaiConfigured: true });
    assert.equal(d.provider, "project");
  });

  it("auto falls back to NVIDIA, then OPENAI, and explains the choice", () => {
    assert.equal(decideRoute({ ...base, mode: "auto", nvidiaConfigured: true, openaiConfigured: true }).provider, "nvidia");
    assert.equal(decideRoute({ ...base, mode: "auto", openaiConfigured: true }).provider, "openai");
    const none = decideRoute({ ...base, mode: "auto" });
    assert.equal(none.provider, "none");
    assert.match(none.reason, /NVIDIA_API_KEY/);
  });

  it("nvidia forces the backup even while a worker is ONLINE", () => {
    const d = decideRoute({ ...base, mode: "nvidia", workerOnline: true, nvidiaConfigured: true });
    assert.equal(d.provider, "nvidia");
    assert.match(d.reason, /even while a project runtime is ONLINE/);
  });

  it("nvidia without a key refuses by name instead of pretending", () => {
    const d = decideRoute({ ...base, mode: "nvidia", workerOnline: true });
    assert.equal(d.provider, "none");
    assert.match(d.reason, /NVIDIA_API_KEY/);
  });

  it("own never uses a hosted model", () => {
    const offline = decideRoute({ ...base, mode: "own", nvidiaConfigured: true, openaiConfigured: true });
    assert.equal(offline.provider, "none");
    assert.match(offline.reason, /only project runtimes may answer/);
    assert.equal(decideRoute({ ...base, mode: "own", workerOnline: true }).provider, "project");
  });
});
