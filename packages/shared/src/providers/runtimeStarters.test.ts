// packages/shared/src/providers/runtimeStarters.test.ts
import assert from "node:assert";
import { describe, it, afterEach } from "node:test";
import {
  redactSecrets,
  ColabImageRuntimeStarter,
  ColabVoiceRuntimeStarter,
  KaggleRuntimeStarter,
  resolveRuntimeStarters,
  findStarter,
} from "./runtimeStarters.js";

// Preserve original fetch and env to restore after each test
const originalFetch = globalThis.fetch;
const originalEnv: Record<string, string | undefined> = {};

function saveEnv(keys: string[]) {
  for (const k of keys) originalEnv[k] = process.env[k];
}
function restoreEnv(keys: string[]) {
  for (const k of keys) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
}
function clearEnv(keys: string[]) {
  for (const k of keys) delete process.env[k];
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  // env restored per-test via try/finally; global afterEach ensures fetch restored
});

describe("runtimeStarters", () => {
  // ── redactSecrets ───────────────────────────────────────────────
  it("redactSecrets hides tokens", () => {
    const r = redactSecrets({ KAGGLE_API_TOKEN: "secret123", kernelRef: "keep" });
    assert.equal(r!["KAGGLE_API_TOKEN"], "[REDACTED]");
    assert.equal(r!["kernelRef"], "keep");
  });

  it("redactSecrets handles lowercase token keys", () => {
    const r = redactSecrets({ token: "abc", api_token: "def", password: "ghi", safe: "keep" });
    assert.equal(r!["token"], "[REDACTED]");
    assert.equal(r!["api_token"], "[REDACTED]");
    assert.equal(r!["password"], "[REDACTED]");
    assert.equal(r!["safe"], "keep");
  });

  it("redactSecrets redacts long bearer-like values even with non-secret keys", () => {
    const long = "KGAT_" + "a".repeat(50);
    const r = redactSecrets({ someField: long, short: "keep" } as Record<string, unknown>);
    assert.equal(r!["someField"], "[REDACTED]");
    assert.equal(r!["short"], "keep");
  });

  it("redactSecrets redacts access_token and oauth_token", () => {
    const r = redactSecrets({ access_token: "abc", oauth_token: "def", safe: "keep" });
    assert.equal(r!["access_token"], "[REDACTED]");
    assert.equal(r!["oauth_token"], "[REDACTED]");
    assert.equal(r!["safe"], "keep");
  });

  it("redactSecrets returns null for null input", () => {
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(undefined), null);
  });

  it("redactSecrets does not mutate original object", () => {
    const orig: Record<string, unknown> = { KAGGLE_API_TOKEN: "secret", keep: "value" };
    const redacted = redactSecrets(orig);
    assert.equal(orig["KAGGLE_API_TOKEN"], "secret");
    assert.equal(redacted!["KAGGLE_API_TOKEN"], "[REDACTED]");
  });

  // ── Kaggle: missing config ────────────────────────────────────
  it("Kaggle starter requires kernel ref", async () => {
    const s = new KaggleRuntimeStarter({ apiToken: "fake-token" });
    // ensure env not interfering
    const orig = process.env.KAGGLE_KERNEL_REF;
    delete process.env.KAGGLE_KERNEL_REF;
    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: {} });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
    } finally {
      if (orig !== undefined) process.env.KAGGLE_KERNEL_REF = orig;
      else delete process.env.KAGGLE_KERNEL_REF;
    }
  });

  it("Kaggle starter requires token", async () => {
    const s = new KaggleRuntimeStarter({});
    const origTok = process.env.KAGGLE_API_TOKEN;
    const origRef = process.env.KAGGLE_KERNEL_REF;
    delete process.env.KAGGLE_API_TOKEN;
    delete process.env.KAGGLE_KERNEL_REF;
    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: { kernelRef: "x/y" } });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "AUTH_FAILED");
    } finally {
      if (origTok !== undefined) process.env.KAGGLE_API_TOKEN = origTok;
      if (origRef !== undefined) process.env.KAGGLE_KERNEL_REF = origRef;
    }
  });

  it("Kaggle starter returns AUTH_FAILED when token missing (env deleted)", async () => {
    const s = new KaggleRuntimeStarter({ kernelRef: "mark56/test" });
    const orig = process.env.KAGGLE_API_TOKEN;
    delete process.env.KAGGLE_API_TOKEN;
    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "run_now", config: {} });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "AUTH_FAILED");
    } finally {
      if (orig !== undefined) process.env.KAGGLE_API_TOKEN = orig;
    }
  });

  it("Kaggle starter with exec disabled returns disabled mode", async () => {
    const orig = process.env.KAGGLE_EXEC_DISABLED;
    process.env.KAGGLE_EXEC_DISABLED = "true";
    const s = new KaggleRuntimeStarter({ apiToken: "tok", kernelRef: "a/b" });
    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: {} });
      assert.equal(r.ok, false);
      assert.ok((r as { provider_response?: Record<string, unknown> }).provider_response);
    } finally {
      if (orig === undefined) delete process.env.KAGGLE_EXEC_DISABLED;
      else process.env.KAGGLE_EXEC_DISABLED = orig;
    }
  });

  // ── Kaggle: mocked fetch — success path ───────────────────────
  it("Kaggle push success returns real provider_run_id with versionNumber (no synthetic)", async () => {
    // env setup
    const envKeys = ["KAGGLE_API_TOKEN", "KAGGLE_KERNEL_REF", "KAGGLE_EXEC_DISABLED"] as const;
    saveEnv([...envKeys]);
    process.env.KAGGLE_API_TOKEN = "testuser:testkey";
    delete process.env.KAGGLE_EXEC_DISABLED;
    // Use kernelRef with owner/slug so resolveKaggleKernelRef returns immediately (no resolve fetch)
    const kernelRef = "mark56/test-kernel";
    const s = new KaggleRuntimeStarter({ apiToken: "testuser:testkey", kernelRef });

    // Mock fetch sequence: verify, get kernel, push
    const calls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${(init?.method ?? "GET")} ${url}`);
      if (url.includes("/api/v1/kernels/list?mine=true&pageSize=1")) {
        // verify auth — success
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/v1/kernels/mark56/test-kernel")) {
        // canonical get — return blob with source
        return new Response(
          JSON.stringify({
            blob: {
              source: "print('hello from test kernel')",
              language: "python",
              kernelType: "notebook",
              title: "test-kernel",
              isPrivate: true,
              enableInternet: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/api/v1/kernels/push")) {
        // push success — returns versionNumber
        return new Response(JSON.stringify({ ref: "mark56/test-kernel", versionNumber: 5, url: "https://www.kaggle.com/code/mark56/test-kernel" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not mocked", { status: 500 });
    };

    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: {} });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.ok(r.startup_request_id.startsWith("kaggle:"), `startup_request_id should start with kaggle: got ${r.startup_request_id}`);
        assert.equal(r.provider_run_id, "mark56/test-kernel@v5", `provider_run_id should be ref@vN, got ${r.provider_run_id}`);
        // invariant: never synthetic like kaggle:<id>
        assert.ok(!r.provider_run_id!.startsWith("kaggle:"), "provider_run_id must not be synthetic kaggle:...; must be real ref@vN");
        assert.ok(!r.provider_run_id!.includes("startup_request_id"), "provider_run_id must not leak startup_request_id");
        assert.equal(r.initial_state, "requested");
        // provider_response should not contain secrets
        assert.ok(r.provider_response);
      }
      // Ensure we called all three endpoints
      assert.ok(calls.some((c) => c.includes("list?mine=true&pageSize=1")));
      assert.ok(calls.some((c) => c.includes("/kernels/mark56/test-kernel")));
      assert.ok(calls.some((c) => c.includes("/kernels/push")));
    } finally {
      restoreEnv([...envKeys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Kaggle push success without versionNumber uses ref/url as provider_run_id (still real)", async () => {
    const envKeys = ["KAGGLE_API_TOKEN", "KAGGLE_EXEC_DISABLED"] as const;
    saveEnv([...envKeys]);
    process.env.KAGGLE_API_TOKEN = "user:key";
    delete process.env.KAGGLE_EXEC_DISABLED;
    const s = new KaggleRuntimeStarter({ apiToken: "user:key", kernelRef: "ownerX/slugY" });

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/kernels/list?mine=true&pageSize=1")) return new Response("[]", { status: 200 });
      if (url.includes("/kernels/ownerX/slugY")) {
        return new Response(JSON.stringify({ source: "print(1)", language: "python" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kernels/push")) {
        return new Response(JSON.stringify({ ref: "ownerX/slugY", url: "https://www.kaggle.com/code/ownerX/slugY" }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    };

    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "run_now", config: {} });
      assert.equal(r.ok, true);
      if (r.ok) {
        // Should be url or ref, not synthetic
        assert.ok(r.provider_run_id === "https://www.kaggle.com/code/ownerX/slugY" || r.provider_run_id === "ownerX/slugY");
        assert.ok(!r.provider_run_id!.startsWith("kaggle:"));
      }
    } finally {
      restoreEnv([...envKeys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Kaggle auth check failure 401 => AUTH_FAILED (verify step)", async () => {
    const envKeys = ["KAGGLE_API_TOKEN", "KAGGLE_EXEC_DISABLED"] as const;
    saveEnv([...envKeys]);
    process.env.KAGGLE_API_TOKEN = "bad:token";
    delete process.env.KAGGLE_EXEC_DISABLED;
    const s = new KaggleRuntimeStarter({ apiToken: "bad:token", kernelRef: "a/b" });

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/kernels/list?mine=true&pageSize=1")) {
        return new Response(JSON.stringify({ code: 401, message: "Unauthorized" }), { status: 401 });
      }
      return new Response("nope", { status: 500 });
    };

    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: {} });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "AUTH_FAILED");
      assert.ok(String((r as { error: string }).error).toLowerCase().includes("auth"));
    } finally {
      restoreEnv([...envKeys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Kaggle push 401 => AUTH_FAILED (push step)", async () => {
    const envKeys = ["KAGGLE_API_TOKEN", "KAGGLE_EXEC_DISABLED"] as const;
    saveEnv([...envKeys]);
    process.env.KAGGLE_API_TOKEN = "user:key2";
    delete process.env.KAGGLE_EXEC_DISABLED;
    const s = new KaggleRuntimeStarter({ apiToken: "user:key2", kernelRef: "u/slug" });

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/kernels/list?mine=true&pageSize=1")) return new Response("[]", { status: 200 });
      if (url.includes("/kernels/u/slug")) return new Response(JSON.stringify({ source: "x=1" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/kernels/push")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      return new Response("nope", { status: 500 });
    };

    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: {} });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "AUTH_FAILED");
    } finally {
      restoreEnv([...envKeys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Kaggle push validation failure when kernelText missing is not synthetic success", async () => {
    const envKeys = ["KAGGLE_API_TOKEN", "KAGGLE_EXEC_DISABLED"] as const;
    saveEnv([...envKeys]);
    process.env.KAGGLE_API_TOKEN = "user:key3";
    delete process.env.KAGGLE_EXEC_DISABLED;
    const s = new KaggleRuntimeStarter({ apiToken: "user:key3", kernelRef: "owner/slugMissingText" });

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/kernels/list?mine=true&pageSize=1")) return new Response("[]", { status: 200 });
      if (url.includes("/kernels/owner/slugMissingText")) {
        // Return 200 but without source/text, so kernelText stays null
        return new Response(JSON.stringify({ title: "empty", language: "python" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kernels/list?mine=true&pageSize=100&search=slugMissingText")) {
        // fallback from 404 path not hit because first was 200; but if code does 404 fallback, handle
        return new Response(JSON.stringify({ kernels: [] }), { status: 200 });
      }
      if (url.includes("/kernels/push")) {
        // Push with missing text should fail with validation — we mock Kaggle rejecting it
        return new Response(JSON.stringify({ error: "text is required" }), { status: 400 });
      }
      return new Response("nope", { status: 500 });
    };

    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: {} });
      // Must be failure, not ok:true with synthetic id
      assert.equal(r.ok, false, "push with missing text must not be synthetic success");
      // Code is UNKNOWN for 400
      assert.equal((r as { code?: string }).code, "UNKNOWN");
      // provider_run_id must not exist on failure
      assert.equal((r as { provider_run_id?: string }).provider_run_id, undefined);
    } finally {
      restoreEnv([...envKeys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Kaggle legacy notebook id resolution still results in real push (mocked)", async () => {
    const envKeys = ["KAGGLE_API_TOKEN", "KAGGLE_EXEC_DISABLED"] as const;
    saveEnv([...envKeys]);
    // Token JSON form with username
    const tokenJson = JSON.stringify({ username: "testuser2", key: "key2" });
    process.env.KAGGLE_API_TOKEN = tokenJson;
    delete process.env.KAGGLE_EXEC_DISABLED;
    const legacyRef = "notebook7eae283a4a";
    const s = new KaggleRuntimeStarter({ apiToken: tokenJson, kernelRef: legacyRef });

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // resolveKaggleKernelRef will call /kernels/list?mine=true&pageSize=100&search=notebook7eae283a4a
      if (url.includes("/kernels/list?mine=true&pageSize=100&search=") && url.includes("notebook7eae283a4a")) {
        return new Response(JSON.stringify([{ ref: "testuser2/notebook7eae283a4a", slug: "notebook7eae283a4a" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kernels/list?mine=true&pageSize=1")) return new Response("[]", { status: 200 });
      if (url.includes("/kernels/testuser2/notebook7eae283a4a")) {
        return new Response(JSON.stringify({ source: "print('legacy')", language: "python" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kernels/push")) {
        return new Response(JSON.stringify({ ref: "testuser2/notebook7eae283a4a", versionNumber: 2 }), { status: 200 });
      }
      return new Response("unknown", { status: 500 });
    };

    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: {} });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.provider_run_id, "testuser2/notebook7eae283a4a@v2");
      }
    } finally {
      restoreEnv([...envKeys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Kaggle bettertrade/notebook7eae283a4a real push returns real provider_run_id @vN with no synthetic", async () => {
    const envKeys = ["KAGGLE_API_TOKEN", "KAGGLE_KERNEL_REF", "KAGGLE_EXEC_DISABLED"] as const;
    saveEnv([...envKeys]);
    // Exact verified notebook for §38 — owner/slug form must bypass legacy resolution and push truly
    const token = "bettertrade:bettertrade-key-for-test";
    const kernelRef = "bettertrade/notebook7eae283a4a";
    process.env.KAGGLE_API_TOKEN = token;
    process.env.KAGGLE_KERNEL_REF = kernelRef;
    delete process.env.KAGGLE_EXEC_DISABLED;
    const s = new KaggleRuntimeStarter({ apiToken: token, kernelRef });
    const calls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      // resolveKaggleKernelRef with slash returns immediately — no search fetch expected
      if (url.includes("/api/v1/kernels/list?mine=true&pageSize=1")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/v1/kernels/bettertrade/notebook7eae283a4a") && (init?.method ?? "GET") !== "POST") {
        return new Response(JSON.stringify({ blob: { source: "print('hello bettertrade qwen')", language: "python", kernelType: "notebook", title: "notebook7eae283a4a", isPrivate: true, enableInternet: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/v1/kernels/push")) {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        // push must use owner/slug exactly and carry real text — never synthetic
        assert.equal(body["slug"], "bettertrade/notebook7eae283a4a");
        assert.ok(typeof body["text"] === "string" && (body["text"] as string).length > 0, "push text must be real kernel source");
        return new Response(JSON.stringify({ ref: "bettertrade/notebook7eae283a4a", versionNumber: 7, url: "https://www.kaggle.com/code/bettertrade/notebook7eae283a4a" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not mocked", { status: 500 });
    };
    try {
      const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:bettertrade-test", config: {} });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.ok(r.startup_request_id.startsWith("kaggle:"), `startup_request_id should be kaggle: got ${r.startup_request_id}`);
        assert.equal(r.provider_run_id, "bettertrade/notebook7eae283a4a@v7", `provider_run_id must be ref@vN for bettertrade, got ${r.provider_run_id}`);
        assert.ok(!r.provider_run_id!.startsWith("kaggle:"), "provider_run_id must not be synthetic kaggle:");
        assert.ok(r.provider_run_id!.includes("@v"), "provider_run_id must contain @v");
        assert.notEqual(r.provider_run_id, r.startup_request_id, "provider_run_id must not equal startup_request_id");
        assert.equal(r.initial_state, "requested", "initial_state must be requested, not ONLINE");
        assert.ok(r.provider_response, "provider_response present");
        // ensure no legacy search was triggered (has slash)
        assert.ok(!calls.some(c => c.includes("search=notebook7eae283a4a") && c.includes("pageSize=100")), "bettertrade/notebook7eae283a4a with slash should not trigger legacy search");
        assert.ok(calls.some(c => c.includes("/kernels/bettertrade/notebook7eae283a4a")));
        assert.ok(calls.some(c => c.includes("/kernels/push")));
      }
    } finally {
      restoreEnv([...envKeys]);
      globalThis.fetch = originalFetch;
    }
  });

  // ── Colab: truthful autostartable but checked at start time ──────
  it("Colab starters are autostartable=true (scheduler may attempt, start returns truthful code)", async () => {
    const sImg = new ColabImageRuntimeStarter();
    const sVoice = new ColabVoiceRuntimeStarter();
    assert.equal(sImg.autostartable, true);
    assert.equal(sVoice.autostartable, true);
  });

  it("Colab image missing project => NOT_AUTOSTARTABLE", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "COLAB_PROJECT_ID", "GCP_PROJECT_ID", "GOOGLE_PROJECT_ID", "GOOGLE_OAUTH_TOKEN", "COLAB_OAUTH_TOKEN"] as const;
    saveEnv([...keys]);
    clearEnv([...keys]);
    try {
      const s = new ColabImageRuntimeStarter();
      const r = await s.start({ worker_type: "image", runtime: "colab", provider: "colab-image", trigger_source: "scheduler:test" });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
      assert.ok(String((r as { error: string }).error).toLowerCase().includes("project"));
    } finally {
      restoreEnv([...keys]);
    }
  });

  it("Colab voice missing project => NOT_AUTOSTARTABLE", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "COLAB_PROJECT_ID", "GOOGLE_OAUTH_TOKEN", "COLAB_OAUTH_TOKEN"] as const;
    saveEnv([...keys]);
    clearEnv([...keys]);
    try {
      const s = new ColabVoiceRuntimeStarter();
      const r = await s.start({ worker_type: "voice", runtime: "colab", provider: "kokoro-82m", trigger_source: "run_now" });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
    } finally {
      restoreEnv([...keys]);
    }
  });

  it("Colab missing token => AUTH_FAILED (when project set)", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "COLAB_PROJECT_ID", "GOOGLE_OAUTH_TOKEN", "COLAB_OAUTH_TOKEN", "COLAB_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN", "COLAB_IMAGE_BOOTSTRAP_URL", "COLAB_BOOTSTRAP_URL"] as const;
    saveEnv([...keys]);
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    clearEnv(["GOOGLE_OAUTH_TOKEN", "COLAB_OAUTH_TOKEN", "COLAB_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN"]);
    // Ensure no bootstrap interferes — but missing token is checked before bootstrap, so we should hit AUTH_FAILED before NOT_AUTOSTARTABLE
    delete process.env.COLAB_IMAGE_BOOTSTRAP_URL;
    delete process.env.COLAB_BOOTSTRAP_URL;
    try {
      const s = new ColabImageRuntimeStarter();
      const r = await s.start({ worker_type: "image", runtime: "colab", provider: "colab-image", trigger_source: "scheduler:test" });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "AUTH_FAILED");
    } finally {
      restoreEnv([...keys]);
    }
  });

  it("Colab missing bootstrap => NOT_AUTOSTARTABLE (project+token set)", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "COLAB_PROJECT_ID", "GOOGLE_OAUTH_TOKEN", "COLAB_OAUTH_TOKEN", "COLAB_IMAGE_BOOTSTRAP_URL", "COLAB_BOOTSTRAP_URL", "COLAB_VOICE_BOOTSTRAP_URL", "COLAB_NOTEBOOK_URL"] as const;
    saveEnv([...keys]);
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.GOOGLE_OAUTH_TOKEN = "ya29.fake-token";
    delete process.env.COLAB_IMAGE_BOOTSTRAP_URL;
    delete process.env.COLAB_BOOTSTRAP_URL;
    delete process.env.COLAB_VOICE_BOOTSTRAP_URL;
    delete process.env.COLAB_NOTEBOOK_URL;
    try {
      const s = new ColabImageRuntimeStarter();
      const r = await s.start({ worker_type: "image", runtime: "colab", provider: "colab-image", trigger_source: "scheduler:test" });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
      assert.ok(String((r as { error: string }).error).includes("bootstrap"));
      assert.equal((r as { provider_response?: Record<string, unknown> }).provider_response?.["reason"], "bootstrap_not_configured");
    } finally {
      restoreEnv([...keys]);
    }
  });

  it("Colab missing bootstrap but notebook URL set => still NOT_AUTOSTARTABLE with hint", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_OAUTH_TOKEN", "COLAB_IMAGE_BOOTSTRAP_URL", "COLAB_BOOTSTRAP_URL", "COLAB_NOTEBOOK_URL"] as const;
    saveEnv([...keys]);
    process.env.GOOGLE_CLOUD_PROJECT = "proj2";
    process.env.GOOGLE_OAUTH_TOKEN = "ya29.fake2";
    delete process.env.COLAB_IMAGE_BOOTSTRAP_URL;
    delete process.env.COLAB_BOOTSTRAP_URL;
    process.env.COLAB_NOTEBOOK_URL = "https://colab.research.google.com/drive/abc123";
    try {
      const s = new ColabImageRuntimeStarter();
      const r = await s.start({ worker_type: "image", runtime: "colab", provider: "colab-image", trigger_source: "scheduler:test" });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
      assert.ok(String((r as { error: string }).error).includes("notebook URL alone is not an execution method"));
    } finally {
      restoreEnv([...keys]);
    }
  });

  it("Colab runtime spec not eligible => NOT_AUTOSTARTABLE", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_OAUTH_TOKEN", "COLAB_IMAGE_BOOTSTRAP_URL", "COLAB_RUNTIME_SPEC"] as const;
    saveEnv([...keys]);
    process.env.GOOGLE_CLOUD_PROJECT = "proj3";
    process.env.GOOGLE_OAUTH_TOKEN = "ya29.spec-token";
    process.env.COLAB_IMAGE_BOOTSTRAP_URL = "https://example.com/bootstrap";
    process.env.COLAB_RUNTIME_SPEC = "spec-not-eligible-v1";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1beta/runtimespecs")) {
        return new Response(JSON.stringify({ runtimeSpecs: [{ key: { id: "spec-not-eligible-v1" }, eligible: false }] }), { status: 200 });
      }
      return new Response("not expected", { status: 500 });
    };
    try {
      const s = new ColabImageRuntimeStarter();
      const r = await s.start({ worker_type: "image", runtime: "colab", provider: "colab-image", trigger_source: "scheduler:test" });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
      assert.ok(String((r as { error: string }).error).includes("not eligible"));
    } finally {
      restoreEnv([...keys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Colab successful runtime create returns real operation name as provider_run_id (no synthetic)", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_OAUTH_TOKEN", "COLAB_IMAGE_BOOTSTRAP_URL", "COLAB_RUNTIME_SPEC", "COLAB_RUNTIME_ID"] as const;
    saveEnv([...keys]);
    process.env.GOOGLE_CLOUD_PROJECT = "proj-success";
    process.env.GOOGLE_OAUTH_TOKEN = "ya29.success-token";
    process.env.COLAB_IMAGE_BOOTSTRAP_URL = "https://bootstrap.example/run";
    delete process.env.COLAB_RUNTIME_SPEC;
    delete process.env.COLAB_RUNTIME_ID;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("colaboratory.googleapis.com/v1beta/runtimes") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ name: "operations/colab-op-12345", done: false }), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    };

    try {
      const s = new ColabImageRuntimeStarter();
      const r = await s.start({ worker_type: "image", runtime: "colab", provider: "colab-image", trigger_source: "scheduler:test" });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.ok(r.startup_request_id.startsWith("colab:"), `startup_request_id should start with colab: got ${r.startup_request_id}`);
        assert.equal(r.provider_run_id, "operations/colab-op-12345");
        assert.ok(r.provider_run_id!.startsWith("operations/"), "provider_run_id should be real operation name");
        assert.ok(!r.provider_run_id!.startsWith("colab:"), "provider_run_id must not be synthetic colab:...");
        assert.equal(r.initial_state, "requested");
      }
    } finally {
      restoreEnv([...keys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Colab creation allowlist failure => NOT_AUTOSTARTABLE", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_OAUTH_TOKEN", "COLAB_VOICE_BOOTSTRAP_URL", "COLAB_BOOTSTRAP_URL", "COLAB_IMAGE_BOOTSTRAP_URL"] as const;
    saveEnv([...keys]);
    process.env.GOOGLE_CLOUD_PROJECT = "proj-allowlist";
    process.env.GOOGLE_OAUTH_TOKEN = "ya29.bad-allowlist";
    process.env.COLAB_VOICE_BOOTSTRAP_URL = "https://bootstrap.example/run";
    process.env.COLAB_BOOTSTRAP_URL = "https://bootstrap.example/run";
    process.env.COLAB_IMAGE_BOOTSTRAP_URL = "https://bootstrap.example/run";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("colaboratory.googleapis.com/v1beta/runtimes") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ error: { code: 403, message: "Failed precondition: not allowlisted for Colab API beta" } }), { status: 403 });
      }
      return new Response("nope", { status: 500 });
    };

    try {
      const s = new ColabVoiceRuntimeStarter();
      const r = await s.start({ worker_type: "voice", runtime: "colab", provider: "kokoro-82m", trigger_source: "run_now" });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
      assert.ok(String((r as { error: string }).error).toLowerCase().includes("allowlist"));
    } finally {
      restoreEnv([...keys]);
      globalThis.fetch = originalFetch;
    }
  });

  it("Colab creation auth failure 401 => AUTH_FAILED", async () => {
    const keys = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_OAUTH_TOKEN", "COLAB_IMAGE_BOOTSTRAP_URL"] as const;
    saveEnv([...keys]);
    process.env.GOOGLE_CLOUD_PROJECT = "proj-authfail";
    process.env.GOOGLE_OAUTH_TOKEN = "ya29.invalid";
    process.env.COLAB_IMAGE_BOOTSTRAP_URL = "https://bootstrap.example/run";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("colaboratory.googleapis.com/v1beta/runtimes") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ error: { code: 401, message: "Request had invalid authentication credentials" } }), { status: 401 });
      }
      return new Response("nope", { status: 500 });
    };

    try {
      const s = new ColabImageRuntimeStarter();
      const r = await s.start({ worker_type: "image", runtime: "colab", provider: "colab-image", trigger_source: "scheduler:test" });
      assert.equal(r.ok, false);
      assert.equal((r as { code?: string }).code, "AUTH_FAILED");
    } finally {
      restoreEnv([...keys]);
      globalThis.fetch = originalFetch;
    }
  });

  // ── General invariants ──────────────────────────────────────────
  it("Kaggle provider_run_id invariant: never synthetic even on retries", async () => {
    const envKeys = ["KAGGLE_API_TOKEN", "KAGGLE_EXEC_DISABLED"] as const;
    saveEnv([...envKeys]);
    process.env.KAGGLE_API_TOKEN = "u:k";
    delete process.env.KAGGLE_EXEC_DISABLED;
    const s = new KaggleRuntimeStarter({ apiToken: "u:k", kernelRef: "a/b2" });
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/kernels/list?mine=true&pageSize=1")) return new Response("[]", { status: 200 });
      if (url.includes("/kernels/a/b2")) return new Response(JSON.stringify({ source: "x=1", language: "python" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/kernels/push")) return new Response(JSON.stringify({ ref: "a/b2", versionNumber: 10 }), { status: 200 });
      return new Response("nope", { status: 500 });
    };
    try {
      for (let i = 0; i < 3; i++) {
        const r = await s.start({ worker_type: "script", runtime: "kaggle", provider: "kaggle", trigger_source: "scheduler:test", config: {} });
        assert.equal(r.ok, true);
        if (r.ok) {
          assert.ok(r.provider_run_id!.includes("@v"), `provider_run_id must contain @v, got ${r.provider_run_id}`);
          assert.ok(!r.provider_run_id!.includes("kaggle:"), "must not be synthetic");
          assert.notEqual(r.provider_run_id, r.startup_request_id);
        }
      }
    } finally {
      restoreEnv([...envKeys]);
      globalThis.fetch = originalFetch;
    }
  });

  // ── Registry ────────────────────────────────────────────────────
  it("resolveRuntimeStarters registers kaggle and colab starters", () => {
    const m = resolveRuntimeStarters();
    assert.ok(m.has("kaggle"));
    assert.ok(m.has("colab"));
    assert.ok(m.has("colab:image"));
    assert.ok(m.has("colab:voice"));
  });

  it("findStarter resolves kaggle by runtime", () => {
    const m = resolveRuntimeStarters();
    const s = findStarter(m, "kaggle", "kaggle");
    assert.ok(s);
    assert.equal(s!.runtime, "kaggle");
  });

  it("findStarter resolves colab voice correctly", () => {
    const m = resolveRuntimeStarters();
    const s = findStarter(m, "colab", "kokoro-82m");
    assert.ok(s);
    assert.equal(s!.runtime, "colab");
  });

  it("findStarter resolves colab image correctly", () => {
    const m = resolveRuntimeStarters();
    const s = findStarter(m, "colab", "colab-image");
    assert.ok(s);
    assert.equal(s!.runtime, "colab");
  });

  it("findStarter resolves generic colab to image", () => {
    const m = resolveRuntimeStarters();
    const s = findStarter(m, "colab", "unknown-provider");
    assert.ok(s);
    assert.equal(s!.provider, "colab-image");
  });
});
