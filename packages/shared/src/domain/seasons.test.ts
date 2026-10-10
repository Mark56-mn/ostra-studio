// packages/shared/src/domain/seasons.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  applySeasonDecision,
  canEditSeason,
  canSubmitSeason,
  isProductionWorkerType,
  productionGate,
  seasonNotification,
  validateSeasonPackage,
} from "./seasons.js";

function validPackage() {
  return {
    title: "Crimson Ink",
    premise: "A calligrapher's ink rewrites reality.",
    episodes: [
      { number: 1, title: "The First Stroke", synopsis: "Mei discovers the ink." },
      { number: 2, title: "Bleed", synopsis: "The city notices." },
    ],
    characters: [{ name: "Mei", role: "lead", description: "Calligrapher" }],
    arcs: ["Mei learns the ink's cost"],
    ending: "Mei rewrites the final page and loses her memory of it.",
    assumptions: [{ question: "Is the ink alive?", assumption: "No — it is a tool with rules." }],
    productionEstimate: { images: 48, clips: 12, minutes: 8 },
  };
}

describe("validateSeasonPackage", () => {
  it("accepts a complete package and normalizes it", () => {
    const result = validateSeasonPackage(validPackage());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.package.title, "Crimson Ink");
    assert.equal(result.package.episodeCount, 2, "episode count falls back to the real list length");
    assert.deepEqual(result.package.episodes.map((e) => e.number), [1, 2]);
    assert.equal(result.package.assumptions[0]?.question, "Is the ink alive?");
  });

  it("refuses an incomplete package and names every problem at once", () => {
    const result = validateSeasonPackage({ title: "", episodes: [{ number: 1, title: "", synopsis: "" }], arcs: [] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    const text = result.errors.join(" | ");
    assert.match(text, /title is required/);
    assert.match(text, /episode 1: title is required/);
    assert.match(text, /synopsis is required/);
    assert.match(text, /at least one story arc/);
  });

  it("refuses duplicate episode numbers", () => {
    const pkg = validPackage();
    pkg.episodes.push({ number: 1, title: "Dup", synopsis: "x" });
    const result = validateSeasonPackage(pkg);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors.join(" "), /used twice/);
  });

  it("sorts episodes by number whatever order they arrive in", () => {
    const pkg = validPackage();
    pkg.episodes = [pkg.episodes[1]!, pkg.episodes[0]!];
    const result = validateSeasonPackage(pkg);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.package.episodes.map((e) => e.number), [1, 2]);
  });
});

describe("season lifecycle", () => {
  it("lets a drafted season be submitted, and refuses a duplicate submission", () => {
    assert.equal(canSubmitSeason({ status: "draft", episodes: [{ number: 1, title: "a", synopsis: "b" }] }).ok, true);
    const again = canSubmitSeason({ status: "submitted" });
    assert.equal(again.ok, false);
    assert.match(again.reason ?? "", /already waiting for your decision/);
  });

  it("refuses to submit a season with no episodes, by name", () => {
    const r = canSubmitSeason({ status: "draft", episodes: [] });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /no episodes yet/);
  });

  it("applies a human decision only to a submitted season", () => {
    assert.deepEqual(applySeasonDecision({ status: "submitted", title: "Crimson Ink" }, "approved"), {
      ok: true,
      status: "approved",
    });
    const notSubmitted = applySeasonDecision({ status: "draft" }, "approved");
    assert.equal(notSubmitted.ok, false);
    assert.match(notSubmitted.ok ? "" : notSubmitted.reason, /only a submitted season can be decided/);
  });

  it("never re-decides an approved season — a new season is the only way to change the story", () => {
    const r = applySeasonDecision({ status: "approved", title: "Crimson Ink" }, "rejected");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /already approved/);
  });

  it("locks an approved season against edits", () => {
    assert.equal(canEditSeason({ status: "approved" }).ok, false);
    assert.equal(canEditSeason({ status: "changes_requested" }).ok, true);
  });
});

describe("productionGate — no expensive work before approval (acceptance test)", () => {
  it("allows production when a season is approved", () => {
    const gate = productionGate([
      { id: "s1", status: "submitted", title: "New draft" },
      { id: "s0", status: "approved", title: "Crimson Ink" },
    ]);
    assert.equal(gate.allowed, true);
    if (!gate.allowed) return;
    assert.equal(gate.seasonId, "s0");
  });

  it("refuses production while a season is only submitted, and says a decision is waiting", () => {
    const gate = productionGate([{ id: "s1", status: "submitted", title: "Crimson Ink" }]);
    assert.equal(gate.allowed, false);
    if (gate.allowed) return;
    assert.equal(gate.status, "submitted");
    assert.match(gate.reason, /waiting for your decision/);
    assert.match(gate.reason, /\/seasons/);
  });

  it("refuses production when the project never proposed a season", () => {
    const gate = productionGate([], "p1");
    assert.equal(gate.allowed, false);
    if (gate.allowed) return;
    assert.equal(gate.status, "none");
    assert.match(gate.reason, /no approved season yet/);
    assert.match(gate.reason, /p1|no approved season/);
  });

  it("refuses production when only a rejected or stale draft exists", () => {
    const gate = productionGate([{ id: "s2", status: "rejected", title: "Bad idea" }]);
    assert.equal(gate.allowed, false);
    if (gate.allowed) return;
    assert.equal(gate.status, "rejected");
  });

  it("treats a missing season list exactly like an empty one", () => {
    assert.equal(productionGate(null).allowed, false);
    assert.equal(productionGate(undefined).allowed, false);
  });
});

describe("isProductionWorkerType", () => {
  it("gates the expensive worker types and leaves preparation work alone", () => {
    assert.equal(isProductionWorkerType("image"), true);
    assert.equal(isProductionWorkerType("voice"), true);
    assert.equal(isProductionWorkerType("video"), true);
    assert.equal(isProductionWorkerType("youtube"), true);
    assert.equal(isProductionWorkerType("script"), false, "writing the outline must not need approval");
  });
});

describe("seasonNotification", () => {
  it("asks for action only when a human decision is actually needed", () => {
    const submitted = seasonNotification("submitted", { id: "s1", title: "Crimson Ink" });
    assert.equal(submitted?.requiresAction, true);
    assert.equal(submitted?.kind, "season_submitted");
    const approved = seasonNotification("approved", { id: "s1", title: "Crimson Ink" });
    assert.equal(approved?.requiresAction, false);
    assert.equal(approved?.kind, "season_decided");
  });

  it("marks a rejection as critical and never invents a season name", () => {
    const rejected = seasonNotification("rejected", { id: "s1" });
    assert.equal(rejected?.severity, "critical");
    assert.match(rejected?.title ?? "", /Untitled season/);
  });
});
