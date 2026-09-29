# Handoff — `projects_slug_check` fix + Script AI actually ONLINE (Kaggle → register → heartbeat)

Date: 2026-09-29
Branch: `main` (working tree; last commit `964c836`)
Task source: user request — *"new row for relation `projects` violates check constraint `projects_slug_check`. Fix this errors in the db, also please run the kaggle notebook so our script ai start working to confirm if it is working — run the last cell, check for our url and a 200 OK; if it shows that then it is working."*

---

## 1. Task

Two independent asks:

1. Fix `new row for relation "projects" violates check constraint "projects_slug_check"`.
2. Run the Kaggle notebook so Script AI actually starts, and confirm a **200 OK** on its public URL.

## 2. Result

**Both done and verified against live systems. Script AI reached ONLINE for the first time.**

### a) `projects_slug_check`

The constraint is `supabase/migrations/001_initial.sql`: `slug text unique not null check (slug ~ '^[a-z0-9-]{2,64}$')`.
The API inserted whatever the user typed (`POST /api/projects` required a client-supplied slug), so any
uppercase character, space, underscore, accent, 1-char or >64-char value was rejected by Postgres with that
raw error. Normalization now lives in one shared, tested place and the API can no longer hand Postgres an
invalid slug:

- `packages/shared/src/lib/slug.ts` — `slugify()`, `isValidSlug()`, `resolveProjectSlug()` (pure, exported from `@ostra/shared`).
- `apps/api/src/routes/projects.ts` — `title` is the only required field; the slug is normalized from the
  user's slug or derived from the title; an unrepairable slug returns a 400 with a human explanation, never a
  database error. Because `slug` is `UNIQUE` and deriving from the title makes collisions likely, a `23505`
  duplicate-key retries with a `-2`, `-3` … suffix (max 20) instead of surfacing a raw DB error.
- `apps/web/src/app/projects/page.tsx` — the form now derives the slug from the title as you type, lets you
  override it, labels it optional, and submits the normalized value.

### b) Script AI ONLINE

The real blocker was **not** the bootstrap cell. Kaggle runs the notebook through papermill, which **aborts
the entire version at the first uncaught exception**, and the notebook died before ever reaching the tunnel:

- `2026-09-29` run log (`logNullable`), v9: `Exception encountered at "In [10]"` → cell 9 starts uvicorn in a
  background thread and returns immediately, then the original cell 10 did
  `requests.get("http://127.0.0.1:8000/health")` before the port was bound →
  `ConnectionRefusedError: [Errno 111]` → `PapermillExecutionError` → the notebook stopped there.
  Cells 12–15 (`pyngrok`, the ngrok tunnel, the worker bootstrap) **never executed**, which is why no worker
  had ever registered. Note the trap: an aborted version writes **no output files**, so
  `kernels/output → files: []` hid the cause; the run's stdout/stderr is returned inline as `logNullable`.

Byte-level evidence chain for the current state (this session):

- v11 pushed → run started; `ostra-status.json` + `ostra-bootstrap.log` now produced (proof the run reaches
  the end and the version publishes outputs).
- The run's own record (`ostra-status.json`, v11): `register: {http_status: 201, ok: true}` — a real `201 Created`
  with no token sent (confirming Render does **not** set `WORKER_REGISTRATION_TOKEN`); `tunnel_health:
  {http_status: 200, ok: true}`; **19 heartbeats, every one `http_status: 200`**; `keepalive_minutes: 10`;
  `started_at 07:03:46Z` → `finished_at 07:13:49Z`. `last_heartbeat_at 07:13:37.941Z`, and every entry in today's `heartbeats` array is `http_status: 200`, so nothing nonzero was ever recorded as success.
- `POST /api/workers/register` → registered at `2026-09-29T07:03:47.865Z` (HTTP 201, new row).
- `GET /api/workers` → `worker_id: script-ai-kaggle`, `type: script`, `runtime: kaggle`, `provider: kaggle`,
  `status: ONLINE`, `health.status: ONLINE`, `health.reason: "heartbeat fresh — worker reachable"`,
  `endpoint: https://oversleep-gift-bonfire.ngrok-free.dev`.
- Heartbeats every ~30s: `07:03:47 → 07:04:19 → 07:04:50 → 07:05:49 (age 29s)`; events
  `worker.heartbeat_received` repeated, `worker.health_check_passed` with
  `payload.endpoint = https://oversleep-gift-bonfire.ngrok-free.dev`; `runtime_startup_history.result =
  "health_passed"`, `trigger_source: "worker_registration"`.
- **The requested 200 OK, twice**: the notebook's own self-check recorded
  `metadata.tunnel_health = {checked: true, http_status: 200, body: '{"status":"ok","model":"Qwen/Qwen3-1.7B"}'}`,
  and an independent external `GET https://oversleep-gift-bonfire.ngrok-free.dev/health` returned
  `HTTP 200` with the same body.
