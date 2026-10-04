// apps/api/src/lib/providerHealth.test.ts
// Regression cover for the bug that made the dashboard report "not configured" for agents that were
// really running: provider slots were pinned to a planned runtime (image => "colab", voice => "colab")
// while the production agents register as Kaggle workers, so a live worker row was never matched and
// the slot fell through to NOT_CONFIGURED. Pure logic only — no database, no network.
import assert from "node:assert";
import { describe, it } from "node:test";
import type { WorkerHealthRow } from "@ostra/shared";
import { pickWorker, providerDefinitions } from "./providerHealth.js";

// Every env name these slots read. The list is matched as a pattern because the workspace .env
// already holds owner-labelled Kaggle tokens (EMMANUEL_OFOYE_KAGGLE_API_TOKEN) that would otherwise
// leak into these tests and make "nothing configured" unreachable.
const ENV_PATTERNS = [/KAGGLE_/, /GOOGLE_/, /COLAB_/, /^GCP_/, /^OPENAI_/];

function managedEnvKeys(): string[] {
  return Object.keys(process.env).filter((k) => ENV_PATTERNS.some((re) => re.test(k)));
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of managedEnvKeys()) saved[k] = process.env[k];
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function worker(over: Partial<WorkerHealthRow> & { type: string }): WorkerHealthRow {
  return {
    runtime: "kaggle",
    provider: "kaggle",
    status: "ONLINE",
    model: "Qwen/Qwen3-4B",
    last_heartbeat_at: new Date().toISOString(),
    heartbeat_timeout_sec: 90,
    ...over,
  } as WorkerHealthRow;
}

describe("pickWorker", () => {
  it("matches a Kaggle worker for a slot that accepts any runtime", () => {
    const rows = [worker({ type: "image" })];
    assert.equal(pickWorker(rows, "image", [])?.model, "Qwen/Qwen3-4B");
  });

  it("does not match a worker of another agent type", () => {
    assert.equal(pickWorker([worker({ type: "script" })], "image", []), null);
  });

  it("still filters by runtime when the slot names one", () => {
    assert.equal(pickWorker([worker({ type: "video", runtime: "kaggle" })], "video", ["local"]), null);
    assert.equal(pickWorker([worker({ type: "video", runtime: "local" })], "video", ["local"])?.runtime, "local");
  });

  it("prefers a live row over a stale one for the same agent", () => {
    const stale = worker({ type: "image", status: "OFFLINE", last_heartbeat_at: "2026-10-01T00:00:00.000Z" });
    const live = worker({ type: "image" });
    assert.equal(pickWorker([stale, live], "image", [])?.last_heartbeat_at, live.last_heartbeat_at);
    assert.equal(pickWorker([live, stale], "image", [])?.last_heartbeat_at, live.last_heartbeat_at);
  });
});

describe("providerDefinitions", () => {
  it("gives the four agent slots a Showrunner row and no hard-coded runtime", () => {
    withEnv({}, () => {
      const defs = providerDefinitions();
      assert.deepEqual(
        defs.filter((d) => ["script", "image", "voice", "overseer"].includes(d.id)).map((d) => d.id),
        ["script", "image", "voice", "overseer"]
      );
      for (const def of defs.filter((d) => ["script", "image", "voice", "overseer"].includes(d.id))) {
        assert.deepEqual(def.runtimes, [], `${def.id} must follow the runtime its worker actually registered on`);
      }
    });
  });

  it("keeps the non-deployed slots honestly NOT_CONFIGURED", () => {
    withEnv({ KAGGLE_API_TOKEN: "u:k", KAGGLE_KERNEL_REF: "bettertrade/notebook7eae283a4a" }, () => {
      const defs = providerDefinitions();
      const video = defs.find((d) => d.id === "video")!;
      const youtube = defs.find((d) => d.id === "youtube")!;
      assert.equal(video.configured, false);
      assert.match(String(video.configReason), /not deployed/);
      assert.equal(youtube.configured, false);
      assert.match(String(youtube.configReason), /YouTube OAuth/);
    });
  });

  it("treats a Kaggle token as sufficient configuration for the agent notebooks", () => {
    withEnv({ KAGGLE_API_TOKEN_1: "u:k", KAGGLE_KERNEL_REF: "bettertrade/notebook7eae283a4a" }, () => {
      const defs = providerDefinitions();
      for (const id of ["image", "voice", "overseer"]) {
        const def = defs.find((d) => d.id === id)!;
        assert.equal(def.configured, true, `${id} should be configured with a Kaggle token`);
        assert.equal(def.provider, "kaggle", `${id} default provider`);
      }
    });
  });

  it("names both runtimes in the reason when nothing is configured", () => {
    withEnv({}, () => {
      const image = providerDefinitions().find((d) => d.id === "image")!;
      assert.equal(image.configured, false);
      assert.match(String(image.configReason), /KAGGLE_API_TOKEN/);
      assert.match(String(image.configReason), /GOOGLE_CLOUD_PROJECT/);
    });
  });
});