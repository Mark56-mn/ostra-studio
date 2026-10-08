// apps/api/src/lib/rateLimit.test.ts
// The limiter protects a metered (free) hosted account. It must allow exactly what it promises and
// refuse with a real retry hint — never a silent drop and never a fabricated success.

import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { resetRateLimits, takeToken } from "./rateLimit";

beforeEach(() => resetRateLimits());

describe("takeToken", () => {
  it("allows up to the limit, then refuses with a retry-after inside the window", () => {
    const t0 = 1_000_000;
    assert.equal(takeToken("nvidia", 2, 60_000, t0).allowed, true);
    assert.equal(takeToken("nvidia", 2, 60_000, t0 + 1).allowed, true);
    const refused = takeToken("nvidia", 2, 60_000, t0 + 2);
    assert.equal(refused.allowed, false);
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSec > 0 && refused.retryAfterSec <= 60);
  });

  it("frees the budget once the oldest call ages out of the window", () => {
    const t0 = 5_000_000;
    takeToken("nvidia", 1, 10_000, t0);
    assert.equal(takeToken("nvidia", 1, 10_000, t0 + 9_999).allowed, false);
    assert.equal(takeToken("nvidia", 1, 10_000, t0 + 10_001).allowed, true);
  });

  it("reports the remaining budget and counts down", () => {
    const t0 = 9_000_000;
    assert.equal(takeToken("k", 3, 60_000, t0).remaining, 2);
    assert.equal(takeToken("k", 3, 60_000, t0).remaining, 1);
    assert.equal(takeToken("k", 3, 60_000, t0).remaining, 0);
  });

  it("keeps buckets independent per key", () => {
    const t0 = 3_000_000;
    takeToken("a", 1, 60_000, t0);
    assert.equal(takeToken("b", 1, 60_000, t0).allowed, true);
  });

  it("clamps a nonsensical limit instead of disabling the guard", () => {
    const t0 = 2_000_000;
    assert.equal(takeToken("c", 0, 60_000, t0).allowed, true);
    assert.equal(takeToken("c", 0, 60_000, t0).allowed, false);
    assert.equal(takeToken("d", Number.NaN, 60_000, t0).allowed, true);
    assert.equal(takeToken("d", Number.NaN, 60_000, t0).allowed, false);
  });

  it("resetRateLimits clears every bucket", () => {
    takeToken("e", 1, 60_000, 1_000);
    assert.equal(takeToken("e", 1, 60_000, 1_001).allowed, false);
    resetRateLimits();
    assert.equal(takeToken("e", 1, 60_000, 1_002).allowed, true);
  });
});
