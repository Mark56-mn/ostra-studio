// packages/shared/src/lib/supabase.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkSupabaseHealth } from "./supabase.js";

type QueryResult = { error: unknown };

/** Minimal fake of the supabase-js query builder chain used by the health check. */
function fakeClient(result: QueryResult | (() => Promise<QueryResult>)): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        limit: () => (typeof result === "function" ? result() : Promise.resolve(result)),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("checkSupabaseHealth", () => {
  it("NOT_CONFIGURED when no client can be created", async () => {
    const saved = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_CONNECTION_STRING: process.env.SUPABASE_CONNECTION_STRING,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    };
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      const h = await checkSupabaseHealth();
      assert.equal(h.status, "NOT_CONFIGURED");
      assert.equal(h.ok, false);
      assert.match(String(h.reason), /SUPABASE_URL/);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });

  it("ONLINE only when a real query succeeds", async () => {
    const h = await checkSupabaseHealth(fakeClient({ error: null }));
    assert.equal(h.status, "ONLINE");
    assert.equal(h.ok, true);
    assert.equal(typeof h.latencyMs, "number");
  });

  it("DEGRADED when the schema is missing (connected but not migrated)", async () => {
    const h = await checkSupabaseHealth(
      fakeClient({ error: { message: 'relation "workers" does not exist', code: "42P01" } })
    );
    assert.equal(h.status, "DEGRADED");
    assert.equal(h.ok, false);
    assert.match(String(h.reason), /migrations/);
    assert.equal((h.detail as Record<string, unknown>)["code"], "42P01");
  });

  it("ERROR when the query fails for another reason (e.g. bad key)", async () => {
    const h = await checkSupabaseHealth(
      fakeClient({ error: { message: "Invalid API key", code: "401" } })
    );
    assert.equal(h.status, "ERROR");
    assert.match(String(h.reason), /Invalid API key/);
  });

  it("OFFLINE when Supabase cannot be reached", async () => {
    const h = await checkSupabaseHealth(
      fakeClient(() => Promise.reject(new Error("fetch failed")))
    );
    assert.equal(h.status, "OFFLINE");
    assert.match(String(h.reason), /unreachable/);
  });

  it("bounded timeout: a hanging query does not block forever", async () => {
    const client = fakeClient(() => new Promise<QueryResult>(() => {}));
    const h = await checkSupabaseHealth(client, 25);
    assert.equal(h.status, "OFFLINE");
    assert.match(String(h.reason), /timed out/);
  });

  it("never exposes a key or connection string in the result", async () => {
    const h = await checkSupabaseHealth(fakeClient({ error: null }));
    const text = JSON.stringify(h);
    assert.ok(!/service_role|eyJ/.test(text));
  });
});
