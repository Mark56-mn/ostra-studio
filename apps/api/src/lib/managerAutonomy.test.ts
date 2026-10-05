// apps/api/src/lib/managerAutonomy.test.ts
// The autonomy gate. The management model may ASK for a runtime; this file proves the server decides,
// not the model, and that every refusal is reported instead of swallowed.

import assert from "node:assert";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { kaggleKernelRefEnvName, managerAutonomy } from "@ostra/shared";
import { applyManagerStarts, startableTargets } from "./managerAutonomy";

// The helper must await `fn` before restoring the environment: assertions run after `await` points
// inside the body, and a synchronous restore would pull the value out from under them.
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

describe("managerAutonomy", () => {
  it("defaults to off so an unconfigured operator grants nothing", async () => {
    await withEnv({ MANAGER_AUTONOMY: undefined }, async () => {
      assert.equal(managerAutonomy(), "off");
    });
  });

  it("reads the two granted levels and degrades anything unknown to off", async () => {
    await withEnv({ MANAGER_AUTONOMY: "instruct" }, async () => assert.equal(managerAutonomy(), "instruct"));
    await withEnv({ MANAGER_AUTONOMY: "FULL" }, async () => assert.equal(managerAutonomy(), "full"));
    await withEnv({ MANAGER_AUTONOMY: "yes-please" }, async () => assert.equal(managerAutonomy(), "off"));
  });
});

describe("startableTargets", () => {
  it("offers every Kaggle agent, refusing each one by name until its own kernel ref is set", async () => {
    await withEnv(
      {
        KAGGLE_KERNEL_REF: undefined,
        KAGGLE_KERNEL_REF_IMAGE: undefined,
        KAGGLE_KERNEL_REF_VOICE: undefined,
        KAGGLE_KERNEL_REF_OVERSEER: undefined,
      },
      async () => {
        const targets = startableTargets();
        assert.deepEqual(
          targets.map((t) => t.target),
          ["script", "image", "voice", "overseer"]
        );
        for (const t of targets) {
          assert.equal(t.ok, false, `${t.target} must refuse while its ref is unset`);
          assert.match(String(t.error), new RegExp(kaggleKernelRefEnvName(t.target)));
        }
      }
    );
  });

  it("marks every agent startable once its own notebook ref is configured", async () => {
    await withEnv(
      {
        KAGGLE_KERNEL_REF: "bettertrade/notebook7eae283a4a",
        KAGGLE_KERNEL_REF_IMAGE: "emmanuelofoye/ostra-image-agent",
        KAGGLE_KERNEL_REF_VOICE: "bettertrade/ostra-voice-agent",
        KAGGLE_KERNEL_REF_OVERSEER: "kidscity/ostra-showrunner-agent",
      },
      async () => {
        const targets = startableTargets();
        assert.equal(targets.length, 4);
        for (const t of targets) assert.equal(t.ok, true, `${t.target} should be startable`);
      }
    );
  });

  it("never offers a slot without a start path (video / youtube)", () => {
    const targets = startableTargets().map((t) => t.target);
    assert.ok(!targets.includes("video") && !targets.includes("youtube"));
  });
});

/** A Supabase stub that fails the test if the supervisor is ever reached. */
const noDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error("the supervisor must not be reached when autonomy is not full");
    },
  }
) as unknown as SupabaseClient;

describe("applyManagerStarts", () => {
  it("refuses every start and touches no database when autonomy is off", async () => {
    const out = await applyManagerStarts(noDatabase, ["script"], { autonomy: "off" });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.target, "script");
    assert.equal(out[0]?.ok, false);
    assert.equal(out[0]?.action, "refused_autonomy");
    assert.match(String(out[0]?.error), /MANAGER_AUTONOMY=off/);
  });

  it("refuses with the exact upgrade when autonomy is instruct", async () => {
    const out = await applyManagerStarts(noDatabase, ["script"], { autonomy: "instruct" });
    assert.equal(out[0]?.action, "refused_autonomy");
    assert.match(String(out[0]?.error), /MANAGER_AUTONOMY=full/);
  });

  it("dedupes repeated targets so one answer cannot start the same runtime twice", async () => {
    const out = await applyManagerStarts(noDatabase, ["script", "script", " SCRIPT "], { autonomy: "off" });
    assert.equal(out.length, 1);
  });

  it("rejects a target that is not a worker type before any start is attempted", async () => {
    const out = await applyManagerStarts(noDatabase, ["database"], { autonomy: "full" });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.action, "refused_unknown_target");
    assert.match(String(out[0]?.error), /database/);
  });
});