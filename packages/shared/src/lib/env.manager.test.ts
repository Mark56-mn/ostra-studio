// packages/shared/src/lib/env.manager.test.ts
// The management team's configuration. Any OpenAI-compatible endpoint must work (OpenAI, Lightning AI,
// a gateway): the contract is `base_url` + bearer key + `POST {base}/chat/completions`, never an SDK.

import assert from "node:assert";
import { describe, it } from "node:test";
import { managerConfig, DEFAULT_MANAGED_MODEL } from "./env";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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

describe("managerConfig", () => {
  it("is NOT_CONFIGURED with the exact key to set when no key is present", () => {
    withEnv(clear, () => {
      const cfg = managerConfig();
      assert.equal(cfg.configured, false);
      assert.match(String(cfg.reason), /MANAGER_API_KEY/);
      assert.equal(cfg.apiKey, undefined);
    });
  });

  it("accepts a Lightning AI endpoint exactly as the SDK example passes it", () => {
    withEnv(
      {
        ...clear,
        MANAGER_API_KEY: "lightning-key",
        MANAGER_BASE_URL: "https://lightning.ai/api/v1/",
        MANAGER_CHAT_MODEL: "openai/gpt-5.6-luna",
      },
      () => {
        const cfg = managerConfig();
        assert.equal(cfg.configured, true);
        assert.equal(cfg.baseUrl, "https://lightning.ai/api/v1/");
        assert.equal(cfg.model, "openai/gpt-5.6-luna");
        assert.equal(cfg.provider, "lightning");
        assert.equal(cfg.host, "lightning.ai");
      }
    );
  });

  it("falls back to the generic OpenAI-compatible vars", () => {
    withEnv({ ...clear, OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://gateway.example.com/v1" }, () => {
      const cfg = managerConfig();
      assert.equal(cfg.configured, true);
      assert.equal(cfg.baseUrl, "https://gateway.example.com/v1");
      assert.equal(cfg.model, DEFAULT_MANAGED_MODEL);
    });
  });

  it("never reports configured without a key, even when a base URL is set", () => {
    withEnv({ ...clear, MANAGER_BASE_URL: "https://lightning.ai/api/v1/" }, () => {
      assert.equal(managerConfig().configured, false);
    });
  });
});