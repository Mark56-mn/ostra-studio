// packages/shared/src/lib/env.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  colabConfig,
  kaggleApiTokens,
  kaggleApiTokensFor,
  kaggleConfig,
  kaggleKernelRef,
  kaggleKernelRefEnvName,
  supabaseConfigReason,
  supabaseServerConfigured,
  supabaseServerKey,
  supabaseServerUrl,
  supabaseUrlSource,
} from "./env.js";

const TOUCHED = [
  "SUPABASE_URL",
  "SUPABASE_CONNECTION_STRING",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "KAGGLE_API_TOKEN",
  "KAGGLE_API_TOKEN_1",
  "KAGGLE_API_TOKEN_2",
  "KAGGLE_API_TOKEN_3",
  "KAGGLE_API_TOKEN_4",
  "KAGGLE_API_TOKEN_5",
  "KAGGLE_API_TOKEN_10",
  "KAGGLE_API_TOKEN_2_ALT",
  "KAGGLE_API_TOKEN_BLANK",
  "EMMANUEL_OFOYE_KAGGLE_API_TOKEN",
  "KIDSCITY_KAGGLE_API_TOKEN",
  "NGROK_AUTHTOKEN",
  "KAGGLE_KERNEL_REF",
  "KAGGLE_KERNEL_REF_IMAGE",
  "KAGGLE_KERNEL_REF_VOICE",
  "KAGGLE_KERNEL_REF_OVERSEER",
  "KAGGLE_API_TOKEN_IMAGE",
  "KAGGLE_API_TOKEN_SCRIPT",
  "IMAGE_KAGGLE_API_TOKEN",
  "KAGGLE_SCRIPT_URL",
  "GOOGLE_CLOUD_PROJECT",
  "COLAB_PROJECT_ID",
  "GCP_PROJECT_ID",
  "GOOGLE_PROJECT_ID",
  "GOOGLE_OAUTH_TOKEN",
  "COLAB_OAUTH_TOKEN",
  "COLAB_ACCESS_TOKEN",
  "GOOGLE_ACCESS_TOKEN",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "COLAB_IMAGE_BOOTSTRAP_URL",
  "COLAB_VOICE_BOOTSTRAP_URL",
  "COLAB_BOOTSTRAP_URL",
  "COLAB_RUNTIME_SPEC",
] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of TOUCHED) saved[k] = process.env[k];
  try {
    for (const k of TOUCHED) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("per-agent kaggle slots", () => {
  it("names each slot's own kernel-ref env var (script keeps the original name)", () => {
    assert.equal(kaggleKernelRefEnvName("script"), "KAGGLE_KERNEL_REF");
    assert.equal(kaggleKernelRefEnvName("image"), "KAGGLE_KERNEL_REF_IMAGE");
    assert.equal(kaggleKernelRefEnvName("voice"), "KAGGLE_KERNEL_REF_VOICE");
    assert.equal(kaggleKernelRefEnvName("overseer"), "KAGGLE_KERNEL_REF_OVERSEER");
    assert.equal(kaggleKernelRefEnvName(" Council "), "KAGGLE_KERNEL_REF_COUNCIL");
  });

  it("reads a slot's own ref and NEVER another agent's kernel", () => {
    withEnv({ KAGGLE_KERNEL_REF: "bettertrade/notebook7eae283a4a", KAGGLE_KERNEL_REF_IMAGE: "emmanuelofoye/ostra-image-agent" }, () => {
      assert.equal(kaggleKernelRef("script"), "bettertrade/notebook7eae283a4a");
      assert.equal(kaggleKernelRef("image"), "emmanuelofoye/ostra-image-agent");
      // Voice has no ref configured: undefined, NOT the Script kernel.
      assert.equal(kaggleKernelRef("voice"), undefined);
    });
  });

  it("returns undefined for every slot when nothing is configured (no placeholder)", () => {
    withEnv({}, () => {
      for (const slot of ["script", "image", "voice", "overseer"] as const) {
        assert.equal(kaggleKernelRef(slot), undefined, `${slot} must not invent a ref`);
      }
    });
  });

  it("prefers a slot-labelled token, then every configured token", () => {
    withEnv(
      { KAGGLE_API_TOKEN_IMAGE: "emmanuelofoye:key4", KAGGLE_API_TOKEN_1: "bettertrade:key1", KAGGLE_API_TOKEN_2: "kidscity:key2" },
      () => {
        // Image's own labelled token is hoisted to the front; the rest keep their normal order.
        assert.deepEqual(kaggleApiTokensFor("image"), ["emmanuelofoye:key4", "bettertrade:key1", "kidscity:key2"]);
        // A slot-labelled token is a real token, so other slots still see it (last, in numbered/named order).
        assert.deepEqual(kaggleApiTokensFor("script"), ["bettertrade:key1", "kidscity:key2", "emmanuelofoye:key4"]);
      }
    );
  });

  it("accepts the owner-labelled token form (<NAME>_KAGGLE_API_TOKEN) for a slot", () => {
    withEnv({ IMAGE_KAGGLE_API_TOKEN: "emmanuelofoye:key4" }, () => {
      assert.equal(kaggleApiTokensFor("image")[0], "emmanuelofoye:key4");
    });
  });

  it("yields an empty candidate list when no token is set (never a placeholder)", () => {
    withEnv({}, () => assert.deepEqual(kaggleApiTokensFor("overseer"), []));
  });
});

describe("supabase server config", () => {
  it("not configured when nothing is set", () => {
    withEnv({}, () => {
      assert.equal(supabaseServerUrl(), undefined);
      assert.equal(supabaseServerConfigured(), false);
      assert.match(String(supabaseConfigReason()), /SUPABASE_URL/);
    });
  });

  it("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY is recognized (the Render case)", () => {
    withEnv({ SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" }, () => {
      assert.equal(supabaseServerConfigured(), true);
      assert.equal(supabaseUrlSource(), "SUPABASE_URL");
      assert.equal(supabaseServerKey(), "service-key");
      assert.equal(supabaseConfigReason(), undefined);
    });
  });

  it("does NOT require NEXT_PUBLIC_SUPABASE_URL (old registry bug)", () => {
    withEnv({ SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, () => {
      assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, undefined);
      assert.equal(supabaseServerConfigured(), true);
    });
  });

  it("precedence: SUPABASE_URL > SUPABASE_CONNECTION_STRING > NEXT_PUBLIC_SUPABASE_URL", () => {
    withEnv(
      {
        SUPABASE_URL: "https://a.supabase.co",
        SUPABASE_CONNECTION_STRING: "postgres://b",
        NEXT_PUBLIC_SUPABASE_URL: "https://c.supabase.co",
      },
      () => assert.equal(supabaseServerUrl(), "https://a.supabase.co")
    );
    withEnv({ SUPABASE_CONNECTION_STRING: "postgres://b", NEXT_PUBLIC_SUPABASE_URL: "https://c.supabase.co" }, () => {
      assert.equal(supabaseServerUrl(), "postgres://b");
      assert.equal(supabaseUrlSource(), "SUPABASE_CONNECTION_STRING");
    });
    withEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://c.supabase.co" }, () => {
      assert.equal(supabaseServerUrl(), "https://c.supabase.co");
      assert.equal(supabaseUrlSource(), "NEXT_PUBLIC_SUPABASE_URL");
      assert.equal(supabaseServerConfigured(), false, "URL without a key is not configured");
    });
  });

  it("key precedence prefers the service role, falls back to anon", () => {
    withEnv({ SUPABASE_URL: "https://a.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc", SUPABASE_ANON_KEY: "anon" }, () => {
      assert.equal(supabaseServerKey(), "svc");
    });
    withEnv({ SUPABASE_URL: "https://a.supabase.co", SUPABASE_ANON_KEY: "anon" }, () => {
      assert.equal(supabaseServerKey(), "anon");
      assert.equal(supabaseServerConfigured(), true);
    });
  });

  it("url without key reports the missing key by name, never a value", () => {
    withEnv({ SUPABASE_URL: "https://a.supabase.co" }, () => {
      const reason = String(supabaseConfigReason());
      assert.match(reason, /SUPABASE_SERVICE_ROLE_KEY/);
      assert.ok(!reason.includes("a.supabase.co"));
    });
  });
});

