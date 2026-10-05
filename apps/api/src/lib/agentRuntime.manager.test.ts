// apps/api/src/lib/agentRuntime.manager.test.ts
// The Management Team is a HOSTED, OpenAI-compatible endpoint. These tests pin the exact HTTP contract
// (Bearer auth, `{base}/chat/completions`, JSON mode) and the honesty rule: ONLINE only after a real
// answer, ERROR with the real reason otherwise.

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
  callAgent,
  clearHostedProbeCache,
  managerBackend,
  probeHostedModel,
  resolveManagerBackend,
} from "./agentRuntime";

const MANAGER_KEYS = [
  "MANAGER_API_KEY",
  "MANAGER_BASE_URL",
  "MANAGER_CHAT_MODEL",
  "LIGHTNING_API_KEY",
  "LIGHTNING_BASE_URL",
  "LIGHTNING_CHAT_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_CHAT_MODEL",
] as const;
const clear: Record<string, undefined> = Object.fromEntries(MANAGER_KEYS.map((k) => [k, undefined]));

// The helper must await `fn` before restoring the environment, or a later assertion inside the body
// would run with the operator's own (absent) keys back in place.
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHostedProbeCache();
});

function stubFetch(handler: () => Response): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler();
  }) as unknown as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const LIGHTNING = {
  ...clear,
  MANAGER_API_KEY: "lightning-key",
  MANAGER_BASE_URL: "https://lightning.ai/api/v1/",
  MANAGER_CHAT_MODEL: "openai/gpt-5.6-luna",
};

describe("managerBackend", () => {
  it("targets the configured host and never leaks the key", async () => {
    await withEnv(LIGHTNING, async () => {
      const b = managerBackend();
      assert.equal(b.kind, "hosted_manager");
      assert.equal(b.endpoint, "https://lightning.ai/api/v1");
      assert.equal(b.model, "openai/gpt-5.6-luna");
      assert.equal(b.endpointHost, "lightning.ai");
      assert.ok(!JSON.stringify(b).includes("lightning-key"));
    });
  });

  it("is unavailable — with the key to set — when nothing is configured", async () => {
    await withEnv(clear, async () => {
      const { backend, status } = resolveManagerBackend();
      assert.equal(backend, null);
      assert.equal(status.available, false);
      assert.match(status.detail, /MANAGER_API_KEY/);
    });
  });
});

describe("callAgent against a hosted management model", () => {
  it("sends a bearer-authenticated JSON-mode request to /chat/completions", async () => {
    const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: '{"reply":"hi","actions":[]}' } }] }));
    await withEnv(LIGHTNING, async () => {
      const res = await callAgent(managerBackend(), [{ role: "user", content: "hello" }]);
      assert.equal(res.ok, true);
    });
    const call = calls.calls[0]!;
    assert.equal(call.url, "https://lightning.ai/api/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer lightning-key");
    const body = JSON.parse(String(call.init.body));
    assert.equal(body.model, "openai/gpt-5.6-luna");
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("joins array-shaped content parts instead of reporting an empty answer", async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: [{ type: "text", text: '{"reply":"hi"}' }] } }] }));
    await withEnv(LIGHTNING, async () => {
      const res = await callAgent(managerBackend(), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.content, '{"reply":"hi"}');
    });
  });

  it("reports the real HTTP failure instead of an answer", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    await withEnv(LIGHTNING, async () => {
      const res = await callAgent(managerBackend(), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, "HTTP_ERROR");
        assert.match(res.error, /401/);
      }
    });
  });

  it("refuses without a key rather than calling anything", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    await withEnv({ ...clear, MANAGER_BASE_URL: "https://lightning.ai/api/v1/" }, async () => {
      const res = await callAgent(managerBackend(), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, "UNREACHABLE");
    });
    assert.equal(calls.calls.length, 0);
  });
});

describe("probeHostedModel", () => {
  it("is ONLINE only after a real answer, and caches it for later polls", async () => {
    const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: "pong" } }] }));
    await withEnv(LIGHTNING, async () => {
      const first = await probeHostedModel(managerBackend(), { nowMs: 1_000 });
      assert.equal(first.status, "ONLINE");
      assert.equal(first.ok, true);
      const second = await probeHostedModel(managerBackend(), { nowMs: 2_000 });
      assert.equal(second.status, "ONLINE");
      // A second poll inside the TTL must not become another billable call.
      assert.equal(calls.calls.length, 1);
    });
  });

  it("is ERROR with the real reason when the model does not answer", async () => {
    stubFetch(() => jsonResponse({ error: "quota exceeded" }, 429));
    await withEnv(LIGHTNING, async () => {
      const h = await probeHostedModel(managerBackend(), { nowMs: 1_000 });
      assert.equal(h.status, "ERROR");
      assert.equal(h.ok, false);
      assert.match(String(h.reason), /429/);
    });
  });

  it("never throws when the transport fails", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    await withEnv(LIGHTNING, async () => {
      const h = await probeHostedModel(managerBackend(), { nowMs: 1_000 });
      assert.equal(h.status, "ERROR");
      assert.match(String(h.reason), /ENOTFOUND/);
    });
  });
});