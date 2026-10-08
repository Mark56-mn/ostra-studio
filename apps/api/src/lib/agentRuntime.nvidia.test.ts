// apps/api/src/lib/agentRuntime.nvidia.test.ts
// The NVIDIA backup is the same OpenAI-compatible contract as the management team, plus four guards.
// These tests pin each guard to a real behaviour: the key is only sent to an allowlisted host, only
// catalog model ids are dispatched, reasoning is requested with the model's own switch, and the free
// tier is rate-limited with an honest retry-after.

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { NVIDIA_DEFAULT_MODEL, NVIDIA_RETIRED_MODELS } from "@ostra/shared";
import { callAgent, clearHostedProbeCache, nvidiaBackend } from "./agentRuntime";
import { resetRateLimits } from "./rateLimit";

const KEYS = [
  "NVIDIA_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "NVIDIA_BASE_URL",
  "NVIDIA_CHAT_MODEL",
  "NVIDIA_MODEL_SCRIPT",
  "NVIDIA_MODEL_IMAGE",
  "NVIDIA_THINKING",
  "NVIDIA_RATE_LIMIT_PER_MIN",
  "OPENAI_API_KEY",
  "MANAGER_API_KEY",
] as const;
const clear: Record<string, undefined> = Object.fromEntries(KEYS.map((k) => [k, undefined]));

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
  resetRateLimits();
});

function stubFetch(handler: () => Response): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler();
  }) as unknown as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ok = { choices: [{ message: { content: "hello" } }] };
const CONFIGURED = { ...clear, NVIDIA_API_KEY: "nvapi-secret-key" };

describe("nvidiaBackend", () => {
  it("reads the operator's per-slot model and never leaks the key", async () => {
    await withEnv({ ...CONFIGURED, NVIDIA_MODEL_IMAGE: "moonshotai/kimi-k3" }, async () => {
      const b = nvidiaBackend("image");
      assert.equal(b.kind, "hosted_nvidia");
      assert.equal(b.provider, "nvidia");
      assert.equal(b.model, "moonshotai/kimi-k3");
      assert.equal(b.endpoint, "https://integrate.api.nvidia.com/v1");
      assert.equal(b.endpointHost, "integrate.api.nvidia.com");
      assert.ok(!JSON.stringify(b).includes("nvapi-secret-key"));
    });
  });

  it("falls back to the shared default model for a slot with no override", async () => {
    await withEnv(CONFIGURED, async () => {
      // Imported, never restated: this test went red twice for reasons that had nothing to do with the
      // code, because the default model id was spelled out here by hand.
      assert.equal(nvidiaBackend("voice").model, NVIDIA_DEFAULT_MODEL);
    });
  });
});