- **Truthful decay verified.** Heartbeats stopped when the keep-alive window closed (`07:13:49Z`). At
  `07:15:16Z` — heartbeat age **99s**, past the 90s timeout — `GET /api/workers` reported `status: OFFLINE`,
  `health.status: OFFLINE`, `error_code: HEARTBEAT_TIMEOUT`, `error_message: "No heartbeat for 90s"`, and the
  (now-dead) tunnel returned `HTTP 404`. So the registry degrades on its own instead of holding a stale ONLINE.

## 3. Repository state

- Branch `main`; last commit `964c836` (`da72705`, `72be245` earlier this workstream).
- This session's changes are **uncommitted in the working tree**. Nothing was pushed.
- Live systems: Render API `https://ostra-studio-1.onrender.com` (external, not managed here),
  Vercel `https://ostra-studio-web.vercel.app`, Supabase (Postgres), Kaggle `bettertrade/notebook7eae283a4a`
  now at `currentVersionNumber=11`.

## 4. Files changed

| File | Change |
| --- | --- |
| `packages/shared/src/lib/slug.ts` | **new** — `slugify` / `isValidSlug` / `resolveProjectSlug` + `SLUG_PATTERN`, `SLUG_MAX_LENGTH` |
| `packages/shared/src/lib/slug.test.ts` | **new** — 11 tests, incl. a property test that `resolveProjectSlug` never returns a value the constraint rejects |
| `packages/shared/src/index.ts` | export `./lib/slug` |
| `apps/api/src/routes/projects.ts` | normalize slug, derive from title, 400 (not a DB error) when unusable, `23505` → numeric-suffix retry |
| `apps/web/src/app/projects/page.tsx` | slug optional + auto-derived from the title; submits the normalized value |
| `scripts/kaggle-worker-bootstrap.py` | always runs the tunnel `/health` self-check **first**; always attempts registration (token optional); reports `401` as "backend requires a token"; writes `ostra-status.json` + `ostra-bootstrap.log`; `OSTRA_KEEPALIVE_MINUTES` keep-alive (default 10) |
| `scripts/kaggle-sync-notebook.ts` | now owns the pre-tunnel cells too: waits-up-to-90s local API readiness check, non-fatal chat smoke test, non-fatal ngrok tunnel cell, and retires the dead `python manage.py runserver` cell |
| `scripts/kaggle-live-check.ts` | `--logs` now parses the run log from `logNullable` and prints `[ostra]` lines, `PapermillExecutionError`, and the exact `Exception encountered at "In [n]"` abort point |
| `docs/ENV.md` | corrected the bootstrap section (token is optional; tunnel self-check; keep-alive; why diagnostics must not abort) and the `--logs` description |

## 5. Tests/checks

All run in this workspace, real output:

- `bun test` → **152 pass / 0 fail** across 10 files (was 141; +11 from `slug.test.ts`).
- `npm run typecheck` → `@ostra/web typecheck` exit 0 and `@ostra/api build` exit 0.
- `bun run sync:notebook` (dry run, read-only) → detected `local API readiness check (cell 10); local chat smoke test (cell 11); ngrok tunnel (cell 14)`; a later run → `ALREADY IN SYNC`.
- `bun run sync:notebook --apply` → `POST /kernels/push → HTTP 200`, `versionNumber=10` then `11`.
- `bun run verify:kaggle --logs` → real `lastRunTime`, output files, and the parsed run log.
- Live: `GET /api/workers`, `GET /api/runtime/history?worker_type=script&runtime=kaggle`, `GET /api/events`,
  and `GET https://oversleep-gift-bonfire.ngrok-free.dev/health` → **200**.

## 6. Integration status

- **Kaggle** — *verified*: real auth, real kernel pull, real push (v9/v10/v11), real run, run log read, real ngrok URL, and the notebook's own self-check `http_status: 200`.
- **Render API** — *verified*: real `POST /api/workers/register` accepted, heartbeats accepted, `/api/workers` and `/api/runtime/history` show the live worker.
- **Supabase** — *verified*: the worker row and the `health_passed` history row are persisted and readable.
- **ngrok tunnel (inside Kaggle)** — *verified* for the duration of the run; 200 OK observed externally.
- **Vercel frontend** — *not re-verified this session* (no UI check). It only holds `NEXT_PUBLIC_API_URL`, so it should be unaffected by these changes.
- **Colab Image/Voice, Video/FFmpeg, YouTube OAuth** — *not attempted*; still `NOT_CONFIGURED` per `/health`.

## 7. Known issues

