// packages/shared/src/lib/slug.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  classifySlugWriteError,
  isValidSlug,
  resolveProjectSlug,
  slugCandidates,
  slugify,
  SLUG_MAX_ATTEMPTS,
  SLUG_MAX_LENGTH,
} from "./slug.js";

// The constraint this defends: check (slug ~ '^[a-z0-9-]{2,64}$')  (= projects_slug_check)
describe("slugify", () => {
  it("lowercases and hyphenates free text", () => {
    assert.equal(slugify("Crimson Ink"), "crimson-ink");
    assert.equal(slugify("  My_Project!! "), "my-project");
    assert.equal(slugify("The Night the Ink Bled"), "the-night-the-ink-bled");
  });

  it("strips accents instead of dropping the letters", () => {
    assert.equal(slugify("Café Naïve"), "cafe-naive");
  });

  it("never leaves leading, trailing or doubled hyphens", () => {
    assert.equal(slugify("--Ink---Bleed--"), "ink-bleed");
    assert.equal(slugify("!!!ink!!!"), "ink");
  });

  it("caps the length at the constraint maximum without a trailing hyphen", () => {
    const long = "a".repeat(80);
    assert.equal(slugify(long).length, SLUG_MAX_LENGTH);
    // truncated mid-separator must not end with "-"
    const withSeparator = `${"a".repeat(63)} b`;
    assert.equal(slugify(withSeparator).endsWith("-"), false);
    assert.equal(slugify(withSeparator).length <= SLUG_MAX_LENGTH, true);
  });

  it("returns an empty string when nothing usable remains", () => {
    assert.equal(slugify(""), "");
    assert.equal(slugify("   "), "");
    assert.equal(slugify("!!!"), "");
    assert.equal(slugify(null), "");
    assert.equal(slugify(undefined), "");
  });

  it("only ever emits the allowed charset, without a leading/trailing hyphen", () => {
    for (const raw of ["Crimson Ink", "my_project", "Ünïcode!", "a", "-", "0 9", "x".repeat(200)]) {
      const out = slugify(raw);
      assert.equal(out === "" || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(out), true, `slugify(${JSON.stringify(raw)}) produced ${JSON.stringify(out)}`);
      assert.equal(out.length <= SLUG_MAX_LENGTH, true);
    }
  });
});

describe("resolveProjectSlug", () => {
  it("uses the user's slug when it is valid", () => {
    assert.equal(resolveProjectSlug("crimson-ink", "Something Else"), "crimson-ink");
  });

  it("normalizes a messy slug instead of rejecting it", () => {
    assert.equal(resolveProjectSlug("Crimson Ink", "Untitled"), "crimson-ink");
    assert.equal(resolveProjectSlug("my_project", "Untitled"), "my-project");
  });

  it("derives from the title when the slug is blank or too short", () => {
    assert.equal(resolveProjectSlug("", "Crimson Ink"), "crimson-ink");
    assert.equal(resolveProjectSlug(undefined, "Crimson Ink"), "crimson-ink");
    assert.equal(resolveProjectSlug("a", "Crimson Ink"), "crimson-ink");
  });

  it("returns empty (never an invalid value) when neither source is usable", () => {
    assert.equal(resolveProjectSlug("", "!!!"), "");
    assert.equal(resolveProjectSlug(null, null), "");
    assert.equal(resolveProjectSlug("a", "b"), "");
  });

  it("never returns a value the projects_slug_check constraint would reject", () => {
    const inputs: Array<[string | null | undefined, string | null | undefined]> = [
      ["Crimson Ink", "Untitled"], ["my_project", "Untitled"], ["", "Crimson Ink"],
      [undefined, "Crimson Ink"], ["a", "Crimson Ink"], ["", "!!!"], [null, null],
      ["a", "b"], ["-", "-"], ["x".repeat(200), "y"],
    ];
    for (const [rawSlug, rawTitle] of inputs) {
      const out = resolveProjectSlug(rawSlug, rawTitle);
      assert.equal(out === "" || isValidSlug(out), true, `resolveProjectSlug(${JSON.stringify(rawSlug)}, ${JSON.stringify(rawTitle)}) produced ${JSON.stringify(out)}`);
    }
  });
});

// The create path retries the UNIQUE index with a numeric suffix. Every candidate it tries must
// still satisfy projects_slug_check, including when the base slug is already near the 64-char cap.
describe("slugCandidates", () => {
  it("puts the base slug first, then suffixed variants", () => {
    const c = slugCandidates("crimson-ink");
    assert.equal(c[0], "crimson-ink");
    assert.equal(c[1], "crimson-ink-2");
    assert.equal(c[2], "crimson-ink-3");
    assert.equal(c.length, SLUG_MAX_ATTEMPTS);
  });

  it("returns [] for a base slug the constraint would reject", () => {
    assert.deepEqual(slugCandidates(""), []);
    assert.deepEqual(slugCandidates("a"), []);
    assert.deepEqual(slugCandidates("Crimson Ink"), []);
  });

  it("keeps every candidate inside the charset + length limit, even at the cap", () => {
    for (const base of ["crimson-ink", "a".repeat(SLUG_MAX_LENGTH), `${"a".repeat(63)}-`]) {
      for (const candidate of slugCandidates(base)) {
        assert.equal(isValidSlug(candidate), true, `candidate ${JSON.stringify(candidate)} (base ${base.length} chars)`);
      }
    }
    // the last variant of a capped slug must not overflow
    const last = slugCandidates("a".repeat(SLUG_MAX_LENGTH)).at(-1)!;
    assert.equal(last.length <= SLUG_MAX_LENGTH, true);
  });
});

describe("classifySlugWriteError", () => {
  it("maps real Postgres codes to the API's three outcomes", () => {
    assert.equal(classifySlugWriteError("23505"), "duplicate");
    assert.equal(classifySlugWriteError("23514"), "invalid");
    assert.equal(classifySlugWriteError("23502"), "invalid");
    assert.equal(classifySlugWriteError(undefined), "other");
    assert.equal(classifySlugWriteError("42P01"), "other");
  });
});
