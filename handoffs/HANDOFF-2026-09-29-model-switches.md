# Handoff — remaining `projects_slug_check` cause + AI model on/off switches

Date: 2026-09-29
Branch: `main`
Companion to: `handoffs/HANDOFF-2026-09-29-script-ai-online.md` (Script AI ONLINE + the first slug fix)

## 1. Task

User report, in three parts:

1. `new row for relation "projects" violates check constraint "projects_slug_check"` — **"there is still a problem somewhere"**.
2. "Create a new endpoint and a place in the UI where I can turn on/off any of the AI models."
3. "Push all changes to GitHub."

## 2. Result

### a) The remaining slug failure — root cause found and proven

The slug fix from the previous session was correct but **never left the working tree**. The
deployed Render API was still running pre-fix code, so the raw Postgres constraint text kept
reaching the user. Proven against the live deployment (2026-09-29):

```
POST https://ostra-studio-1.onrender.com/api/projects   {"slug":"!!!","title":"T"}
  → 400 {"error":"new row for relation \"projects\" violates check constraint \"projects_slug_check\""}
POST https://ostra-studio-1.onrender.com/api/projects   {"title":"Probe Two Words"}
  → 400 {"error":"slug and title are required"}
```

Both responses are the **old** contract: the old handler required `slug` and passed it straight to
Postgres. The fixed handler returns `400 {error: SLUG_HELP}` / derives the slug from the title and
never echoes constraint text. `select count(*) from projects` = **0**, so every reported attempt
failed at the database — consistent with a build that sends an unnormalized slug (e.g. `My Project`).

Fix = **deploy the already-written fix** (this commit). Additionally hardened so this class of error
can never be surfaced again, whatever the deployed build:

- `packages/shared/src/lib/slug.ts` — new `slugCandidates(baseSlug, maxAttempts)` (every candidate is
  pre-validated against `^[a-z0-9-]{2,64}$`, and the numeric suffix is applied after truncation so a
  64-char base cannot overflow) and `classifySlugWriteError(code)` (`23505` duplicate / `23514`
  check_violation / `23502` not_null / other).
- `apps/api/src/routes/projects.ts` — the UNIQUE-collision retry now iterates `slugCandidates()`, and
  a `23514`/`23502` reply becomes `400 {error: SLUG_REJECTED, detail}` instead of raw Postgres text.
  The constraint itself is untouched (no migration weakening `projects_slug_check`).

### b) New endpoint + UI to switch any AI model on/off

- **Endpoint** (`apps/api/src/routes/models.ts`, registered in `apps/api/src/index.ts`):
  - `GET /api/models` → catalog + stored switch + **real** derived health. `503` + `reason` when
    Supabase cannot be read (never a list that assumes "all on").
  - `PATCH /api/models/:key` → `{ enabled: boolean, note?: string }`, upsert into `model_controls`,
    audited as a `model.enabled` / `model.disabled` event, responds with the merged `model` view.
  - Unknown key → `404` + `known`; non-boolean `enabled` → `400`.
- **Catalog** (`packages/shared/src/providers/models.ts`): `script-qwen3-1-7b`, `image-colab-image`,
  `voice-kokoro-82m`, `video-ffmpeg`, `youtube-youtube-api` (URL-safe, unique, one switch per provider slot).
- **Persistence** (`supabase/migrations/004_model_controls.sql`): `model_controls` table +
  `touch_updated_at` trigger + expanded `runtime_startup_history` result/status checks to accept
  `skipped_disabled`. No stored row ⇒ model is **ON** (nothing to seed).
- **Honest state**: `health` is always the real heartbeat/check status; the switch only sets intent.
  `dispatch` is derived — `READY` = switch ON **and** `health.status === "ONLINE"`; `NOT_READY` = ON but
  unusable; `DISABLED` = switched off. Switching a model off cannot make it look ONLINE, and switching
  it on cannot make it look usable.
- **Enforcement** (`apps/api/src/lib/scheduler.ts` + `apps/api/src/lib/modelControls.ts`): the switch is
  enforced at the only two places an external runtime is started — `schedulerTick()` and
  `runNowByWorker()`. A switched-off model is refused with `action: "skipped_disabled"`, recorded as
  `runtime_startup_history.result = 'skipped_disabled'` / `status = CANCELLED` /
  `error_code = MODEL_DISABLED`, and a `scheduler.skipped_model_disabled` event. Fail-open if
  `model_controls` is absent (logs the read error, still allows the run).
