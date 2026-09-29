// Shared slug helpers (pure + testable).
//
// `projects.slug` is guarded by the database check constraint `projects_slug_check`:
//   slug ~ '^[a-z0-9-]{2,64}$'
// Every slug we write must satisfy that exactly. Normalizing in one shared place means the API
// can never hand Postgres a value it will reject, and the UI shows the same shape it will store.

/** The exact shape enforced by the `projects_slug_check` constraint. */
export const SLUG_PATTERN = /^[a-z0-9-]{2,64}$/;

/** Longest slug the constraint allows. */
export const SLUG_MAX_LENGTH = 64;

/** True when `value` satisfies the database check constraint. */
export function isValidSlug(value: string | null | undefined): boolean {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

/**
 * Normalize arbitrary text into a valid slug body: lowercase, ASCII, alphanumeric + single
 * hyphens, no leading/trailing hyphen, at most 64 chars. Returns "" when nothing usable is left
 * (e.g. input was only punctuation), so the caller decides how to handle that — never a DB error.
 */
export function slugify(input: string | null | undefined): string {
  return String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop combining accents so "Café" -> "cafe"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of illegal characters collapses to one hyphen
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, ""); // also trims a hyphen left behind by truncation
}

/**
 * Resolve the slug for a new project. Prefers what the user typed, falls back to the title, and
 * returns "" only when neither yields something the constraint accepts (caller returns 400).
 * The result is always '' or a value valid under `projects_slug_check`.
 */
export function resolveProjectSlug(inputSlug: string | null | undefined, title: string | null | undefined): string {
  for (const candidate of [slugify(inputSlug), slugify(title)]) {
    if (isValidSlug(candidate)) return candidate;
  }
  return "";
}

/** How many suffix variants `slugCandidates` produces by default. */
export const SLUG_MAX_ATTEMPTS = 20;

/**
 * Candidate slugs for one create attempt, in order: the base slug first, then numeric-suffixed
 * variants used to dodge the UNIQUE index. Every entry is guaranteed to satisfy
 * `projects_slug_check` — the suffix is appended only after truncating the base so the result is
 * never longer than `SLUG_MAX_LENGTH`, and the trimmed suffix can never leave a trailing hyphen.
 * Returns [] when `baseSlug` itself is not a legal slug.
 */
export function slugCandidates(baseSlug: string, maxAttempts: number = SLUG_MAX_ATTEMPTS): string[] {
  if (!isValidSlug(baseSlug)) return [];
  const out = [baseSlug];
  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 1; attempt < attempts; attempt++) {
    const suffix = `-${attempt + 1}`;
    const candidate = `${baseSlug.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (isValidSlug(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Classify a Postgres write error for a slug insert so the API never echoes raw constraint text.
 * 23505 = unique_violation (slug taken → try the next candidate)
 * 23514 = check_violation (`projects_slug_check` rejected the value → caller must explain the shape)
 * 23502 = not_null_violation (a required column — including slug — arrived empty)
 */
export type SlugWriteErrorKind = "duplicate" | "invalid" | "other";

export function classifySlugWriteError(code: string | null | undefined): SlugWriteErrorKind {
  if (code === "23505") return "duplicate";
  if (code === "23514" || code === "23502") return "invalid";
  return "other";
}
