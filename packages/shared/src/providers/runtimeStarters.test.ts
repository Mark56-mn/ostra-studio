// packages/shared/src/providers/runtimeStarters.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { redactSecrets, ColabImageRuntimeStarter, ColabVoiceRuntimeStarter, KaggleRuntimeStarter, resolveRuntimeStarters, findStarter } from "./runtimeStarters.js";

describe("runtimeStarters", () => {
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

  it("redactSecrets returns null for null input", () => {
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(undefined), null);
  });

  it("Colab image returns NOT_AUTOSTARTABLE", async () => {
    const s = new ColabImageRuntimeStarter();
    assert.equal(s.autostartable, false);
    const r = await s.start({ worker_type:"image", runtime:"colab", provider:"colab-image", trigger_source:"scheduler:test" });
    assert.equal(r.ok, false);
    assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
  });

  it("Colab voice returns NOT_AUTOSTARTABLE", async () => {
    const s = new ColabVoiceRuntimeStarter();
    assert.equal(s.autostartable, false);
    const r = await s.start({ worker_type:"voice", runtime:"colab", provider:"kokoro-82m", trigger_source:"run_now" });
    assert.equal(r.ok, false);
    assert.equal((r as { code?: string }).code, "NOT_AUTOSTARTABLE");
  });

  it("Kaggle starter requires kernel ref", async () => {
    const s = new KaggleRuntimeStarter({ apiToken:"fake-token" });
    const r = await s.start({ worker_type:"script", runtime:"kaggle", provider:"kaggle", trigger_source:"scheduler:test", config:{} });
    assert.equal(r.ok, false);
  });

  it("Kaggle starter requires token", async () => {
    const s = new KaggleRuntimeStarter({});
    const r = await s.start({ worker_type:"script", runtime:"kaggle", provider:"kaggle", trigger_source:"scheduler:test", config:{ kernelRef:"x/y" } });
    assert.equal(r.ok, false);
    assert.equal((r as { code?: string }).code, "AUTH_FAILED");
  });

  it("Kaggle starter returns AUTH_FAILED when token missing", async () => {
    const s = new KaggleRuntimeStarter({ kernelRef:"mark56/test" });
    // env KAGGLE_API_TOKEN is undefined in test, so should fail auth
    const orig = process.env.KAGGLE_API_TOKEN;
    delete process.env.KAGGLE_API_TOKEN;
    const r = await s.start({ worker_type:"script", runtime:"kaggle", provider:"kaggle", trigger_source:"run_now", config:{} });
    assert.equal(r.ok, false);
    assert.equal((r as { code?: string }).code, "AUTH_FAILED");
    if (orig) process.env.KAGGLE_API_TOKEN = orig;
  });

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
    // voice path
    assert.equal(s!.runtime, "colab");
  });

  it("findStarter resolves colab image correctly", () => {
    const m = resolveRuntimeStarters();
    const s = findStarter(m, "colab", "colab-image");
    assert.ok(s);
    assert.equal(s!.runtime, "colab");
  });

  it("Kaggle starter with exec disabled returns disabled mode", async () => {
    const orig = process.env.KAGGLE_EXEC_DISABLED;
    process.env.KAGGLE_EXEC_DISABLED = "true";
    const s = new KaggleRuntimeStarter({ apiToken:"tok", kernelRef:"a/b" });
    const r = await s.start({ worker_type:"script", runtime:"kaggle", provider:"kaggle", trigger_source:"scheduler:test", config:{} });
    assert.equal(r.ok, false);
    // Should have provider_response with mode disabled
    assert.ok((r as { provider_response?: Record<string,unknown> }).provider_response);
    process.env.KAGGLE_EXEC_DISABLED = orig ?? "";
    if (!orig) delete process.env.KAGGLE_EXEC_DISABLED;
  });

  it("redactSecrets does not mutate original object", () => {
    const orig = { KAGGLE_API_TOKEN: "secret", keep: "value" };
    const redacted = redactSecrets(orig as Record<string,unknown>);
    assert.equal(orig.KAGGLE_API_TOKEN, "secret");
    assert.equal(redacted!["KAGGLE_API_TOKEN"], "[REDACTED]");
  });
});