- **UI**: new `apps/web/src/app/models/page.tsx` control room (one switch per model, live `HEALTH`
  pill, `DISPATCHING`/`NOT READY`/`SWITCHED OFF` pill, switch history, 15s poll, explicit
  "unavailable" state) + client in `apps/web/src/lib/models.ts` + a `Models` entry in `TopNav`.

## 3. Repository state

- `main` == `origin/main` == `964c836` at the start of this session; **all** work here was uncommitted.
- Previously uncommitted work from the Script-AI session is included in this push at the user's
  request ("push all changes"): `scripts/kaggle-*`, `docs/ENV.md`, and
  `handoffs/HANDOFF-2026-09-29-script-ai-online.md`.
- Migration `004_model_controls.sql` is **not yet applied** to Supabase by this agent (see §7/§9).

## 4. Files changed

New:
- `packages/shared/src/providers/models.ts` — model catalog, `modelKey`, `findModel`, `modelForProvider`, `modelDispatchState`, `ModelView`, `isModelKey`
- `packages/shared/src/providers/models.test.ts` — 4 describes / 14 assertions on catalog shape + dispatch rules
- `apps/api/src/routes/models.ts` — `GET /api/models`, `PATCH /api/models/:key`, plus the pure `mergeModelViews` + `validateToggle`
- `apps/api/src/routes/models.test.ts` — 12 tests over `mergeModelViews` / `validateToggle`
- `apps/api/src/lib/modelControls.ts` — `checkModelDisabled(supa, providerSlot)` (fail-open)
- `apps/web/src/app/models/page.tsx`, `apps/web/src/lib/models.ts` — control room + API client
- `supabase/migrations/004_model_controls.sql` — `model_controls` + history checks

Modified:
- `apps/api/src/routes/projects.ts` — `slugCandidates` retry, `23514`/`23502` → friendly 400
- `apps/api/src/index.ts` — registers the two model routes
- `apps/api/src/lib/scheduler.ts` — model-switch guard in `evaluateAndStart` + `runNowByWorker`
- `packages/shared/src/lib/slug.ts` + `slug.test.ts` — `slugCandidates`, `classifySlugWriteError`, `SLUG_MAX_ATTEMPTS`
- `packages/shared/src/index.ts` — exports `./providers/models`
- `apps/web/src/components/TopNav.tsx` — `Models` nav entry
- `docs/ENV.md`, `docs/API_ENV.md` — migration 004, `/models` contract, enforcement + fail-open semantics
- plus the Script-AI session's `scripts/kaggle-*`, `apps/web/src/app/projects/page.tsx`, `packages/shared/src/lib/slug.ts` origins

## 5. Tests/checks

Actually run (2026-09-29):

| Check | Command | Result |
| --- | --- | --- |
| Unit tests | `bun test` | **180 pass / 0 fail** across 12 files (was 152) |
| Model route tests | `bun test apps/api/src/routes/models.test.ts` | 12 pass / 0 fail |
| Typecheck + API build | `npm run typecheck` | web exit 0, api `tsc --noEmit` exit 0 |
| Lint | `bun run lint` | exit 0, pre-existing warnings only (3× `react-hooks/exhaustive-deps`, 1× `no-page-custom-font`) |
| Live DB schema (read-only) | `node scripts/verify-supabase.mjs` | connected; 13 public tables; `model_controls` **absent** ⇒ 004 not applied; `projects` rows = 0 |
| Deployed API (probe) | `curl POST /api/projects` | confirms **stale build** (raw constraint text + `slug and title are required`) |

Not verified: the `/models` page in a browser (needs a deploy), and `PATCH /api/models/:key` against
real Supabase (needs migration 004 — see §7). The route's decision logic is covered by unit tests.

## 6. Integration status

| Service | Status | Evidence |
| --- | --- | --- |
| Supabase (Postgres) | ONLINE | `verify-supabase.mjs` connected; migrations 001–003 applied; 004 pending |
| Supabase Storage | NOT_CONFIGURED | bucket `ostra-assets` not created (unchanged) |
| Render API | ONLINE but **stale** | answers, but serves pre-fix `POST /api/projects`; needs the deploy from this push |
| Vercel web | ONLINE but stale | needs this push to pick up the fixed project form + `/models` |
| Kaggle Script AI | ONLINE when the kernel runs | verified in the previous session (v11: register 201, 19× heartbeat 200, tunnel `/health` 200, then OFFLINE after the 90s timeout) |
| Colab Image / Voice | NOT_CONFIGURED | needs `GOOGLE_CLOUD_PROJECT` + `GOOGLE_OAUTH_TOKEN` |
| Video (FFmpeg) / YouTube OAuth | NOT_CONFIGURED | unchanged |

