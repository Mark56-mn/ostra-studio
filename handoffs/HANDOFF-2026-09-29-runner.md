# Handoff — the Runner (`/runner`): one button per AI that really starts the runtime

Date: 2026-09-29
Branch: `main`
Companion to: `handoffs/HANDOFF-2026-09-29-model-switches.md` (model on/off switches + the slug fix)

## 1. Task

User request, verbatim:

> "I need you too build a place or dedicated as runner it will have buttons for each ai so if I click run
> kaggle qwen it automatically runs all the cells in that notebook that's what I want you too build next."

So: a dedicated Runner place in the dashboard with one button per AI model, where the Kaggle/Qwen button
genuinely starts the notebook run end-to-end (every cell), with no mock state.

## 2. Result

### a) What actually starts a notebook (verified by reading the real code path)

`POST /api/runtime/run-now {worker_type, runtime, provider}` → `runNowByWorker()`
(`apps/api/src/lib/scheduler.ts`) → `findStarter(map, runtime, provider)` →
`KaggleRuntimeStarter.start()` (`packages/shared/src/providers/runtimeStarters.ts:190`), which:

1. requires `KAGGLE_API_TOKEN` + `KAGGLE_KERNEL_REF` (otherwise `AUTH_FAILED` / `NOT_AUTOSTARTABLE`),
2. refuses in probe mode when `KAGGLE_EXEC_DISABLED=true`,
3. verifies auth with an authenticated `GET /api/v1/kernels/list?pageSize=1` (401/403 → `AUTH_FAILED`),
4. **pulls the kernel source** (`GET /api/v1/kernels/pull?user_name=&kernel_slug=`) and re-pushes it,
5. **`POST https://www.kaggle.com/api/v1/kernels/push`** — accepting a new version is what triggers the run.
   Kaggle then executes the whole notebook via papermill, and aborts the entire version at the first
   uncaught exception (no output files in that case).

So the existing endpoint already satisfies "runs all the cells in that notebook". **No new API endpoint was
needed** and none was added; the Runner is a UI/client layer over the orchestrator that already works.

### b) What was built

- **`apps/web/src/lib/runner.ts`** (new) — `runModelNow()` (POST run-now, returns the API's `action`/`error`
  or an explicit "no answer"), `fetchRunHistory()` (GET `/api/runtime/history?limit=`), `latestByTarget()`,
  and pure presentation helpers: `runActionLabel`, `runActionTone`, `runRowTone`, `runRowLabel`,
  `runResultSentence`, `remoteStartKind`, `isRemotelyStartable`, `RUN_TONE_PILL`.
- **`apps/web/src/app/runner/page.tsx`** (new) — one card + one big run button per `MODEL_CATALOG` entry:
  - Script AI · Qwen3 1.7B → `{worker_type:"script", runtime:"kaggle", provider:"kaggle"}` (button enabled)
  - Image AI · Colab → `image/colab/colab-image`, Voice AI · Kokoro-82M → `voice/colab/kokoro-82m`
  - Video Engine · FFmpeg (`local`) and YouTube Publisher (`api`) buttons are **disabled** with the reason
    "no starter exists for this runtime" — the API has no starter for them, so Run Now would answer
    `not_autostartable`.
  - Per card: `SWITCH ON/OFF`, `HEALTH …`, `DISPATCHING` (from `/api/models`, best-effort), the persisted
    `RUN …` lifecycle pill, the honest sentence for the pressed button, the last run's time / trigger /
    `provider_run_id` / error, and the real heartbeat age.
  - Below: a run log of the 40 most recent `runtime_startup_history` rows, and a "what actually happens"
    panel documenting Kaggle's all-cells/abort-on-first-exception behaviour, the
    `REQUESTED → STARTING → REGISTERING → ONLINE` lifecycle, the 90s heartbeat timeout that takes a run
    back to OFFLINE, and which runtimes are not remotely startable.
  - `/api/models` is optional: if it 404s (Render build older than the model-switch work) the page shows
    `SWITCH / HEALTH UNKNOWN` and the buttons still work, because the orchestrator enforces switches.
- **`apps/web/src/lib/runner.test.ts`** (new) — 16 tests over the pure surface: `targetKey`,
  `latestByTarget` (incl. image vs voice on the same `colab` runtime), action labels/tones (a `requested`
  start is `info`, never `ok`), row tones/labels (`ONLINE` is the only `ok`; a skip stays the skip it was),
  start-path classification (`kaggle`/`colab` yes, `local`/`api` no), and `runResultSentence`.
