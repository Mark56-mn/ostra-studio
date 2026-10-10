# Handover — Audit + season-first approval gate + real media adapters

Date: 2026-10-09
Branch: `main` (working tree **not** committed — the Changes panel owns Save/Share/commit)

## 1. Task

"OSTRA STUDIO — AUTONOMOUS MANHWA PRODUCTION SYSTEM": audit the app against the full spec, close every
gap, and enable end-to-end production using verified free NVIDIA models — with no fake agents, simulated
outputs or placeholder success states.

## 2. Result

Audited and documented (`docs/AUDIT-2026-10-09.md`), then closed the two highest-dependency gaps in the
spec's own order, both fully tested:

**A. Season-first approval workflow with a HARD production gate (spec §5, acceptance test *"No downstream
production starts before the required story approval"*).** There was no season entity at all — only
per-episode approvals. Now: migration `010` adds `seasons` (complete package: premise, per-episode
synopses, cast, world, arcs, ending, open `assumptions`, production estimate) and `notifications`.
The decisions are pure functions in `packages/shared/src/domain/seasons.ts` (17 tests) — a machine has
no path that approves a season; only a human decision on a `submitted` season does, and an approved
season is locked against edits. Enforced where it matters: `POST /api/tasks` refuses
`image|voice|video|youtube` work with **409 `SEASON_NOT_APPROVED`** + the real reason until a season for
that project is approved (`script` work stays ungated — the story must be written before it can be
approved). Routes `/api/seasons` (+`/submit`, `/decision`), `/api/notifications`; UI `/seasons`
(package review, approve / request changes / reject, gate banner, in-app inbox).

**B. Real media providers (spec §3C/3D/3E, §6), verified live — including a negative result.**
`packages/shared/src/providers/media.ts` is a registry of only what was actually verified against
NVIDIA's own pages, with real endpoints, documented limits and honest notes; `apps/api/src/lib/mediaProviders.ts`
is the real HTTP client (server-side key, honest error mapping, `looksLikeWav` so a 200 that is not
audio is refused). Routes `/api/media/providers`, `/api/media/generate`, `/api/media/probe`.
**Live probe from this workspace's key (2026-10-09):**
- `magpie-tts-multilingual` → **HTTP 200, real 67,628-byte WAV (RIFF verified). TTS works.**
- `chat/completions` (nemotron) → 200 (control).
- **Every visual route → HTTP 404 `page not found`**: cosmos3-nano text2image + image2video, and
  flux.1-schnell / sdxl-turbo / diffusiongemma on `/v1/images/generations` (which is alive — it returns
  a proper 400 for a missing `model`). `GET /v1/models` lists 80 models for this account, all language
  models. So image and image-to-video are **not enabled for this account** — an account/entitlement
  fact, not a code defect. The registry notes and `IMPLEMENTATION_PLAN.md` state this; the adapters stay
  wired so enabling a model on build.nvidia.com works with **no code change**.

## 3. Repository state

`main` + the files below. Nothing committed or pushed.

## 4. Files changed

- `docs/AUDIT-2026-10-09.md` (new) — the audit: what exists (do not rebuild), the gap list in the
  spec's dependency order, and the live-probe table.
- `supabase/migrations/010_seasons_and_notifications.sql` (new) — `seasons` + `notifications`
  (idempotent `dedupe_key` unique index).
- `packages/shared/src/domain/seasons.ts` + `.test.ts` (new) — validation, lifecycle, `productionGate`,
  `seasonNotification` (17 tests).
- `apps/api/src/routes/seasons.ts` (new) — seasons + notifications routes; mounted in `index.ts`.
- `apps/api/src/routes/tasks.ts` — the production gate + a real `task_failed` notification.
- `packages/shared/src/providers/media.ts` + `.test.ts` (new) — registry, request builders, response
  parsers (14 tests).
- `apps/api/src/lib/mediaProviders.ts` (new) — real client + `mapMediaHttpError` (pure, tested).
- `apps/api/src/routes/media.ts` (new) — providers / generate / probe; mounted in `index.ts`.
- `apps/web/src/lib/seasons.ts` + `.test.ts` (new) — client + presentation helpers (9 tests).
- `apps/web/src/app/seasons/page.tsx` (new), `components/TopNav.tsx` (nav entry).
- `scripts/smoke-seasons.ts` (new) — the end-to-end ACCEPTANCE TEST for the gate, driving the REAL
  route handlers (not a copy of the logic): invalid package → 400; draft → submit (notification really
  raised) → approve; production task **409 before** approval and **201 after**; `script` never gated;
  cleans up after itself. It aborted here with a real `not configured` (see §6) because the Supabase
  API keys live on Render, not in this sandbox.
- `IMPLEMENTATION_PLAN.md`, `README.md`, `docs/API_ENV.md` — updated to the real state.

## 5. Tests/checks (run on the final state)

- `bun test` → **456 pass, 0 fail** (was 439 before this pass: +17 seasons, +14 media, +9 web helpers).
- `bun --filter @ostra/web typecheck` → exit 0. `bun --filter @ostra/api build` → exit 0.
- `bun --filter @ostra/web lint` → exit 0, no findings in the new files.
- Preview: `GET /seasons` → **200**, renders the real headings, no compile errors.
- Live provider probes as listed in §2 (real requests, real status codes).

## 6. Integration status

- **Supabase** — **migration `010` HAS been applied to the live database and verified**: the repo's
  own `scripts/verify-supabase.mjs` now lists **20 tables including `seasons` and `notifications`**.
  The Supabase *API* keys the route client uses (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) are NOT
  in this sandbox — only `DATABASE_URL`/`SUPABASE_CONNECTION_STRING` are — so requests that go through
  `getServerSupabase()` abort with a real `not configured` here, while the same code runs on Render
  where those keys exist.
- **NVIDIA TTS** — verified working (200 + real WAV).
- **NVIDIA image / image-to-video** — verified **unavailable for this account** (404). Honest, dated.
- **YouTube / Supabase Storage / FFmpeg** — not attempted this pass; still the deferred items in §7.

## 7. Known issues

## 7. Known issues

- **Migration `010` is applied** (see §6) — but the new routes are not deployed until the backend is
  redeployed with this code.
- **`scripts/smoke-seasons.ts` cannot run in this sandbox** (no Supabase API keys here). Run it wherever
  the backend's keys exist — it is the acceptance test for the gate.
- **The Script AI cannot yet submit a season package itself.** The workflow, gate, notifications and UI
  are complete and usable by any API client, but the agent protocol's op allowlist (`storeActions` /
  protocol prompt) has no `submit_season` op yet, so a package is created via `POST /api/seasons`
  (human, or the Manager agent once wired).
