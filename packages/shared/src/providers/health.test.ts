// packages/shared/src/providers/health.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  PROVIDER_IDS,
  STARTING_WINDOW_MS,
  deriveProviderHealth,
  isRecentStartupInProgress,
  makeHealth,
  statusOk,
  summarizeHealth,
  workerDisplayHealth,
  type WorkerHealthRow,
} from "./health.js";
import type { ProviderHealth } from "./contracts.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function worker(overrides: Partial<WorkerHealthRow> = {}): WorkerHealthRow {
  return {
    id: "w1",
    type: "script",
    runtime: "kaggle",
    provider: "kaggle",
    worker_id: "script-ai-kaggle",
    status: "ONLINE",
    endpoint: "https://abc123.ngrok.io",
    last_heartbeat_at: iso(5_000),
    heartbeat_timeout_sec: 90,
    ...overrides,
  };
}

describe("provider health contract", () => {
  it("exposes exactly the required status vocabulary", () => {
    assert.deepEqual([...PROVIDER_IDS], ["script", "image", "voice", "video", "youtube", "storage"]);
  });

  it("statusOk is true only for ONLINE", () => {
    assert.equal(statusOk("ONLINE"), true);
    for (const s of ["OFFLINE", "DEGRADED", "NOT_CONFIGURED", "STARTING", "ERROR", "UNKNOWN"] as const) {
      assert.equal(statusOk(s), false, `${s} must not be ok`);
    }
  });

  it("makeHealth never reports ok:true for non-ONLINE states", () => {
    for (const s of ["OFFLINE", "NOT_CONFIGURED", "STARTING", "ERROR", "UNKNOWN", "DEGRADED"] as const) {
      const h = makeHealth(s, { provider: "kaggle" });
      assert.equal(h.ok, false);
      assert.equal(h.status, s);
      assert.ok(h.checkedAt);
    }
    assert.equal(makeHealth("ONLINE").ok, true);
  });
});

describe("workerDisplayHealth", () => {
  it("ONLINE only when heartbeat is fresh", () => {
    const h = workerDisplayHealth(worker(), NOW);
    assert.equal(h.status, "ONLINE");
    assert.equal(h.ok, true);
    assert.equal(h.heartbeatAgeSec, 5);
    assert.equal(h.lastHeartbeatAt, iso(5_000));
  });

  it("OFFLINE with an explicit reason when the heartbeat expired", () => {
    const h = workerDisplayHealth(worker({ last_heartbeat_at: iso(4 * 60 * 1000 + 18 * 1000) }), NOW);
    assert.equal(h.status, "OFFLINE");
    assert.equal(h.ok, false);
    assert.match(String(h.reason), /heartbeat expired/);
    assert.equal(h.heartbeatAgeSec, 258);
  });

  it("OFFLINE when the worker has never heartbeated", () => {
    const h = workerDisplayHealth(worker({ last_heartbeat_at: null }), NOW);
    assert.equal(h.status, "OFFLINE");
    assert.match(String(h.reason), /heartbeat expired/);
  });

  it("ERROR when the worker itself is FAILED", () => {
    const h = workerDisplayHealth(worker({ status: "FAILED", error_message: "kernel crashed" }), NOW);
    assert.equal(h.status, "ERROR");
    assert.equal(h.reason, "kernel crashed");
  });

  it("OFFLINE for a worker whose status is not live", () => {
    const h = workerDisplayHealth(worker({ status: "DISCONNECTED" }), NOW);
    assert.equal(h.status, "OFFLINE");
    assert.match(String(h.reason), /worker status DISCONNECTED/);
  });

  it("does not leak credentials — only the endpoint host is exposed", () => {
    const h = workerDisplayHealth(worker({ endpoint: "https://abc.ngrok.io/path?token=secret" }), NOW);
    const detail = JSON.stringify(h.detail ?? {});
    assert.ok(detail.includes("abc.ngrok.io"));
    assert.ok(!detail.includes("secret"));
  });
});

