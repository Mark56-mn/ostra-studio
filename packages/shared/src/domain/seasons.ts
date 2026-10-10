// packages/shared/src/domain/seasons.ts
// SEASON-FIRST APPROVAL (spec §5): the Manager AI develops a COMPLETE season package, the human
// approves or rejects THAT package once, and only then may expensive production begin.
//
// This module owns every DECISION about a season, as pure functions, so the API route, the dashboard
// and the tests all agree on one rule and nothing can quietly advance a season's status.
//
// Truth rules (CONSTRAINTS.md):
//  - A season's status only ever moves because a human decided it, or because its author edited it
//    while still in `draft`. There is no code path that approves a season.
//  - `assumptions` carries the questions the Manager could not resolve alone, so they reach the human
//    WITH the package instead of being silently guessed.
//  - The production gate refuses loudly, by name, rather than silently dropping work: a refused task
//    says which season status is missing and where to fix it.

export const SEASON_STATUSES = ["draft", "submitted", "approved", "changes_requested", "rejected"] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

/** The decisions a human may take on a submitted season. `pending` is not a decision. */
export const SEASON_DECISIONS = ["approved", "changes_requested", "rejected"] as const;
export type SeasonDecision = (typeof SEASON_DECISIONS)[number];

/** Worker types whose output costs real generation quota or rendering time (spec §5 Phase 3). */
export const PRODUCTION_WORKER_TYPES = ["image", "voice", "video", "youtube"] as const;
export type ProductionWorkerType = (typeof PRODUCTION_WORKER_TYPES)[number];

export type SeasonEpisodeEntry = { number: number; title: string; synopsis: string };
export type SeasonCharacterEntry = { name: string; role?: string | null; description?: string | null };
export type SeasonAssumption = { question: string; assumption: string | null };

export type SeasonPackage = {
  title: string;
  premise: string | null;
  episodeCount: number;
  episodes: SeasonEpisodeEntry[];
  characters: SeasonCharacterEntry[];
  world: Record<string, unknown>;
  arcs: string[];
  ending: string | null;
  assumptions: SeasonAssumption[];
  productionEstimate: Record<string, unknown>;
};

export type SeasonLike = {
  status: SeasonStatus;
  /** Nullable because the database column is nullable — callers pass rows straight through. */
  title?: string | null;
  episodeCount?: number;
  episodes?: SeasonEpisodeEntry[];
};

export type ValidationResult = { ok: true; package: SeasonPackage } | { ok: false; errors: string[] };

// ── validation ──────────────────────────────────────────────────────────────

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const s = asString(item);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

const MAX_EPISODES = 60;

/**
 * Validate what the human will actually be asked to approve. An incomplete package is refused here,
 * with every problem named at once — the Manager must not present a season it has not actually
 * outlined.
 */
export function validateSeasonPackage(input: unknown): ValidationResult {
  const errors: string[] = [];
  const body = (input ?? {}) as Record<string, unknown>;

  const title = asString(body.title);
  if (!title) errors.push("title is required");
  else if (title.length > 160) errors.push("title is too long (max 160 characters)");

  const premise = asString(body.premise);

  const rawEpisodes = Array.isArray(body.episodes) ? body.episodes : [];
  const episodes: SeasonEpisodeEntry[] = [];
  if (rawEpisodes.length === 0) errors.push("a season needs at least one episode with a synopsis");
  if (rawEpisodes.length > MAX_EPISODES) errors.push(`too many episodes (max ${MAX_EPISODES})`);
  const seenNumbers = new Set<number>();
  rawEpisodes.forEach((raw, i) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const number = typeof e.number === "number" && Number.isFinite(e.number) ? Math.trunc(e.number) : i + 1;
    const eTitle = asString(e.title);
    const synopsis = asString(e.synopsis);
    if (number < 1) errors.push(`episode ${i + 1}: number must be >= 1`);
    if (seenNumbers.has(number)) errors.push(`episode number ${number} is used twice`);
    seenNumbers.add(number);
    if (!eTitle) errors.push(`episode ${number}: title is required`);
    if (!synopsis) errors.push(`episode ${number}: synopsis is required (the human approves the story)`);
    episodes.push({ number, title: eTitle ?? `Episode ${number}`, synopsis: synopsis ?? "" });
  });
  episodes.sort((a, b) => a.number - b.number);

  const rawCharacters = Array.isArray(body.characters) ? body.characters : [];
  const characters: SeasonCharacterEntry[] = [];
  rawCharacters.forEach((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const name = asString(c.name);
    if (!name) {
      errors.push(`character ${i + 1}: name is required`);
      return;
    }
    characters.push({ name, role: asString(c.role), description: asString(c.description) });
  });

  const arcs = asStringArray(body.arcs) ?? [];
  if (arcs.length === 0) errors.push("at least one story arc is required");

  const rawAssumptions = Array.isArray(body.assumptions) ? body.assumptions : [];
  const assumptions: SeasonAssumption[] = [];
  rawAssumptions.forEach((raw, i) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const question = asString(a.question);
    if (!question) {
      errors.push(`assumption ${i + 1}: question is required`);
      return;
    }
    assumptions.push({ question, assumption: asString(a.assumption) });
  });

  const world = (body.world && typeof body.world === "object" ? body.world : {}) as Record<string, unknown>;
  const productionEstimate = (
    body.productionEstimate && typeof body.productionEstimate === "object" ? body.productionEstimate : {}
  ) as Record<string, unknown>;
  const ending = asString(body.ending);

  if (errors.length > 0) return { ok: false, errors };

  const declared = typeof body.episodeCount === "number" && Number.isFinite(body.episodeCount) ? Math.trunc(body.episodeCount) : episodes.length;
  return {
    ok: true,
    package: {
      title: title as string,
      premise,
      episodeCount: declared || episodes.length,
      episodes,
      characters,
      world,
      arcs,
      ending,
      assumptions,
      productionEstimate,
    },
  };
}

