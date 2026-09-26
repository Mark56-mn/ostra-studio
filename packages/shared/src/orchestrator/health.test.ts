// packages/shared/src/orchestrator/health.test.ts — unit tests
import assert from "node:assert";
import { describe, it } from "node:test";
import { isHeartbeatStale } from "./state.js";

describe("heartbeat", () => {
  it("stale when missing", () => {
    assert.strictEqual(isHeartbeatStale(null), true);
    assert.strictEqual(isHeartbeatStale(undefined), true);
  });
  it("fresh 5s ago", () => {
    const now = Date.now();
    const at = new Date(now - 5_000).toISOString();
    assert.strictEqual(isHeartbeatStale(at, now, 90_000), false);
  });
  it("stale 95s ago with 90s timeout", () => {
    const now = Date.now();
    const at = new Date(now - 95_000).toISOString();
    assert.strictEqual(isHeartbeatStale(at, now, 90_000), true);
  });
  it("stale exactly at boundary +1ms", () => {
    const now = Date.now();
    const at = new Date(now - 90_001).toISOString();
    assert.strictEqual(isHeartbeatStale(at, now, 90_000), true);
  });
  it("fresh exactly at boundary", () => {
    const now = Date.now();
    const at = new Date(now - 90_000).toISOString();
    assert.strictEqual(isHeartbeatStale(at, now, 90_000), false);
  });
  it("fresh 89s ago with 90s timeout", () => {
    const now = Date.now();
    const at = new Date(now - 89_000).toISOString();
    assert.strictEqual(isHeartbeatStale(at, now, 90_000), false);
  });
  it("stale with custom threshold 30s", () => {
    const now = Date.now();
    const at = new Date(now - 31_000).toISOString();
    assert.strictEqual(isHeartbeatStale(at, now, 30_000), true);
  });
  it("OFFLINE transition: worker without heartbeat is stale", () => {
    assert.strictEqual(isHeartbeatStale("", Date.now(), 90_000), true);
  });
});