- **`apps/web/src/components/TopNav.tsx`** — `Runner` entry between Projects and Models.
- **`apps/web/src/app/page.tsx`** — hero CTA "Run an AI now" → `/runner`.
- **`docs/WEB_ENV.md`** — new "Runner — `/runner`" section: the exact endpoint + payload per model, the
  answer→UI mapping table, and the "no secrets in Vercel" rule (`KAGGLE_KERNEL_REF` lives on Render).

## 3. Repository state

- Branch `main`. At the start of this session `main` == `origin/main` == `0a03013`
  ("feat(models): real on/off switches for every AI model, plus slug-write hardening").
- This session's work is **uncommitted** — nothing was pushed (the user did not ask for a push this time).
- Working tree contains exactly the files in §4; migration `004_model_controls.sql` remains applied to
  Supabase (from the previous session).

## 4. Files changed

New:
- `apps/web/src/lib/runner.ts` — run-now client, history reader, pure state helpers
- `apps/web/src/lib/runner.test.ts` — 16 unit tests
- `apps/web/src/app/runner/page.tsx` — the Runner page
- `handoffs/HANDOFF-2026-09-29-runner.md` — this document

Modified:
- `apps/web/src/components/TopNav.tsx` — `Runner` nav entry
- `apps/web/src/app/page.tsx` — hero CTA to `/runner`
- `docs/WEB_ENV.md` — Runner contract, per-model payloads, answer→UI mapping

Not touched (deliberately): `apps/api/**` (no new endpoint needed), `packages/shared/**`,
`supabase/migrations/**`, `vite.config.ts`, `.env*`.

## 5. Tests/checks

Actually run in this session, from the repository root:

| Check | Command | Result |
| --- | --- | --- |
| Unit tests | `bun test` | **196 pass / 0 fail** across 13 files (was 180 / 12) |
| Typecheck + API build | `npm run typecheck` | `@ostra/web typecheck: Exited with code 0`, `@ostra/api build: Exited with code 0` |
| Lint | `bun run lint` | exit 0; only the 4 pre-existing warnings (3× `react-hooks/exhaustive-deps`, 1× `no-page-custom-font`) — the new page adds none |

Not run (deliberately): no dev server was started, and no production build was executed.

## 6. Integration status

| Service | Status | Evidence |
| --- | --- | --- |
| Kaggle Script AI | **configured but unverified from the Runner** | The push path is the production code verified live in earlier sessions (v11: register 201, 19× heartbeat 200, tunnel `/health` 200). BUT the deployed Render API is still an **old build** (below), so no button has been pressed against production in this session. |
| Render API | **ONLINE but stale** | Probed 2026-09-29 in the previous session: `GET /api/models` → 404 `{"error":"Not found"}`. `/api/runtime/run-now` and `/api/runtime/history` are older endpoints and are expected to answer, but this was **not** re-probed here. |
| Vercel web | not deployed from this work | `/runner` exists only in the working tree until a commit + Vercel build. |
| Supabase (Postgres) | ONLINE | `model_controls` exists (migration 004 applied in the previous session). |
| Colab Image / Voice | NOT_CONFIGURED | needs `GOOGLE_CLOUD_PROJECT` + `GOOGLE_OAUTH_TOKEN`; the Runner's buttons will return `not_autostartable`. |
| Video (FFmpeg, `local`) / YouTube (`api`) | NOT_CONFIGURED / no starter | buttons disabled client-side, consistent with the API's `not_autostartable`. |

## 7. Known issues

1. **The Render API must be redeployed for `/api/models` (switch + health) to appear on `/runner`.** Until
   then the page shows `SWITCH / HEALTH UNKNOWN` (it does not fail, and it never assumes a model is on).
   This workspace cannot deploy Render.
2. **A button cannot be confirmed to work until the deployed API is current.** If `/api/runtime/run-now`
   is missing on the deployed build the page says so explicitly (`No answer from the orchestrator —
   … the run-now endpoint is missing on the deployed API (HTTP 404)`).
3. Kaggle ONLINE is inherently temporary: the run's keep-alive window ends, then after
   `WORKER_HEARTBEAT_TIMEOUT_SEC` (default 90s) the worker is OFFLINE and the ngrok URL from that run is
   dead. A new press creates a new version/URL.
4. Model-switch enforcement is still limited to the two places a runtime is started; directly created
   workers (`POST /api/workers`, `POST /api/workers/register`) are not gated (unchanged known issue).
5. The Runner stops at "start requested": it does not stream provider-side Kaggle logs. Run logs are
   readable through `GET https://www.kaggle.com/api/v1/kernels/output?user_name=&kernel_slug=` (parse the
   `logNullable` JSON **string**) — a possible follow-up, not built here.

