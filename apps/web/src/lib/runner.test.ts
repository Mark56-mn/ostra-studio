// apps/web/src/lib/runner.test.ts
// The Runner's decision surface is pure: which row is the latest for a model, what the API's action
// means, and which runtimes can be started remotely at all. Everything here is asserted, no mocks.
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  isRemotelyStartable,
  latestByTarget,
  remoteStartKind,
  runActionLabel,
  runActionTone,
  runResultSentence,
  runRowLabel,
  runRowTone,
  targetKey,
  type RunnerHistoryRow,
} from "./runner.js";

function row(partial: Partial<RunnerHistoryRow>): RunnerHistoryRow {
  return {
    id: partial.id ?? "r1",
    worker_type: partial.worker_type ?? "script",
    runtime: partial.runtime ?? "kaggle",
    provider: partial.provider ?? "kaggle",
    trigger_source: partial.trigger_source ?? "run_now",
    result: partial.result ?? "requested",
    requested_at: partial.requested_at ?? "2026-09-29T10:00:00.000Z",
    ...partial,
  };
}

describe("targetKey", () => {
  it("is stable for the same worker/runtime pair", () => {
    assert.equal(targetKey("script", "kaggle"), "script/kaggle");
    assert.equal(targetKey("script", "kaggle"), targetKey("script", "kaggle"));
  });

  it("does not collide across runtimes", () => {
    assert.notEqual(targetKey("image", "colab"), targetKey("script", "kaggle"));
  });
});

describe("latestByTarget", () => {
  it("keeps one row per worker/runtime — the newest by requested_at", () => {
    const latest = latestByTarget([
      row({ id: "old", requested_at: "2026-09-29T09:00:00.000Z", result: "starting" }),
      row({ id: "new", requested_at: "2026-09-29T11:00:00.000Z", result: "requested" }),
      row({ id: "other", worker_type: "voice", runtime: "colab", requested_at: "2026-09-29T08:00:00.000Z" }),
    ]);
    assert.equal(Object.keys(latest).length, 2);
    assert.equal(latest["script/kaggle"]!.id, "new");
    assert.equal(latest["voice/colab"]!.id, "other");
  });

  it("does not confuse image and voice on the same colab runtime", () => {
    const latest = latestByTarget([
      row({ id: "img", worker_type: "image", runtime: "colab", provider: "colab-image" }),
      row({ id: "voc", worker_type: "voice", runtime: "colab", provider: "kokoro-82m" }),
    ]);
    assert.equal(latest["image/colab"]!.id, "img");
    assert.equal(latest["voice/colab"]!.id, "voc");
  });

  it("is empty for no rows", () => {
    assert.deepEqual(latestByTarget([]), {});
  });
});

describe("run actions", () => {
  it("labels known orchestrator actions", () => {
    assert.equal(runActionLabel("requested"), "START REQUESTED");
    assert.equal(runActionLabel("skipped_already_online"), "ALREADY ONLINE");
    assert.equal(runActionLabel("skipped_disabled"), "SWITCHED OFF");
    assert.equal(runActionLabel("not_autostartable"), "NOT AUTOSTARTABLE");
  });

  it("echoes an unknown action instead of guessing", () => {
    assert.equal(runActionLabel("something_new"), "SOMETHING NEW");
    assert.equal(runActionLabel(null), "NO ACTION");
  });

  it("never reports a requested start as a success", () => {
    assert.equal(runActionTone("requested"), "info");
    assert.equal(runActionTone("skipped_disabled"), "warn");
    assert.equal(runActionTone("not_autostartable"), "muted");
    assert.equal(runActionTone("failed"), "bad");
    assert.equal(runActionTone("skipped_already_online"), "ok");
  });
});

describe("history rows", () => {
  it("shows ONLINE as the only ok lifecycle state", () => {
    assert.equal(runRowTone(row({ status: "ONLINE", result: "requested" })), "ok");
    assert.equal(runRowTone(row({ status: "STARTING", result: "starting" })), "info");
    assert.equal(runRowTone(row({ status: "REQUESTED", result: "requested" })), "info");
    assert.equal(runRowTone(row({ status: "TIMEOUT", result: "timed_out" })), "bad");
    assert.equal(runRowTone(row({ status: "FAILED", result: "failed" })), "bad");
  });

  it("reports a skip as the skip it was, not as a failure", () => {
    assert.equal(runRowTone(row({ status: "CANCELLED", result: "skipped_disabled" })), "warn");
    assert.equal(runRowTone(row({ status: "CANCELLED", result: "skipped_already_online" })), "ok");
    assert.equal(runRowTone(row({ status: "CANCELLED", result: "not_autostartable" })), "muted");
  });

  it("labels the lifecycle pill from the persisted state", () => {
    assert.equal(runRowLabel(row({ status: "ONLINE", result: "requested" })), "ONLINE");
    assert.equal(runRowLabel(row({ status: "REQUESTED", result: "requested" })), "REQUESTED");
    assert.equal(runRowLabel(row({ status: "CANCELLED", result: "skipped_disabled" })), "SWITCHED OFF");
    assert.equal(runRowLabel(row({ status: "CANCELLED", result: "not_autostartable" })), "NOT AUTOSTARTABLE");
    assert.equal(runRowLabel(null), "NO RUNS YET");
  });
});

describe("runtime start paths", () => {
  it("treats kaggle and colab as remotely startable", () => {
    assert.equal(remoteStartKind("kaggle"), "kaggle");
    assert.equal(remoteStartKind("colab"), "colab");
    assert.equal(isRemotelyStartable("kaggle"), true);
    assert.equal(isRemotelyStartable("colab"), true);
  });

  it("treats local and api runtimes as having no start path", () => {
    assert.equal(remoteStartKind("local"), "none");
    assert.equal(remoteStartKind("api"), "none");
    assert.equal(isRemotelyStartable("local"), false);
    assert.equal(isRemotelyStartable("api"), false);
  });
});

describe("runResultSentence", () => {
  it("never calls a requested start online", () => {
    const s = runResultSentence({ httpStatus: 201, action: "requested" });
    assert.ok(s.includes("not ONLINE"), s);
  });

  it("explains each refusal in its own words", () => {
    assert.ok(runResultSentence({ httpStatus: 200, action: "skipped_already_online" }).includes("already online"));
    assert.ok(runResultSentence({ httpStatus: 200, action: "skipped_disabled" }).includes("switched off"));
    assert.ok(runResultSentence({ httpStatus: 409, action: "not_autostartable" }).includes("not_autostartable"));
  });

  it("appends the real error when the API supplied one", () => {
    const s = runResultSentence({ httpStatus: 400, action: "failed", error: "quota exceeded" });
    assert.ok(s.includes("quota exceeded"), s);
  });
});
