// packages/shared/src/lib/cors.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_ALLOWED_ORIGINS, isOriginAllowed, parseAllowedOrigins, resolveAllowedOrigins } from "./cors.js";

const PROD = "https://ostra-studio-web.vercel.app";

describe("resolveAllowedOrigins", () => {
  it("always includes the production Vercel origin", () => {
    assert.ok(DEFAULT_ALLOWED_ORIGINS.includes(PROD));
    assert.ok(resolveAllowedOrigins().includes(PROD));
    assert.ok(resolveAllowedOrigins({ CORS_ORIGINS: "https://custom.example" }).includes(PROD));
  });

  it("merges explicit CORS_ORIGINS / WEB_ORIGIN without dropping the default", () => {
    const allowed = resolveAllowedOrigins({ CORS_ORIGINS: "https://a.example, https://b.example", WEB_ORIGIN: "https://c.example" });
    assert.ok(allowed.includes("https://a.example"));
    assert.ok(allowed.includes("https://c.example"));
    assert.ok(allowed.includes(PROD));
  });

  it("never allows a wildcard", () => {
    assert.ok(!resolveAllowedOrigins({ CORS_ORIGINS: "*" }).includes("*"));
    assert.ok(!isOriginAllowed("https://evil.example", resolveAllowedOrigins({ CORS_ORIGINS: "*" })));
  });

  it("ignores empty entries", () => {
    assert.deepEqual(parseAllowedOrigins(" , ,"), []);
  });
});

describe("isOriginAllowed", () => {
  const allowed = resolveAllowedOrigins();

  it("allows the production frontend origin", () => {
    assert.equal(isOriginAllowed(PROD, allowed), true);
  });

  it("allows non-browser callers with no Origin (curl, Render cron)", () => {
    assert.equal(isOriginAllowed(undefined, allowed), true);
  });

  it("blocks unrelated origins", () => {
    assert.equal(isOriginAllowed("https://evil.example", allowed), false);
    assert.equal(isOriginAllowed("https://ostra-studio-web.vercel.app.evil.com", allowed), false);
  });

  it("allows Vercel preview deployments", () => {
    assert.equal(isOriginAllowed("https://ostra-studio-web-git-main-mark56.vercel.app", allowed), true);
  });

  it("allows localhost development on any port (http and https)", () => {
    assert.equal(isOriginAllowed("http://localhost:3000", allowed), true);
    assert.equal(isOriginAllowed("http://127.0.0.1:5173", allowed), true);
    assert.equal(isOriginAllowed("https://localhost", allowed), true);
  });

  it("does not treat a lookalike domain as localhost", () => {
    assert.equal(isOriginAllowed("https://localhost.evil.com", allowed), false);
  });
});