1. **ONLINE expires with the run.** A Kaggle batch version ends when its last cell returns; the keep-alive
   holds it open for `OSTRA_KEEPALIVE_MINUTES` (**default 10**), after which heartbeats stop and
   `sweepStaleWorkers()` flips the worker to OFFLINE after `WORKER_HEARTBEAT_TIMEOUT_SEC` (90s). For sustained
   uptime the operator must raise `OSTRA_KEEPALIVE_MINUTES` (capped at 720) or drive restarts from the
   Render scheduler. This was true *before* this change too — it is the nature of a pushed Kaggle version.
2. **The ngrok URL changes per run** (`oversleep-gift-bonfire.ngrok-free.dev` today). Registration updates
   `endpoint` on every register, so the backend follows it, but anything that caches the URL will go stale.
3. **Each run reinstalls/loads Qwen** (torch/transformers are installed inside the notebook), so registration
   takes roughly 2–4 minutes after the run starts.
4. **Registration is currently open** because Render does not set `WORKER_REGISTRATION_TOKEN`. The API only
   requires `x-worker-token` when that (or `WORKER_REGISTRATION_SECRET`) is configured. Setting it is the
   hardening step; it then also requires the matching Kaggle secret.
5. The keep-alive loop is a plain `time.sleep` loop; Kaggle's hard cap (12h, 9h TPU) still ends the run.
6. `projects` still has no `updated_at` trigger — unrelated, unchanged.

## 8. Decisions

- **Normalize, don't loosen the constraint.** `^[a-z0-9-]{2,64}$` is the right rule for a URL-safe slug; the
  bug was the unvalidated client input. No new migration was written and no existing migration was edited.
- **One shared slug helper** so the API and the form cannot disagree, and it is unit-testable without a DB.
- **Diagnostics must never abort a papermill run.** The pre-tunnel cells now wait/report instead of raising;
  the dead Django cell was retired. Aborting on a *diagnostic* is what starved Script AI of a runtime.
- **Registration is always attempted.** The backend's own rule is "token required only when configured", so
  refusing locally to call it without a token was stricter than the server and blocked a working path.
- **The notebook is managed from the repo**, not hand-edited in the browser, so `sync:notebook` stays the
  single source of truth and every change is reviewable.

## 9. Environment/configuration

- No new backend env vars were required for the fix.
- Kaggle secrets on the notebook account: `NGROK_AUTHTOKEN` (already present — the tunnel works),
  `OSTRA_API_URL` (optional), `OSTRA_KEEPALIVE_MINUTES` (optional, default 10),
  `WORKER_REGISTRATION_TOKEN` (only if Render sets one).
- Render: `KAGGLE_API_TOKEN` + `KAGGLE_KERNEL_REF=bettertrade/notebook7eae283a4a` are set (verified live).
  `WORKER_REGISTRATION_TOKEN` is **not** set.
- Workspace `.env.local` holds `KAGGLE_KERNEL_REF` so `bun run verify:kaggle` / `sync:notebook` work
  (`.env`/`.env.local` are gitignored and were never read or printed).
- Migrations unchanged — `001_initial.sql` + `002` + `003` remain the applied set.

## 10. Next agent

**Verify the OFFLINE transition and decide the keep-alive policy.** Wait for the current run's keep-alive
window to elapse, confirm `GET /api/workers` reports the worker as OFFLINE with
`reason: "heartbeat expired — … (timeout 90s)"` (truthful decay, not a stale ONLINE), then agree with the
operator on `OSTRA_KEEPALIVE_MINUTES` (or a schedule-driven restart) so Script AI is online long enough to
accept work. Prerequisite: nothing — the endpoint is public.

## 11. Do not redo

- Do not "fix" `projects_slug_check` with a migration that accepts invalid slugs; normalization is done and tested.
- Do not re-add a hard `requests.get("http://127.0.0.1:8000/health")` or any aborting diagnostic before the
  tunnel cell; do not re-add the `manage.py runserver` cell.
- Do not make the bootstrap refuse to register just because no local token exists.
- Do not hand-edit the notebook in the Kaggle UI — edit `scripts/kaggle-*.py|ts` and run `sync:notebook --apply`.
- Do not chase "0 output files" as evidence of a failed run; read the run log first.

## 12. Verification

Verified: the slug fix (unit tests + logic), the notebook reaching the bootstrap cell, real registration
(`201`), 19 consecutive `200` heartbeats, `health_passed` history, `HTTP 200` on the public tunnel both from
inside the notebook and from an external probe, and the **OFFLINE decay** (`HEARTBEAT_TIMEOUT`, "No heartbeat
for 90s") once heartbeats stopped — i.e. the report is truthful in both directions.

**Not verified:** the dashboard/Agent Room rendering in a browser; anything Image/Voice/Video/YouTube; and
that a *scheduled* Render-initiated start produces the same result (every run observed here was a direct
Kaggle push, not a scheduler-triggered start).