## 7. Known issues

1. **The slug error will keep appearing until Render redeploys.** The fix is in this push; if the user
   still sees it after the deploy, the Render service is not tracking `main` (or the deploy failed) —
   check the Render deploy log rather than changing code again.
2. **Migration 004 is not applied yet.** Until it is, `GET /api/models` returns every model as
   `enabled: true` with `updatedAt: null` (it tolerates the missing table), and `PATCH /api/models/:key`
   returns a Postgres error naming `model_controls`. The supervisor fails open in the meantime.
3. `/api/models` returns `503` (not a defaulted list) whenever Supabase is unreadable, by design.
4. A switched-off model is only enforced where runtimes are started. Directly-created workers
   (`POST /api/workers`, `POST /api/workers/register`) are not gated by a switch.
5. Unchanged from the previous handoff: Kaggle ONLINE expires with the version (keep-alive default
   10 min), the ngrok URL rotates per run, and registration is currently open on Render (no
   `WORKER_REGISTRATION_TOKEN`).

## 8. Decisions

- Do **not** weaken or rename `projects_slug_check`; normalize in code and translate the error instead.
- Pre-validate every retry candidate (`slugCandidates`) rather than trusting `slice()` + suffix to stay in range.
- Store operator intent separately from health instead of adding a new `ProviderStatus` value: the health
  vocabulary stays a statement about reality, and `DISABLED` is presented as a distinct dispatch state.
- Enforce the switch in `schedulerTick` + `runNowByWorker` because those are the only two code paths
  that start an external runtime; anything else would be a claim the code does not back.
- Fail open (not closed) when `model_controls` cannot be read, so a missing migration cannot halt production.
- Catalog lives in `packages/shared` so the API and dashboard can never disagree about keys or labels.

## 9. Environment/configuration

- No new env vars for the model switches. Migration 004 is the only new prerequisite.
- Run label in the SQL editor, in order, for a fresh project: `001_initial.sql` → `002_runtime_supervisor.sql`
  → `003_runtime_supervisor_extensions.sql` → `004_model_controls.sql`.
- `freebuff-env list` reports `.env: DATABASE_URL, SUPABASE_CONNECTION_STRING, host, port, database, user,
  password, KAGGLE_API_TOKEN` and `.env.local: KAGGLE_KERNEL_REF`. Values were never read or printed.

## 10. Next agent

1. After the Render + Vercel deploys of this commit, re-run the two `curl POST /api/projects` probes:
   `{"slug":"!!!","title":"T"}` must return `400 {error: SLUG_HELP…}` and `{"title":"Probe Two Words"}`
   must return `201` with a derived slug. The constraint error must be gone; if not, the deploy is stale.
2. Apply `004_model_controls.sql`, then exercise `PATCH /api/models/script-qwen3-1-7b {"enabled":false}`
   and confirm `GET /api/models` reports `enabled:false, dispatch:"DISABLED"` while `health` is unchanged,
   and that `POST /api/runtime/run-now {worker_type:"script",runtime:"kaggle",provider:"kaggle"}` returns
   `skipped_disabled` with a `MODEL_DISABLED` history row and a `scheduler.skipped_model_disabled` event.
3. Confirm the `/models` page in a browser (switch flips, honest pills, 503 state).
4. Consider gating direct worker creation/registration on the switch (known issue 4) if the user wants the
   switch to be total.

## 11. Do not redo

- Do not re-fix `projects_slug_check` in the API/web code — `slugCandidates` + `classifySlugWriteError`
  already make it impossible to emit an invalid slug or raw constraint text. Check the deploy instead.
- Do not add a `DISABLED` value to `ProviderStatus`.
- Do not edit migrations 001–003; only append new numbered migrations.
- Do not seed `model_controls` — absence of a row is the documented "ON" default.
- Do not weaken the switch by enforcing it anywhere that does not actually start a runtime.

## 12. Verification

To reproduce every claim in §5/§6 from the repository root:

```bash
bun test                                     # 180 pass / 0 fail
bun test apps/api/src/routes/models.test.ts  # 12 pass / 0 fail
npm run typecheck                            # web + api exit 0
bun run lint                                 # exit 0 (pre-existing warnings only)
node scripts/verify-supabase.mjs             # read-only schema + counts
curl -s -X POST https://ostra-studio-1.onrender.com/api/projects \
  -H 'content-type: application/json' -d '{"slug":"!!!","title":"T"}'
```

The curl above returns the **old** raw-constraint error until Render redeploys this commit — that
difference is itself the evidence for §2a.