describe("deriveProviderHealth", () => {
  const base = { id: "script" as const, provider: "kaggle", configured: true };

  it("NOT_CONFIGURED names the missing keys", () => {
    const h = deriveProviderHealth({
      ...base,
      configured: false,
      configReason: "Set KAGGLE_API_TOKEN and KAGGLE_KERNEL_REF on Render",
      nowMs: NOW,
    });
    assert.equal(h.status, "NOT_CONFIGURED");
    assert.equal(h.ok, false);
    assert.match(String(h.reason), /KAGGLE_API_TOKEN/);
  });

  it("configured but idle is OFFLINE, never ONLINE", () => {
    const h = deriveProviderHealth({ ...base, nowMs: NOW });
    assert.equal(h.status, "OFFLINE");
    assert.equal(h.ok, false);
  });

  it("fresh worker wins over a stale attempt", () => {
    const h = deriveProviderHealth({
      ...base,
      worker: worker(),
      attempt: { result: "failed", error: "old failure", requested_at: iso(3 * 60 * 60 * 1000) },
      nowMs: NOW,
    });
    assert.equal(h.status, "ONLINE");
    assert.equal(h.provider, "kaggle");
  });

  it("recent in-flight startup is STARTING (not OFFLINE)", () => {
    const h = deriveProviderHealth({
      ...base,
      attempt: { result: "requested", requested_at: iso(30_000), provider_run_id: "bettertrade/notebook7eae283a4a@v7" },
      nowMs: NOW,
    });
    assert.equal(h.status, "STARTING");
    assert.equal(h.ok, false);
    assert.match(String(h.reason), /has not registered yet/);
    assert.equal((h.detail as Record<string, unknown>)["providerRunId"], "bettertrade/notebook7eae283a4a@v7");
  });

  it("a very old in-flight attempt is no longer STARTING", () => {
    const h = deriveProviderHealth({
      ...base,
      attempt: { result: "starting", requested_at: iso(STARTING_WINDOW_MS + 60_000) },
      nowMs: NOW,
    });
    assert.equal(h.status, "OFFLINE");
  });

  it("stale worker beats a fresh-looking attempt order (worker state is authoritative)", () => {
    const h = deriveProviderHealth({
      ...base,
      worker: worker({ last_heartbeat_at: iso(10 * 60 * 1000) }),
      nowMs: NOW,
    });
    assert.equal(h.status, "OFFLINE");
    assert.match(String(h.reason), /heartbeat expired/);
  });

  it("failed attempt surfaces ERROR with its code", () => {
    const h = deriveProviderHealth({
      ...base,
      attempt: { result: "failed", error: "Kaggle auth failed (HTTP 401)", error_code: "AUTH_FAILED", requested_at: iso(60_000) },
      nowMs: NOW,
    });
    assert.equal(h.status, "ERROR");
    assert.equal((h.detail as Record<string, unknown>)["errorCode"], "AUTH_FAILED");
    assert.match(String(h.reason), /401/);
  });

  it("timed_out attempt surfaces ERROR", () => {
    const h = deriveProviderHealth({
      ...base,
      attempt: { result: "timed_out", error: "no registration in 10m", requested_at: iso(60_000) },
      nowMs: NOW,
    });
    assert.equal(h.status, "ERROR");
  });

  it("not_autostartable becomes NOT_CONFIGURED with the real blocker", () => {
    const h = deriveProviderHealth({
      ...base,
      attempt: { result: "not_autostartable", error: "Colab bootstrap not configured", requested_at: iso(60_000) },
      nowMs: NOW,
    });
    assert.equal(h.status, "NOT_CONFIGURED");
    assert.match(String(h.reason), /bootstrap/);
  });

  it("missing configuration reports NOT_CONFIGURED rather than OFFLINE", () => {
    assert.equal(deriveProviderHealth({ ...base, configured: false, nowMs: NOW }).status, "NOT_CONFIGURED");
  });

  it("isRecentStartupInProgress respects the window and the result set", () => {
    assert.equal(isRecentStartupInProgress({ result: "requested", requested_at: iso(1_000) }, NOW), true);
    assert.equal(isRecentStartupInProgress({ result: "registering", requested_at: iso(1_000) }, NOW), true);
    assert.equal(isRecentStartupInProgress({ result: "failed", requested_at: iso(1_000) }, NOW), false);
    assert.equal(isRecentStartupInProgress({ result: "requested", requested_at: iso(STARTING_WINDOW_MS + 1) }, NOW), false);
    assert.equal(isRecentStartupInProgress(null, NOW), false);
  });
});

describe("summarizeHealth", () => {
  const online: ProviderHealth = makeHealth("ONLINE");
  const offline: ProviderHealth = makeHealth("OFFLINE");

  it("DEGRADED when Supabase is not configured", () => {
    const r = summarizeHealth(makeHealth("NOT_CONFIGURED"), { script: offline });
    assert.equal(r.ok, false);
    assert.equal(r.status, "DEGRADED");
  });

  it("DEGRADED when Supabase is offline", () => {
    assert.equal(summarizeHealth(makeHealth("OFFLINE"), { script: online }).status, "DEGRADED");
  });

  it("ONLINE when Supabase is ONLINE and no provider errored (individual providers may be offline)", () => {
    const r = summarizeHealth(online, { script: offline, image: makeHealth("NOT_CONFIGURED") });
    assert.equal(r.ok, true);
    assert.equal(r.status, "ONLINE");
  });

  it("DEGRADED when a provider is in ERROR", () => {
    const r = summarizeHealth(online, { script: makeHealth("ERROR") });
    assert.equal(r.ok, false);
    assert.equal(r.status, "DEGRADED");
  });
});
