// packages/shared/src/providers/nvidia.test.ts
// The NVIDIA module is a security boundary, so each rule is pinned to a test rather than a comment.

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  NVIDIA_DEFAULT_BASE_URL,
  NVIDIA_MODEL_CATALOG,
  buildNvidiaRequestBody,
  isAllowedNvidiaEndpoint,
  nvidiaEndpointHost,
  nvidiaModelEntry,
  nvidiaModelIds,
} from "./nvidia";

describe("isAllowedNvidiaEndpoint", () => {
  it("accepts the documented NIM host over https", () => {
    assert.equal(isAllowedNvidiaEndpoint(NVIDIA_DEFAULT_BASE_URL), true);
    assert.equal(isAllowedNvidiaEndpoint("https://integrate.api.nvidia.com/v1/"), true);
    assert.equal(isAllowedNvidiaEndpoint("https://api.nvidia.com/v1"), true);
  });

  it("rejects another host, which is what protects the operator's key", () => {
    assert.equal(isAllowedNvidiaEndpoint("https://attacker.example.com/v1"), false);
    assert.equal(isAllowedNvidiaEndpoint("https://integrate.api.nvidia.com.evil.com/v1"), false);
    assert.equal(isAllowedNvidiaEndpoint("https://key@attacker.example.com/v1"), false);
  });

  it("rejects plaintext http, bad input and credentials in the URL", () => {
    assert.equal(isAllowedNvidiaEndpoint("http://integrate.api.nvidia.com/v1"), false);
    assert.equal(isAllowedNvidiaEndpoint("https://user:pass@integrate.api.nvidia.com/v1"), false);
    assert.equal(isAllowedNvidiaEndpoint("not a url"), false);
    assert.equal(isAllowedNvidiaEndpoint(null), false);
    assert.equal(isAllowedNvidiaEndpoint(undefined), false);
  });

  it("reports the host safely and null for junk", () => {
    assert.equal(nvidiaEndpointHost("https://integrate.api.nvidia.com/v1"), "integrate.api.nvidia.com");
    assert.equal(nvidiaEndpointHost("  "), null);
    assert.equal(nvidiaEndpointHost(null), null);
  });
});

describe("NVIDIA model catalog", () => {
  it("matches ids exactly and refuses anything else", () => {
    assert.equal(nvidiaModelEntry("meta/llama-3.3-70b-instruct")?.label, "Llama 3.3 70B Instruct");
    assert.equal(nvidiaModelEntry("some/random-model"), null);
    assert.equal(nvidiaModelEntry(""), null);
    assert.equal(nvidiaModelEntry(null), null);
    // The default must be dispatchable, or every backup call would be a refusal.
    assert.ok(nvidiaModelIds().includes("meta/llama-3.3-70b-instruct"));
  });

  it("records a thinking switch only where the model documents one", () => {
    const qwen = nvidiaModelEntry("qwen/qwen3-next-80b-a3b-instruct");
    assert.deepEqual(qwen?.thinkingKwargs, { enable_thinking: true });
    assert.equal(nvidiaModelEntry("meta/llama-3.3-70b-instruct")?.thinkingKwargs, null);
    assert.ok(NVIDIA_MODEL_CATALOG.some((m) => m.thinkingKwargs !== null));
  });
});

describe("buildNvidiaRequestBody", () => {
  const messages = [{ role: "user", content: "hi" }];

  it("never forces JSON mode and never includes anything secret", () => {
    const entry = nvidiaModelEntry("meta/llama-3.3-70b-instruct")!;
    const body = buildNvidiaRequestBody({ model: entry, messages, maxTokens: 500, thinking: true });
    assert.equal(body["model"], "meta/llama-3.3-70b-instruct");
    assert.equal(body["stream"], false);
    assert.equal(body["response_format"], undefined);
    assert.equal(body["chat_template_kwargs"], undefined);
    assert.equal(body["max_tokens"], 500);
    assert.equal(JSON.stringify(body).includes("nvapi-"), false);
  });

  it("attaches the model's own thinking switch and floors the token budget", () => {
    const entry = nvidiaModelEntry("qwen/qwen3-next-80b-a3b-instruct")!;
    const body = buildNvidiaRequestBody({ model: entry, messages, maxTokens: 400, thinking: true });
    assert.deepEqual(body["chat_template_kwargs"], { enable_thinking: true });
    assert.equal(body["max_tokens"], 2048);
  });

  it("leaves the budget alone when thinking is off", () => {
    const entry = nvidiaModelEntry("qwen/qwen3-next-80b-a3b-instruct")!;
    const body = buildNvidiaRequestBody({ model: entry, messages, maxTokens: 400, thinking: false });
    assert.equal(body["chat_template_kwargs"], undefined);
    assert.equal(body["max_tokens"], 400);
  });

  it("keeps the caller's temperature", () => {
    const entry = nvidiaModelEntry("meta/llama-3.1-8b-instruct")!;
    assert.equal(buildNvidiaRequestBody({ model: entry, messages, maxTokens: 100, thinking: true, temperature: 0.9 })["temperature"], 0.9);
    assert.equal(buildNvidiaRequestBody({ model: entry, messages, maxTokens: 100, thinking: true })["temperature"], 0.4);
  });
});