describe("kaggle config", () => {
  it("not configured without token (and explains why)", () => {
    withEnv({ KAGGLE_KERNEL_REF: "bettertrade/notebook7eae283a4a" }, () => {
      const c = kaggleConfig();
      assert.equal(c.configured, false);
      assert.match(String(c.reason), /KAGGLE_API_TOKEN/);
    });
  });

  it("not configured without kernel ref", () => {
    withEnv({ KAGGLE_API_TOKEN: "user:key" }, () => {
      const c = kaggleConfig();
      assert.equal(c.configured, false);
      assert.match(String(c.reason), /KAGGLE_KERNEL_REF/);
    });
  });

  it("configured with token + exact kernel ref", () => {
    withEnv({ KAGGLE_API_TOKEN: "bettertrade:secret", KAGGLE_KERNEL_REF: "bettertrade/notebook7eae283a4a" }, () => {
      const c = kaggleConfig();
      assert.equal(c.configured, true);
      assert.equal(c.kernelRef, "bettertrade/notebook7eae283a4a");
    });
  });

  it("kaggleApiTokens: plain name first, then numbered in numeric order, blank skipped", () => {
    withEnv(
      {
        KAGGLE_API_TOKEN: "user0:key0",
        KAGGLE_API_TOKEN_1: "user1:key1",
        KAGGLE_API_TOKEN_2: "user2:key2",
      },
      () => {
        assert.deepEqual(kaggleApiTokens(), ["user0:key0", "user1:key1", "user2:key2"]);
      }
    );
  });

  it("kaggleApiTokens: numeric order beats lexical (10 after 2), blanks skipped, aliases merged", () => {
    withEnv(
      {
        KAGGLE_API_TOKEN: "user0:key0",
        KAGGLE_API_TOKEN_1: "user1:key1",
        KAGGLE_API_TOKEN_2: "user2:key2",
        KAGGLE_API_TOKEN_10: "user10:key10",
        KAGGLE_API_TOKEN_2_ALT: "user1:key1", // duplicate value from another key name
        KAGGLE_API_TOKEN_BLANK: "   ",
      },
      () => {
        assert.deepEqual(kaggleApiTokens(), ["user0:key0", "user1:key1", "user2:key2", "user10:key10"]);
      }
    );
  });

  it("kaggleApiTokens: owner-labelled name (<NAME>_KAGGLE_API_TOKEN) is read, after numbered slots", () => {
    withEnv(
      {
        KAGGLE_API_TOKEN_1: "bettertrade:key1",
        EMMANUEL_OFOYE_KAGGLE_API_TOKEN: "emmanuelofoye:key4",
        KIDSCITY_KAGGLE_API_TOKEN: "kidscity:key2",
      },
      () => {
        // Order matters: numbered slots first so --token=1..3 keep meaning the same accounts.
        assert.deepEqual(kaggleApiTokens(), ["bettertrade:key1", "emmanuelofoye:key4", "kidscity:key2"]);
      },
    );
  });

  it("kaggleApiTokens: empty env yields empty list (never a placeholder token)", () => {
    withEnv({}, () => {
      assert.deepEqual(kaggleApiTokens(), []);
    });
  });

  it("kaggleConfig falls back to the first numbered token when the plain name is absent", () => {
    withEnv(
      { KAGGLE_API_TOKEN_1: "user1:key1", KAGGLE_API_TOKEN_2: "user2:key2", KAGGLE_KERNEL_REF: "bettertrade/notebook7eae283a4a" },
      () => {
        const c = kaggleConfig();
        assert.equal(c.configured, true);
        assert.equal(c.apiToken, "user1:key1");
        assert.equal(c.kernelRef, "bettertrade/notebook7eae283a4a");
      }
    );
  });

  it("does not use the legacy KAGGLE_SCRIPT_URL", () => {
    withEnv({ KAGGLE_SCRIPT_URL: "https://old.example/kernel" }, () => {
      assert.equal(kaggleConfig().configured, false);
    });
  });
});

