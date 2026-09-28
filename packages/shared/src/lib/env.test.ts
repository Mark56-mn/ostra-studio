// packages/shared/src/lib/env.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  colabConfig,
  kaggleConfig,
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
  "KAGGLE_KERNEL_REF",
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
