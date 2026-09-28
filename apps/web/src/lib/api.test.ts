// apps/web/src/lib/api.test.ts
import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { apiBase, apiUrl, isBackendConfigured } from "./api.js";

const RENDER = "https://ostra-studio-1.onrender.com";
const original = process.env.NEXT_PUBLIC_API_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = RENDER;
});
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = original;
});

describe("apiUrl with NEXT_PUBLIC_API_URL set", () => {
  it("produces the exact Render endpoints", () => {
    assert.equal(apiUrl("/api/health"), `${RENDER}/api/health`);
    assert.equal(apiUrl("/api/providers"), `${RENDER}/api/providers`);
    assert.equal(apiUrl("/api/workers"), `${RENDER}/api/workers`);
  });

  it("never doubles the /api segment", () => {
    for (const p of ["/api/health", "/api/providers", "/api/workers", "/api/runtime/run-now"]) {
      assert.ok(!apiUrl(p).includes("/api/api/"), `doubled api segment for ${p}`);
    }
  });

  it("never drops /api when the caller asked for /api/health", () => {
    assert.ok(!apiUrl("/api/health").endsWith(`${RENDER}/health`));
  });

  it("normalizes a trailing slash on the base", () => {
    process.env.NEXT_PUBLIC_API_URL = `${RENDER}/`;
    assert.equal(apiBase(), RENDER);
    assert.equal(apiUrl("/api/health"), `${RENDER}/api/health`);
  });

  it("normalizes multiple trailing slashes and surrounding whitespace", () => {
    process.env.NEXT_PUBLIC_API_URL = `  ${RENDER}///  `;
    assert.equal(apiUrl("/api/health"), `${RENDER}/api/health`);
  });

  it("adds a leading slash when the caller omits it", () => {
    assert.equal(apiUrl("api/health"), `${RENDER}/api/health`);
  });

  it("keeps a base that already has a path prefix", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://gateway.example.com/ostra";
    assert.equal(apiUrl("/api/health"), "https://gateway.example.com/ostra/api/health");
  });

  it("reports backend configured", () => {
    assert.equal(isBackendConfigured(), true);
  });

  it("only uses NEXT_PUBLIC_* values (nothing secret is referenced)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("./api.ts", import.meta.url), "utf8");
    const envRefs = src.match(/process\.env\.[A-Z0-9_]+/g) ?? [];
    assert.ok(envRefs.length > 0);
    for (const ref of envRefs) {
      assert.ok(ref.includes("NEXT_PUBLIC_"), `${ref} would not be available in the browser`);
    }
  });
});

describe("apiUrl without NEXT_PUBLIC_API_URL (local dev shim)", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  it("returns a same-origin path", () => {
    assert.equal(apiBase(), "");
    assert.equal(apiUrl("/api/health"), "/api/health");
    assert.equal(isBackendConfigured(), false);
  });
});