describe("colab config", () => {
  it("names the missing project", () => {
    withEnv({}, () => {
      const c = colabConfig("image");
      assert.equal(c.configured, false);
      assert.match(String(c.reason), /GOOGLE_CLOUD_PROJECT/);
    });
  });

  it("names the missing token", () => {
    withEnv({ GOOGLE_CLOUD_PROJECT: "proj" }, () => {
      const c = colabConfig("image");
      assert.equal(c.configured, false);
      assert.match(String(c.reason), /GOOGLE_OAUTH_TOKEN/);
    });
  });

  it("names the missing bootstrap (runtime creation alone is not execution)", () => {
    withEnv({ GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_OAUTH_TOKEN: "ya29.tok" }, () => {
      const c = colabConfig("image");
      assert.equal(c.configured, false);
      assert.match(String(c.reason), /BOOTSTRAP_URL/);
    });
  });

  it("accepts the Colab aliases and becomes configured once bootstrap is set", () => {
    withEnv(
      {
        COLAB_PROJECT_ID: "proj",
        COLAB_OAUTH_TOKEN: "ya29.tok",
        COLAB_IMAGE_BOOTSTRAP_URL: "https://bootstrap.example/run",
      },
      () => {
        const c = colabConfig("image");
        assert.equal(c.configured, true);
        assert.equal(c.projectId, "proj");
      }
    );
  });

  it("voice reads the voice-specific bootstrap", () => {
    withEnv(
      {
        GOOGLE_CLOUD_PROJECT: "proj",
        GOOGLE_OAUTH_TOKEN: "ya29.tok",
        COLAB_VOICE_BOOTSTRAP_URL: "https://voice.example/run",
      },
      () => {
        const c = colabConfig("voice");
        assert.equal(c.configured, true);
        assert.equal(c.bootstrapUrl, "https://voice.example/run");
        // image must NOT inherit the voice bootstrap
        assert.equal(colabConfig("image").configured, false);
      }
    );
  });
});
