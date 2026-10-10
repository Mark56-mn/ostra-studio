// apps/web/src/lib/seasons.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { formatDateTime, gateLabel, seasonStatusLabel, type ProductionGate } from "./seasons.js";

describe("seasonStatusLabel", () => {
  it("says in plain words what each status means for the operator", () => {
    assert.equal(seasonStatusLabel("submitted"), "WAITING FOR YOUR DECISION");
    assert.equal(seasonStatusLabel("approved"), "APPROVED — production allowed");
    assert.equal(seasonStatusLabel("rejected"), "REJECTED — no production");
    assert.equal(seasonStatusLabel("draft"), "DRAFT — not submitted");
  });

  it("shows an unknown status as itself instead of crashing the list", () => {
    assert.equal(seasonStatusLabel("future_status"), "FUTURE_STATUS");
  });
});

describe("gateLabel", () => {
  it("reports an open gate by naming the approved season", () => {
    const gate: ProductionGate = { allowed: true, seasonId: "s0", seasonTitle: "Crimson Ink" };
    const label = gateLabel(gate);
    assert.equal(label.allowed, true);
    assert.match(label.text, /Crimson Ink/);
  });

  it("carries the backend's refusal verbatim when production is blocked", () => {
    const gate: ProductionGate = { allowed: false, reason: "Season 'X' is waiting for your decision.", status: "submitted" };
    const label = gateLabel(gate);
    assert.equal(label.allowed, false);
    assert.match(label.text, /waiting for your decision/);
  });

  it("never claims production is allowed when the gate is unknown", () => {
    const label = gateLabel(undefined);
    assert.equal(label.allowed, false);
    assert.match(label.text, /checking/);
  });
});

describe("formatDateTime", () => {
  it("formats a real timestamp", () => {
    assert.notEqual(formatDateTime("2026-10-09T10:00:00.000Z"), "—");
  });

  it("renders null and unparseable values as an em dash rather than 'Invalid Date'", () => {
    assert.equal(formatDateTime(null), "—");
    assert.equal(formatDateTime("nope"), "—");
  });
});
