// packages/shared/src/providers/nvidia.test.ts
// The NVIDIA module is a security boundary, so each rule is pinned to a test rather than a comment.

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  NVIDIA_DEFAULT_BASE_URL,
  NVIDIA_DEFAULT_MODEL,
  NVIDIA_MODEL_CATALOG,
  NVIDIA_RETIRED_MODELS,
  buildNvidiaRequestBody,
  isAllowedNvidiaEndpoint,
  nvidiaEndpointHost,
  nvidiaModelEntry,
  nvidiaModelIds,
  nvidiaRetiredModel,
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

/**
 * The two shapes of catalog entry, taken FROM the catalog rather than restated, so a future re-pin
 * cannot turn these tests red for a reason that has nothing to do with the code.
 */
const WITH_SWITCH = NVIDIA_MODEL_CATALOG.find((m) => m.thinkingKwargs !== null)!;
const WITHOUT_SWITCH = NVIDIA_MODEL_CATALOG.find((m) => m.thinkingKwargs === null)!;

describe("NVIDIA model catalog", () => {
  it("matches ids exactly and refuses anything else", () => {
    assert.equal(nvidiaModelEntry(NVIDIA_DEFAULT_MODEL)?.label, "Nemotron 3 Super 120B");
    assert.equal(nvidiaModelEntry("some/random-model"), null);
    assert.equal(nvidiaModelEntry(""), null);
    assert.equal(nvidiaModelEntry(null), null);
    // The default must be dispatchable, or every backup call would be a refusal.
    assert.ok(nvidiaModelIds().includes(NVIDIA_DEFAULT_MODEL));
  });

  it("records a thinking switch only where the model documents one", () => {
    assert.ok(WITH_SWITCH && WITHOUT_SWITCH, "the catalog must keep both shapes reachable");
    assert.equal(nvidiaModelEntry(WITHOUT_SWITCH.id)?.thinkingKwargs, null);
    // Every recorded switch must be the documented `enable_thinking` kwarg: a guessed kwarg is a 400
    // and a silently broken agent, and the three Nemotron 3 lanes were verified to accept it 2026-10-08.
    for (const m of NVIDIA_MODEL_CATALOG) {
      if (m.thinkingKwargs) assert.deepEqual(m.thinkingKwargs, { enable_thinking: true }, m.id);
    }
  });

  // The bug this pins down: a retired id left in the catalog is dispatched on every request, spends a
  // retry slot and a share of the deadline, and answers nothing. A dead pin is worse than a missing one.
  it("never dispatches a retired id, and remembers what replaced it", () => {
    for (const retired of NVIDIA_RETIRED_MODELS) {
      assert.equal(nvidiaModelEntry(retired.id), null, `${retired.id} must not be dispatchable`);
      assert.equal(nvidiaModelIds().includes(retired.id), false);
      assert.ok(nvidiaModelIds().includes(retired.successor), `${retired.successor} must be a live catalog id`);
    }
    // The id this project shipped as its default until NVIDIA end-of-lifed it on 2026-08-26.
    const llama = nvidiaRetiredModel("meta/llama-3.3-70b-instruct");
    assert.equal(llama?.retiredOn, "2026-08-26");
    assert.match(llama?.note ?? "", /shipped default/);
    assert.equal(nvidiaRetiredModel("nvidia/nemotron-3-super-120b-a12b"), null);
    assert.equal(nvidiaRetiredModel(null), null);
  });
});

describe("buildNvidiaRequestBody", () => {
  const messages = [{ role: "user", content: "hi" }];

  it("never forces JSON mode and never includes anything secret", () => {
    const entry = WITHOUT_SWITCH;
    const body = buildNvidiaRequestBody({ model: entry, messages, maxTokens: 500, thinking: true });
    assert.equal(body["model"], entry.id);
    assert.equal(body["stream"], false);
    assert.equal(body["response_format"], undefined);
    assert.equal(body["chat_template_kwargs"], undefined);
    assert.equal(body["max_tokens"], 500);
    assert.equal(JSON.stringify(body).includes("nvapi-"), false);
  });

  it("attaches the model's own thinking switch and floors the token budget", () => {
    const entry = WITH_SWITCH;
    const body = buildNvidiaRequestBody({ model: entry, messages, maxTokens: 400, thinking: true });
    assert.deepEqual(body["chat_template_kwargs"], entry.thinkingKwargs);
    assert.equal(body["max_tokens"], 2048, "thinking and the answer share the 900-token default budget");
  });

  it("leaves the budget alone when thinking is off", () => {
    const entry = WITH_SWITCH;
    const body = buildNvidiaRequestBody({ model: entry, messages, maxTokens: 400, thinking: false });
    assert.equal(body["chat_template_kwargs"], undefined);
    assert.equal(body["max_tokens"], 400);
  });

  it("keeps the caller's temperature", () => {
    const entry = WITHOUT_SWITCH;
    assert.equal(buildNvidiaRequestBody({ model: entry, messages, maxTokens: 100, thinking: true, temperature: 0.9 })["temperature"], 0.9);
    assert.equal(buildNvidiaRequestBody({ model: entry, messages, maxTokens: 100, thinking: true })["temperature"], 0.4);
  });
});