## 8. Decisions

- **No new backend endpoint.** The runner's job — start the notebook — is already done truthfully by
  `POST /api/runtime/run-now`; adding a parallel "runner" route would create a second start path and a
  second place to enforce switches/leases.
- **The API is the only authority.** The page never derives RUNNING/ONLINE locally; it renders the returned
  `action` and the persisted `runtime_startup_history` row. `requested` is styled as `info` ("START
  REQUESTED"), never as success.
- **Disabled buttons for `local`/`api`.** The starter registry has no starter for those runtimes, so the
  honest UI is a disabled button naming the reason, rather than a button whose only possible answer is
  `not_autostartable`. The reason is stated on the card.
- **`/api/models` is optional, not required.** Reading switch/health best-effort keeps the Runner usable on
  an API build that predates the model endpoints, since the orchestrator enforces the switches anyway.
- Catalog labels/keys are imported from `@ostra/shared` (`MODEL_CATALOG`) so the page cannot drift from the
  API's own catalog — consistent with `Pipeline.tsx` / `projects/page.tsx`, which already import the barrel.

## 9. Environment/configuration

- **No new env vars.** The Runner introduces none.
- Existing and relevant: `NEXT_PUBLIC_API_URL` (Vercel, production) → `https://ostra-studio-1.onrender.com`;
  on **Render** only: `KAGGLE_API_TOKEN`, `KAGGLE_KERNEL_REF` (the notebook the Kaggle button runs, e.g.
  `bettertrade/notebook7eae283a4a`), plus `KAGGLE_EXEC_DISABLED` (must not be `true`).
- `freebuff-env list` reports `.env: DATABASE_URL, SUPABASE_CONNECTION_STRING, host, port, database, user,
  password, KAGGLE_API_TOKEN` and `.env.local: KAGGLE_KERNEL_REF`. Values were never read or printed.
- Migrations required for the full experience: `001` → `002` → `003` → `004` (004 already applied).

## 10. Next agent

**Redeploy `apps/api` on Render, then exercise the Kaggle button end-to-end and report only what the
evidence shows.** Concretely, after the deploy:

```bash
curl -s -X POST https://ostra-studio-1.onrender.com/api/runtime/run-now \
  -H 'content-type: application/json' \
  -d '{"worker_type":"script","runtime":"kaggle","provider":"kaggle"}'
```

Expect `201 {"action":"requested", …}` (or `200 skipped_already_online` if a worker is still healthy).
Then follow the run: `GET /api/runtime/history?worker_type=script&runtime=kaggle&limit=5` should walk
`REQUESTED → STARTING → REGISTERING → ONLINE`, and the Kaggle kernel's own logs
(`GET /api/v1/kernels/output?user_name=<owner>&kernel_slug=<slug>`; `logNullable` is a JSON string) should
show every cell executed. Only after that may the Runner be called verified in a browser.

## 11. Do not redo

- Do not add a runner-specific API endpoint or a second start path — `POST /api/runtime/run-now` is the one
  the scheduler and dashboard share, and the one that enforces the model switches and the lease.
- Do not make the Runner read switch state locally or assume "no row ⇒ usable"; `model_controls` absence
  already means ON **on the server**, and `/api/models` is the reader.
- Do not hard-code the Kaggle notebook ref in the web app; it is `KAGGLE_KERNEL_REF` on Render, and the
  real ref surfaces through `provider_run_id` in the history rows.
- Do not report `requested` as ONLINE anywhere in the UI, and do not weaken the disabled state for
  `local`/`api` runtimes.
- Do not edit migrations 001–003; do not re-apply 004 (already applied and idempotent).
- Do not start dev servers or run a production build to "verify" this change in this workspace.

## 12. Verification

Reproduce every claim in §5:

```bash
bun test                                     # 196 pass / 0 fail, 13 files
bun test apps/web/src/lib/runner.test.ts     # 16 pass / 0 fail
npm run typecheck                            # web exit 0, api exit 0
bun run lint                                 # exit 0 (4 pre-existing warnings)
```

Still **unverified** (state plainly; do not assert these work):

1. The Kaggle button against the **live** deployment — blocked on the Render redeploy (§7.1/§7.2). The
   start path itself was verified live in an earlier session, but not from this page.
2. `/runner` rendering in a browser (Vercel will only serve it after this commit is pushed and deployed).
3. `/api/models` supplying switch + health to the Runner — the endpoint 404s on the currently deployed
   build; the page's degraded path (`SWITCH / HEALTH UNKNOWN`) has not been observed in a browser either.