describe("callAgent against the NVIDIA backup", () => {
  it("sends a bearer-authenticated request with no forced JSON mode", async () => {
    const calls = stubFetch(() => jsonResponse(ok));
    await withEnv(CONFIGURED, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, true);
    });
    const call = calls.calls[0]!;
    assert.equal(call.url, "https://integrate.api.nvidia.com/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer nvapi-secret-key");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    assert.equal(body.model, NVIDIA_DEFAULT_MODEL);
    assert.equal(body.response_format, undefined, "forcing JSON mode would suppress a reasoning trace");
    // The shipped default is a Nemotron 3 lane, which documents `enable_thinking`.
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(body.max_tokens, 2048, "thinking and the answer share the token budget");
  });

  it("requests reasoning with the model's OWN switch and leaves room for it", async () => {
    const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: "answer", reasoning_content: "why" } }] }));
    await withEnv({ ...CONFIGURED, NVIDIA_MODEL_SCRIPT: "nvidia/nemotron-3.5-lightning-30b-a3b" }, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }], { maxTokens: 300 });
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.reasoning, "why");
    });
    const body = JSON.parse(String(calls.calls[0]!.init.body)) as Record<string, unknown>;
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(body.max_tokens, 2048, "thinking and the answer share the token budget");
  });

  it("does not ask for thinking when the operator turned it off", async () => {
    const calls = stubFetch(() => jsonResponse(ok));
    await withEnv({ ...CONFIGURED, NVIDIA_MODEL_SCRIPT: "nvidia/nemotron-3.5-lightning-30b-a3b", NVIDIA_THINKING: "off" }, async () => {
      await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
    });
    const body = JSON.parse(String(calls.calls[0]!.init.body)) as Record<string, unknown>;
    assert.equal(body.chat_template_kwargs, undefined);
  });

  it("refuses to send the key to a host that is not allowlisted", async () => {
    const calls = stubFetch(() => jsonResponse(ok));
    await withEnv({ ...CONFIGURED, NVIDIA_BASE_URL: "https://attacker.example.com/v1" }, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, "UNREACHABLE");
        assert.match(res.error, /not an allowlisted NVIDIA endpoint/);
      }
    });
    assert.equal(calls.calls.length, 0, "nothing may be sent — not even the request — to that host");
  });

  it("refuses a model id that is not in the vetted catalog", async () => {
    const calls = stubFetch(() => jsonResponse(ok));
    await withEnv({ ...CONFIGURED, NVIDIA_MODEL_SCRIPT: "some/random-model" }, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, "UNREACHABLE");
        assert.match(res.error, /not in the vetted catalog/);
      }
    });
    assert.equal(calls.calls.length, 0);
  });

  it("refuses without a key instead of calling anything", async () => {
    const calls = stubFetch(() => jsonResponse(ok));
    await withEnv(clear, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error, /NVIDIA_API_KEY/);
    });
    assert.equal(calls.calls.length, 0);
  });

  it("rate-limits the free tier and reports a real retry-after", async () => {
    const calls = stubFetch(() => jsonResponse(ok));
    await withEnv({ ...CONFIGURED, NVIDIA_RATE_LIMIT_PER_MIN: "1" }, async () => {
      const first = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "one" }]);
      assert.equal(first.ok, true);
      const second = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "two" }]);
      assert.equal(second.ok, false);
      if (!second.ok) {
        assert.equal(second.code, "RATE_LIMITED");
        assert.ok((second.retryAfterSec ?? 0) > 0);
      }
    });
    assert.equal(calls.calls.length, 1, "the refused call must not reach the provider");
  });

  it("reports the real HTTP error instead of an answer", async () => {
    stubFetch(() => new Response("bad key", { status: 401 }));
    await withEnv(CONFIGURED, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, "HTTP_ERROR");
        assert.match(res.error, /401/);
      }
    });
  });

  // The production incident this guard exists for: NVIDIA end-of-lifed the value in NVIDIA_CHAT_MODEL
  // and answered 410 Gone. A 410 is a permanent verdict about one model id, so it must not be reported
  // as a retryable HTTP_ERROR, and the message must carry the re-pin, not just the status code.
  it("turns a 410 Gone into a named, permanent verdict with the re-pin", async () => {
    stubFetch(() =>
      new Response('{"title":"Gone","detail":"The model has reached its end of life."}', { status: 410 })
    );
    await withEnv({ ...CONFIGURED, NVIDIA_MODEL_SCRIPT: "nvidia/nemotron-3-super-120b-a12b" }, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, "MODEL_RETIRED");
        assert.equal(res.httpStatus, 410);
        assert.match(res.error, /nvidia\/nemotron-3-super-120b-a12b/);
        assert.match(res.error, /retired it for good/);
        assert.match(res.error, /pin a vetted id that answers/);
        assert.equal(res.retryAfterSec, undefined, "retiring is permanent — there is no retry to advise");
      }
    });
  });

  // Observed on the live account 2026-10-08: seven ids that ARE listed in GET /v1/models still answer
  // this 404 for the key. It is permanent for this pin, but it is not a retirement, so it must not
  // borrow that word.
  it("reports a NIM 404 as MODEL_UNAVAILABLE, not as a retirement", async () => {
    stubFetch(() =>
      new Response('{"status":404,"title":"Not Found","detail":"Function x: Not found for account y"}', { status: 404 })
    );
    await withEnv({ ...CONFIGURED, NVIDIA_MODEL_SCRIPT: "nvidia/nemotron-3-super-120b-a12b" }, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, "MODEL_UNAVAILABLE");
        assert.equal(res.httpStatus, 404);
        assert.match(res.error, /does not serve it for this account/);
        assert.match(res.error, new RegExp(NVIDIA_DEFAULT_MODEL.replace(/[/.]/g, "\\$&")));
      }
    });
  });

  it("refuses a retired pin locally, naming the successor, without touching the network", async () => {
    const calls = stubFetch(() => jsonResponse(ok));
    const dead = NVIDIA_RETIRED_MODELS[0]!;
    await withEnv({ ...CONFIGURED, NVIDIA_CHAT_MODEL: dead.id }, async () => {
      const res = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "hi" }]);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, "MODEL_RETIRED");
        assert.match(res.error, new RegExp(dead.id.replace(/[/.]/g, "\\$&")));
        assert.match(res.error, new RegExp(dead.successor.replace(/[/.]/g, "\\$&")));
        assert.match(res.error, /NVIDIA_CHAT_MODEL=/);
      }
    });
    assert.equal(calls.calls.length, 0, "a retired id can never succeed, so it must not spend a call");
  });

  it("does not spend a rate-limit token on a retired pin", async () => {
    stubFetch(() => jsonResponse(ok));
    await withEnv({ ...CONFIGURED, NVIDIA_RATE_LIMIT_PER_MIN: "1", NVIDIA_MODEL_SCRIPT: NVIDIA_RETIRED_MODELS[0]!.id }, async () => {
      const refused = await callAgent(nvidiaBackend("script"), [{ role: "user", content: "one" }]);
      assert.equal(refused.ok, false);
      if (!refused.ok) assert.equal(refused.code, "MODEL_RETIRED");
      // The refusal must not have consumed the single allowed call: a live pin still works afterwards.
      const live = await callAgent(
        { ...nvidiaBackend("script"), model: "nvidia/nemotron-3-super-120b-a12b" },
        [{ role: "user", content: "two" }]
      );
      assert.equal(live.ok, true);
    });
  });
});
