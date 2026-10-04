// packages/shared/src/module-resolution.test.ts
// The web app bundles @ostra/shared with webpack (transpilePackages). Webpack does NOT rewrite a
// "./protocol.js" specifier back to protocol.ts, so one such import in a source file breaks every
// route that touches it (this is exactly what made /agents and /runner 500 while Bun and tsc passed).
// Bun resolves both forms, so only a test can catch it.
import assert from "node:assert";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    // Test files run under Bun, which resolves .js → .ts, so they are not part of the webpack path.
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("shared source imports", () => {
  const files = sourceFiles(SRC);

  it("finds the source tree", () => {
    assert.ok(files.length > 5, `only found ${files.length} source files under ${SRC}`);
  });

  it("never imports a relative sibling with a .js specifier", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+"(\.[^"]*\.js)"/g)) {
        offenders.push(`${file.slice(SRC.length)} → ${match[1]}`);
      }
    }
    assert.deepEqual(offenders, [], `webpack cannot resolve these:\n${offenders.join("\n")}`);
  });
});