- **Media bytes are returned but not stored** — `CONSTRAINTS.md` 14 wants object storage, and no upload
  adapter exists yet, so `POST /api/media/generate` returns base64 in the response and records only
  provenance (`media.generated` event). Do not call it and expect an `artifacts` row with a storage path.
- **Image/video generation is blocked on the account, not the code** — enabling a visual model on
  build.nvidia.com unlocks the adapter with no code change.
- No production dispatcher yet: after approval, tasks are still created by hand or by an agent.

## 8. Decisions

- **The gate lives in `POST /api/tasks`, not the UI.** A UI-only gate would be cosmetic; this makes the
  acceptance test true for every caller, and the UI renders the same pure function.
- **Only verified providers enter the registry.** FLUX/Seedance/Wan were excluded because they could not
  be verified free — a model that could not be verified stays out rather than being advertised.
- **A 404 from a visual route is reported as itself**, never softened into "offline" or "busy": it means
  not enabled for this account, and the dashboard/API say so with the real status.
- **`script` tasks are not gated.** Season development is exactly the work that must happen before
  approval; gating it would deadlock the workflow the spec asks for.

## 9. Environment/configuration

- `NVIDIA_API_KEY` (server-side, already present) — powers TTS today and image/video once a model is
  enabled for the account.
- No new env vars. Nothing to set in the frontend. `CORS_ORIGINS` on Render is still the user-side item
  from the previous handover.

## 10. Next agent

One task, in order: **(1) apply migration `010`** to the live database, then **(2) give the Manager/Script
agent a `submit_season` op** so the AI team can compile and submit the season package itself
(protocol prompt + `storeActions` allowlist + validation → `POST /api/seasons`), and verify the full
loop in `/chat`: ask for a story → package appears on `/seasons` → submit → approve → production tasks
stop being refused. Prerequisites: migration applied, backend deployed with the new routes.

## 11. Do not redo

- Do not re-audit; `docs/AUDIT-2026-10-09.md` is the audit.
- Do not rebuild the season gate or the media registry — both are tested and wired.
- Do not re-probe NVIDIA's visual endpoints hoping for a different answer; the finding is dated and
  reproducible. Re-probe only after the account enables a visual model.
- Do not add mock image/video/audio to make the pipeline "look" complete (`CONSTRAINTS.md` 1, 2, 3).

## 12. Verification

Verified: migration `010` applied and confirmed present on the live database (`seasons`,
`notifications` — 20 tables). Unverified and stated as such: the season lifecycle and the production
gate **through the deployed API** — `scripts/smoke-seasons.ts` is the ready-made acceptance test, but it
needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, which exist on Render and not in this sandbox
(asking for them here is a Settings → Environment change, not something an agent should work around);
and TTS through the API route (verified by calling the provider directly with the same client logic,
not through the deployed route). Nothing about FFmpeg assembly, Supabase Storage or YouTube — those
were not attempted.
