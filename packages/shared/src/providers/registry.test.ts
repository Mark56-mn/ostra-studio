// packages/shared/src/providers/registry.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { resolveRegistry } from "./registry.js";

const KEYS = [
  "KAGGLE_API_TOKEN",
  "KAGGLE_API_TOKEN_1",
  "KAGGLE_API_TOKEN_2",
  "KAGGLE_API_TOKEN_3",
  "KAGGLE_API_TOKEN_4",
  "NGROK_AUTHTOKEN",
  "KAGGLE_KERNEL_REF",
  "KAGGLE_SCRIPT_URL",
  "COLAB_IMAGE_URL",
  "KOKORO_VOICE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_CONNECTION_STRING",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_OAUTH_TOKEN",
  "COLAB_IMAGE_BOOTSTRAP_URL",
  "COLAB_VOICE_BOOTSTRAP_URL",
  "COLAB_BOOTSTRAP_URL",
] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  try {
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("resolveRegistry", () => {
  it("script is NOT_CONFIGURED (never OFFLINE-as-error) when kaggle is unwired", async () => {
    await withEnv({}, async () => {
      const reg = resolveRegistry();
      const h = await reg.script!.health();
      assert.equal(h.status, "NOT_CONFIGURED");
      assert.equal(h.ok, false);
      assert.match(String(h.reason), /KAGGLE_API_TOKEN/);
      assert.equal(reg.script!.providerName, "kaggle");
    });
  });

  it("legacy KAGGLE_SCRIPT_URL no longer configures the script provider", async () => {
    await withEnv({ KAGGLE_SCRIPT_URL: "https://old.example/kernel" }, async () => {
      const h = await resolveRegistry().script!.health();
      assert.equal(h.status, "NOT_CONFIGURED");
    });
  });

  it("script is configured-but-idle (OFFLINE) when token + kernel ref exist", async () => {
    await withEnv(
      { KAGGLE_API_TOKEN: "bettertrade:key", KAGGLE_KERNEL_REF: "bettertrade/notebook7eae283a4a" },
      async () => {
        const h = await resolveRegistry().script!.health();
        assert.equal(h.status, "OFFLINE");
        assert.equal(h.ok, false, "configuration alone must never be ONLINE");
        assert.match(String(h.reason), /not registered/);
      }
    );
  });

  it("image/voice are NOT_CONFIGURED until the Colab bootstrap exists", async () => {
    await withEnv({ GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_OAUTH_TOKEN: "ya29.tok" }, async () => {
      const reg = resolveRegistry();
      assert.equal((await reg.image!.health()).status, "NOT_CONFIGURED");
      assert.equal((await reg.voice!.health()).status, "NOT_CONFIGURED");
    });
  });

  it("storage reports NOT_CONFIGURED when Supabase is unwired (no fabricated ONLINE)", async () => {
    await withEnv({}, async () => {
      const h = await resolveRegistry().storage!.health();
      assert.equal(h.status, "NOT_CONFIGURED");
      assert.equal(h.ok, false);
      assert.equal(h.provider, "supabase-storage");
    });
  });

  it("storage does NOT become ONLINE just because NEXT_PUBLIC_SUPABASE_URL is set", async () => {
    // No service key -> still not configured; and no network call is attempted.
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }, async () => {
      const h = await resolveRegistry().storage!.health();
      assert.equal(h.status, "NOT_CONFIGURED");
    });
  });

  it("video and youtube are NOT_CONFIGURED", async () => {
    await withEnv({}, async () => {
      const reg = resolveRegistry();
      assert.equal((await reg.video!.health()).status, "NOT_CONFIGURED");
      assert.equal((await reg.youtube!.health()).status, "NOT_CONFIGURED");
    });
  });

  it("no provider ever reports ONLINE from configuration alone", async () => {
    await withEnv(
      {
        KAGGLE_API_TOKEN: "k",
        KAGGLE_KERNEL_REF: "o/s",
        GOOGLE_CLOUD_PROJECT: "p",
        GOOGLE_OAUTH_TOKEN: "t",
        COLAB_IMAGE_BOOTSTRAP_URL: "https://b",
        COLAB_VOICE_BOOTSTRAP_URL: "https://b",
      },
      async () => {
        const reg = resolveRegistry();
        for (const key of ["script", "image", "voice", "video", "youtube"] as const) {
          const h = await reg[key]!.health();
          assert.notEqual(h.status, "ONLINE", `${key} must not be ONLINE from config`);
          assert.equal(h.ok, false);
        }
      }
    );
  });
});