// ── the lifecycle: who may move a season, and where ─────────────────────────

/**
 * Only a `draft` (or a season sent back for changes) may be submitted for review, and only a
 * `submitted` season may be decided. Every refusal names the real status.
 */
export function canSubmitSeason(season: Pick<SeasonLike, "status" | "episodes">): { ok: boolean; reason?: string } {
  if (season.status === "submitted") return { ok: false, reason: "this season is already waiting for your decision" };
  if (season.status === "approved") return { ok: false, reason: "this season is already approved" };
  const episodeCount = season.episodes?.length ?? 0;
  if (episodeCount === 0) return { ok: false, reason: "the season has no episodes yet — outline it before submitting" };
  return { ok: true };
}

/** Apply a human decision. There is no path here that a machine can take on its own. */
export function applySeasonDecision(
  season: Pick<SeasonLike, "status" | "title">,
  decision: SeasonDecision
): { ok: true; status: SeasonStatus } | { ok: false; reason: string } {
  if (season.status !== "submitted") {
    return {
      ok: false,
      reason:
        season.status === "approved"
          ? "this season is already approved — submit a NEW season to change the story"
          : `only a submitted season can be decided (this one is '${season.status}')`,
    };
  }
  return { ok: true, status: decision };
}

/** A season may be edited only while it is not approved — an approved story is the contract. */
export function canEditSeason(season: Pick<SeasonLike, "status">): { ok: boolean; reason?: string } {
  if (season.status === "approved") {
    return { ok: false, reason: "an approved season is the production contract — submit a new season instead of editing this one" };
  }
  return { ok: true };
}

// ── the production gate (spec §5 Phase 3 + acceptance test) ─────────────────

export type ProductionGate =
  | { allowed: true; seasonId: string | null; seasonTitle: string | null }
  | { allowed: false; reason: string; status: SeasonStatus | "none" };

/**
 * The single rule that satisfies *"No downstream production starts before the required story
 * approval"*: expensive work (image, voice, video, youtube) for a project may only run when that
 * project has an APPROVED season.
 *
 * `seasons` are the project's seasons, newest first. A null/empty list means the project has never
 * proposed one, and the refusal says exactly that and where to fix it.
 */
export function productionGate(
  seasons: Array<Pick<SeasonLike, "status" | "title"> & { id: string }> | null | undefined,
  projectId?: string | null
): ProductionGate {
  const list = seasons ?? [];
  const approved = list.find((s) => s.status === "approved");
  if (approved) return { allowed: true, seasonId: approved.id, seasonTitle: approved.title ?? null };

  const submitted = list.find((s) => s.status === "submitted");
  if (submitted) {
    return {
      allowed: false,
      status: "submitted",
      reason: `Season '${submitted.title ?? "untitled"}' is waiting for your decision. Approve it at /seasons (or on the project) before production work is created — the AI does not start expensive work on an unapproved story.`,
    };
  }

  const latest = list[0];
  return {
    allowed: false,
    status: latest?.status ?? "none",
    reason: projectId
      ? `This project has no approved season yet (latest season is '${latest?.status ?? "none"}'). Develop and approve a full season package at /seasons before production tasks are created.`
      : `This project has no approved season yet (latest season is '${latest?.status ?? "none"}'). Approve a season package before production tasks are created.`,
  };
}

/** Is this worker type gated by the season approval? Script/prep work is deliberately NOT gated. */
export function isProductionWorkerType(workerType: string): boolean {
  return (PRODUCTION_WORKER_TYPES as readonly string[]).includes(workerType);
}

/**
 * The notification the human should see when a season changes state. Returns null when nothing needs
 * their attention, so the inbox never fabricates urgency.
 */
export function seasonNotification(
  event: "submitted" | "approved" | "changes_requested" | "rejected",
  season: Pick<SeasonLike, "title"> & { id: string }
): { kind: string; title: string; body: string; severity: "info" | "warning" | "critical"; requiresAction: boolean } | null {
  const name = season.title ?? "Untitled season";
  switch (event) {
    case "submitted":
      return {
        kind: "season_submitted",
        title: `Season '${name}' is ready for your approval`,
        body: "The Manager AI submitted a complete season package. Review the outline, synopses and open assumptions, then approve, request changes or reject.",
        severity: "info",
        requiresAction: true,
      };
    case "approved":
      return {
        kind: "season_decided",
        title: `Season '${name}' approved`,
        body: "Production may now begin on the approved season.",
        severity: "info",
        requiresAction: false,
      };
    case "changes_requested":
      return {
        kind: "season_decided",
        title: `Changes requested on '${name}'`,
        body: "The season was sent back to the Manager AI with your note.",
        severity: "warning",
        requiresAction: false,
      };
    case "rejected":
      return {
        kind: "season_decided",
        title: `Season '${name}' rejected`,
        body: "No production will run for this season.",
        severity: "critical",
        requiresAction: false,
      };
    default:
      return null;
  }
}
