# Handoff — Production integration fix (Vercel → Render → Supabase → Runtime Supervisor → Kaggle → worker registration)

Date: 2026-09-28
Branch: `main`
Task source: user request "OSTRA STUDIO — PRODUCTION INTEGRATION FIX" (23 steps + Definition of Done + CRITICAL RULE)

---

## 1. Task

Fix the whole production chain so the live dashboard reports **real** state instead of hard-coded
`SCRIPT OFFLINE / IMAGE OFFLINE / VOICE OFFLINE`:

```
Vercel (https://ostra-studio-web.vercel.app)
  → Render API (https://ostra-studio-1.onrender.com)
  → Supabase (Postgres + Storage, source of truth)
  → Runtime Supervisor (scheduler + leases)
  → Kaggle notebook bettertrade/notebook7eae283a4a (Qwen)
  → FastAPI + tunnel
  → POST /api/workers/register → heartbeat → REAL ONLINE
```

Constraints explicitly given: no hard-coded ONLINE, no mock mode, no synthetic health, no synthetic
`provider_run_id`, do **not** rebuild the backend/scheduler architecture, keep the
`node --import tsx src/index.ts` startup fix, distinguish `ONLINE / OFFLINE / DEGRADED / NOT_CONFIGURED /
STARTING / ERROR / UNKNOWN` with a real reason, expose exact external limitations instead of faking
success, commit to `main`, and leave a handover.

## 2. Result

Code complete and verified locally (tests + typecheck + production build + real module smoke test).
**Not yet verified live**, because the Render deployment and the Vercel deployment are external to this
workspace and the workspace has no Kaggle/Vercel credentials. Nothing is claimed online that was not
observed.

Delivered:

- **One provider status vocabulary + derivation** (`packages/shared/src/providers/health.ts`):
  `ProviderStatus = ONLINE | OFFLINE | DEGRADED | NOT_CONFIGURED | STARTING | ERROR | UNKNOWN`.
  `statusOk()` is true only for `ONLINE`; `makeHealth()` can never produce `ok:true` for any other status.
  `deriveProviderHealth()` precedence: fresh worker heartbeat → `ONLINE`; recent in-flight startup
  (< 20 min, no worker) → `STARTING`; existing stale/failed worker → `OFFLINE`/`ERROR`; missing credentials
  → `NOT_CONFIGURED` (reason names the keys); last attempt failed/timed out → `ERROR`; configured but idle
  → `OFFLINE`. `workerDisplayHealth()` flips a worker to `OFFLINE` the moment the heartbeat exceeds
  `heartbeat_timeout_sec` (default 90s) and exposes the heartbeat age.
- **Single Supabase server-side source of truth** (`packages/shared/src/lib/env.ts`):
  `supabaseServerUrl() = SUPABASE_URL ?? SUPABASE_CONNECTION_STRING ?? NEXT_PUBLIC_SUPABASE_URL`,
  `supabaseServerKey()` prefers `SUPABASE_SERVICE_ROLE_KEY`, plus `supabaseServerConfigured()`,
  `supabaseUrlSource()`, `supabaseConfigReason()` (names the missing key). The old registry bug
  (`Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)` only) is gone.
- **Real Supabase health check** (`packages/shared/src/lib/supabase.ts → checkSupabaseHealth()`):
  authenticated `head` query against the existing `workers` table, 5s bounded timeout, no rows transferred,
  service-role key never returned or logged. Config presence alone → `NOT_CONFIGURED`, never `ONLINE`.
- **Registry rewritten** (`packages/shared/src/providers/registry.ts`): no HTTP URL probing, no
  `KAGGLE_SCRIPT_URL`; `script/image/voice` are configuration-derived (`NOT_CONFIGURED` with the exact
  missing keys, else `OFFLINE` "configured but not registered"); `storage` runs the real Supabase check and
  labels itself `supabase-storage`; `video`/`youtube` are `NOT_CONFIGURED`.
- **API health/report layer rewritten** (`apps/api/src/lib/providerHealth.ts`): single `collectAll()` reads
  Supabase once (bounded `workers` + last-50 `runtime_startup_history`), derives every provider, and builds a
  unified `HealthReport { ok, status, app, host, autoPublish, supabase, providers, timestamp, at }`.
  `GET /health`, `GET /api/health` and `GET /api/providers` all return the identical envelope.
  `ok:true` requires Supabase `ONLINE` **and** no provider in `ERROR`. One provider failing never hides the
  others; a broken report returns `status:"ERROR"` with HTTP 200 (so the UI can distinguish "degraded
  backend" from "backend unreachable").
- **`GET /api/workers` de-faked** (`apps/api/src/routes/workers.ts`): the `OFFLINE_FALLBACK` synthetic list
  is deleted. Real rows are returned with a heartbeat-derived `health` per worker; when Supabase is unwired
  the endpoint returns `503 { error, reason, workers: [] }` instead of inventing workers.
- **Frontend de-faked + live**: new `apps/web/src/lib/health.ts` (typed contract + `fetchHealth()` /
  `fetchWorkers()` returning `reachable:true|false`) and new `apps/web/src/components/ProviderStatus.tsx`
  (Render API / Supabase / all providers, polling, reason + heartbeat age + latency). `OFFLINE_AGENTS` was
  deleted from `AgentRoom.tsx` along with every consumer (`/`, `/agents`, `/runtimes`, `/projects`).
  Landing hero no longer claims `ORCHESTRATOR ONLINE`; the hero episode card is labelled `UI PREVIEW`.
  With no `NEXT_PUBLIC_API_URL` the UI shows `RENDER API · NOT_CONFIGURED`; on network failure it shows
  `BACKEND OFFLINE — Unable to reach Render API` + the connection error.
- **`apps/web/src/lib/api.ts`** normalizes `NEXT_PUBLIC_API_URL` (trim + strip all trailing slashes) and
  joins exactly one `/`, so `apiUrl("/api/health")` → `https://ostra-studio-1.onrender.com/api/health`
  (never `/api/api/health`, never a dropped `/api`).
- **CORS** (`apps/api/src/lib/cors.ts` + `packages/shared/src/lib/cors.ts`): pure
  `isOriginAllowed()`/`resolveAllowedOrigins()`; `https://ostra-studio-web.vercel.app`, `*.vercel.app`
  previews and `http(s)://localhost:*` are always allowed, extra origins come from `CORS_ORIGINS` /
  `WEB_ORIGIN`, and `*` is explicitly rejected.
- **Startup fix preserved/made real**: `apps/api/package.json` now reads
  `"start": "node --import tsx src/index.ts"` (was the failing `--loader`).
- **Repo scripts repaired**: root `package.json` used `bun --filter <pkg> run <script>`, which this Bun
  version rejects (`Script "run" not found`). Now `bun --filter <pkg> <script>`, plus a real `test` script
  (`bun test`) and a `typecheck` that no longer depends on a root `tsc` install.
- Docs updated: `docs/ENV.md` (status vocabulary table, health endpoints, CORS defaults, removed legacy URL
  vars), `docs/API_ENV.md` (full response shape + derivation + `/api/workers`), `docs/WEB_ENV.md` (exact
  Vercel value and every UI condition), `README.md` (contract, quick start, status).

## 3. Repository state

- Branch `main`, HEAD `20a3622` before this work; this handoff is committed with the fix.
- Node 22.23.2 / Bun 1.4.2. `bun.lock` unchanged (no dependency added or removed).
- Live backend currently still serves the **previous** build (see §6) — it reports the old
  `at`/`supabase:"configured"` shape and the old `KAGGLE_SCRIPT_URL` reasons. **A Render redeploy of `main`
  is required** before the dashboard shows the new contract.
- Untracked `scripts/` (verification helpers from the previous session) was left untracked/uncommitted.

## 4. Files changed

New:

- `packages/shared/src/providers/health.ts` — status vocabulary, `makeHealth`, `statusOk`,
  `workerDisplayHealth`, `deriveProviderHealth`, `summarizeHealth`, attempt helpers.
- `packages/shared/src/lib/cors.ts` — pure origin allowlist (`DEFAULT_ALLOWED_ORIGINS` = production Vercel).
- `packages/shared/src/providers/health.test.ts`, `packages/shared/src/lib/env.test.ts`,
  `packages/shared/src/lib/supabase.test.ts`, `packages/shared/src/lib/cors.test.ts`,
  `packages/shared/src/providers/registry.test.ts`, `apps/web/src/lib/api.test.ts` — new tests.
- `apps/web/src/lib/health.ts` — client health/worker readers + presentation helpers.
- `apps/web/src/components/ProviderStatus.tsx` — live provider board.
- `handoffs/HANDOFF-2026-09-28-production-integration.md` — this document.

Modified:

- `packages/shared/src/index.ts` — export `providers/health` and `lib/cors`.
- `packages/shared/src/providers/contracts.ts` — widened `ProviderHealth.status` to the 7-state union,
  added `provider`/`lastHeartbeatAt`/`heartbeatAgeSec`/`detail`, fixed `healthLabel` (no fake `OFFLINE`).
- `packages/shared/src/providers/registry.ts` — rewritten (real config + real Supabase check; no URL probes).
- `packages/shared/src/lib/env.ts` — single Supabase source of truth, `kaggleConfig()`, `colabConfig()`;
  removed the legacy `workerEndpoints`.
- `packages/shared/src/lib/supabase.ts` — server client via shared helpers + `checkSupabaseHealth()`.
- `apps/api/src/lib/supabase.ts` — delegates to the shared helpers, exports `supabaseConfigReason()`.
- `apps/api/src/lib/providerHealth.ts` — rewritten aggregation + `buildHealthReport()`.
- `apps/api/src/routes/health.ts`, `apps/api/src/routes/providers.ts` — unified envelope.
- `apps/api/src/routes/workers.ts` — removed synthetic fallback; heartbeat-derived `health` per row.
- `apps/api/src/lib/cors.ts` — shared allowlist.
- `apps/api/src/lib/scheduler.ts` — renamed the internal `fake`/`fakeRequestId` locals to
  `adHocConfig`/`preRequestId` (clarity only; no behaviour change).
- `apps/api/package.json` — `start: node --import tsx src/index.ts`.
- `apps/web/src/lib/api.ts`, `apps/web/src/app/page.tsx`, `apps/web/src/app/agents/page.tsx`,
  `apps/web/src/app/runtimes/page.tsx`, `apps/web/src/app/projects/page.tsx`,
  `apps/web/src/components/AgentRoom.tsx`, `apps/web/src/components/ui/Badge.tsx`,
  `apps/web/src/app/api/health/route.ts` — live state, no hard-coded statuses.
- `package.json` (root scripts), `README.md`, `docs/ENV.md`, `docs/API_ENV.md`, `docs/WEB_ENV.md`.

## 5. Tests / checks (actually run)

| Command | Result |
| --- | --- |
| `bun test` | **134 pass / 0 fail** (9 files: `runtimeStarters` 33, `schedules` 19, `health` 8, `providers/health` 24, `lib/env` 15, `lib/supabase` 7, `lib/cors` 10, `providers/registry` 8, `apps/web/src/lib/api` 10) |
| `npm run typecheck` (= `tsc --noEmit` for web + api via workspaces) | **pass, 0 errors** |
| `npm run build` (`next build` 14.2.35) | **pass** — `✓ Compiled successfully`, `✓ Generating static pages (8/8)` |
| `tsx --eval` smoke import in `apps/api` | **pass** — `resolveRegistry()` works, `script=NOT_CONFIGURED ("Set KAGGLE_API_TOKEN and KAGGLE_KERNEL_REF on Render")`, `storage=NOT_CONFIGURED ("Set SUPABASE_SERVICE_ROLE_KEY on Render")`, `buildHealthReport()` → `ok=false status=DEGRADED`, `timestamp`/`at` present |
| `bun --filter @ostra/web lint` | **cannot run** — no ESLint config is committed, so `next lint` prompts and exits 1 (pre-existing repo gap, see §7) |

Note: `next build` initially failed on the new shared modules because Webpack could not resolve the `.js`
extension on relative imports inside `packages/shared`. Fixed by using extensionless relative imports in
`health.ts` / `registry.ts` / `lib/supabase.ts` (matching the existing barrel style). Re-verified after the
change: build, both typechecks and all 134 tests pass.

## 6. Integration status

| Integration | Status |
| --- | --- |
| Render API reachability | **Verified (old build).** `GET https://ostra-studio-1.onrender.com/health` → `200`; `GET /api/health` → `200`; `GET /api/providers` → `200`; `GET /api/workers` → `200 {"workers":[],"source":"supabase"}`. (First `/health` call returned HTTP 000 on a cold start, `200` on retry.) |
| Render new health contract | **Not verified — deploy pending.** The live responses still show the old shape (`at`, `supabase:"configured"`, `Set KAGGLE_SCRIPT_URL…`), i.e. Render has not yet redeployed `main`. |
| Supabase (live) | **Partially verified.** `/api/workers` returning `source:"supabase"` proves the deployed service can read Supabase. The new *real* check (`checkSupabaseHealth`) is verified only with an injected fake client in tests and locally (where no service key is present). |
| CORS | **Verified (old build).** `OPTIONS /api/health` with `Origin: https://ostra-studio-web.vercel.app` → `204` + `access-control-allow-origin: https://ostra-studio-web.vercel.app`. |
| Kaggle (`bettertrade/notebook7eae283a4a`) live push | **Not attempted / unavailable** — no `KAGGLE_API_TOKEN` in this workspace, and Render env cannot be read from here. No live run was observed. |
| Kaggle worker registration + heartbeat → ONLINE | **Not verified** — no live worker has registered. |
| Colab Image / Voice | **Not attempted** — no Colab project/token/bootstrap configured; stays `NOT_CONFIGURED` by design. |
| Vercel frontend | **Not verified** — the Vercel project is external; `NEXT_PUBLIC_API_URL` cannot be inspected or set from this workspace. |

## 7. Known issues / limitations

1. **Deploy still pending.** The fix is code-complete but the live Render service runs the previous build.
   Until Render redeploys `main`, the UI keeps showing the old (and previously hard-coded) states.
2. **Script AI cannot reach `ONLINE` without credentials.** Requires `KAGGLE_API_TOKEN` **and**
   `KAGGLE_KERNEL_REF=bettertrade/notebook7eae283a4a` on Render, and the notebook must actually
   `POST /api/workers/register` (with `WORKER_REGISTRATION_TOKEN` if set) and heartbeat. Until then the
   dashboard will truthfully show `NOT_CONFIGURED` (missing keys) or `OFFLINE`/`STARTING`.
3. **Image/Voice stay `NOT_CONFIGURED`** until `GOOGLE_CLOUD_PROJECT` + `GOOGLE_OAUTH_TOKEN` + a real
   `COLAB_IMAGE_BOOTSTRAP_URL` / `COLAB_VOICE_BOOTSTRAP_URL` exist. Runtime creation alone does not execute
   notebook cells, so the bootstrap is mandatory — this is intentional, not a bug.
4. **No ESLint config is committed**, so `next lint` cannot run non-interactively. Adding
   `.eslintrc.json` (or `eslint.config.mjs`) is a small follow-up.
5. `runtime_startup_history` may legitimately produce `ERROR` for old failed attempts in the last 24h; that
   is truthful, but it means the Script provider can read `ERROR` until a successful start supersedes it.
6. The Next `/api/health` shim is still only a local-dev convenience; production must call Render directly.

## 8. Decisions

- **Status derivation is pure and lives in `packages/shared`**, so the same rules are unit-tested and used by
  the API; the dashboard never re-implements them.
- **The registry no longer performs HTTP probes.** Configuration produces `NOT_CONFIGURED`/`OFFLINE`; only
  `/api` layers real database/worker truth on top. This is what removes the `KAGGLE_SCRIPT_URL`
  requirement from the architecture without deleting the `RuntimeStarter` abstraction.
- **Storage readiness == the real Supabase check** (same project/credentials), so a URL alone can never
  mark Supabase healthy.
- **`/api/providers` returns the same envelope as `/api/health`** — one parser, one contract.
- **`/api/workers` fails loudly (503) instead of returning a fallback list**, so "backend unreachable" and
  "no workers" can never be confused again.
- **`ok` semantics**: the API answered with a health report; `status` says whether the backend is
  `ONLINE`/`DEGRADED`. HTTP stays `200` for degraded reports so the UI keeps the "reachable but degraded"
  distinction separate from "unreachable".
- Extensionless relative imports inside `packages/shared` (Webpack + tsx + bun all resolve them).

## 9. Environment / configuration

Vercel (`apps/web`, no secrets): `NEXT_PUBLIC_API_URL=https://ostra-studio-1.onrender.com` (Production),
`NEXT_PUBLIC_APP_NAME`.

Render (`apps/api`, owns every secret):

- Supabase: `SUPABASE_URL` (or `SUPABASE_CONNECTION_STRING` / `NEXT_PUBLIC_SUPABASE_URL`) **and**
  `SUPABASE_SERVICE_ROLE_KEY`.
- Script AI: `KAGGLE_API_TOKEN`, `KAGGLE_KERNEL_REF=bettertrade/notebook7eae283a4a`,
  `KAGGLE_EXEC_DISABLED=false`.
- Supervisor: `SCHEDULER_ENABLED=true`, `SCHEDULER_TICK_MS=60000`, `CRON_SECRET`,
  `WORKER_REGISTRATION_TOKEN` (alias `WORKER_REGISTRATION_SECRET`), `WORKER_HEARTBEAT_TIMEOUT_SEC=90`.
- CORS: `CORS_ORIGINS=https://ostra-studio-web.vercel.app` (optional — this origin is always allowed).
- Optional Colab: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_OAUTH_TOKEN`, `COLAB_IMAGE_BOOTSTRAP_URL`,
  `COLAB_VOICE_BOOTSTRAP_URL`, `COLAB_RUNTIME_SPEC`.
- `AUTO_PUBLISH=false`.
- **Removed / ignored:** `KAGGLE_SCRIPT_URL`, `COLAB_IMAGE_URL`, `COLAB_VOICE_URL`, `KOKORO_VOICE_URL`.

Migrations: `001_initial.sql`, `002_runtime_supervisor.sql`, `003_runtime_supervisor_extensions.sql` — all
required, already applied to the live Supabase project (verified in the previous session). No new migration
was added; no duplicate schema was created.

No secret values appear in this document or in source.

## 10. Next agent

**Recommended task:** verify the live chain end-to-end after Render + Vercel redeploy `main`.

Prerequisites: (1) Render has redeployed `main`; (2) `KAGGLE_API_TOKEN` + `KAGGLE_KERNEL_REF` are set on
Render; (3) `NEXT_PUBLIC_API_URL` is set in Vercel Production.

Steps: `curl https://ostra-studio-1.onrender.com/api/health` and confirm the new envelope
(`timestamp`, `supabase` object, 7-state providers — no `Set KAGGLE_SCRIPT_URL`); `curl /api/workers` and
confirm no synthetic list; open the Vercel dashboard and confirm the provider board matches the API;
`POST /api/runtime/run-now {"schedule_id":…}` (or the Run Now button) and watch
`/api/runtime/history` for `REQUESTED → STARTING → REGISTERING → ONLINE` with a real
`provider_run_id = bettertrade/notebook7eae283a4a@vN`, then confirm the Script row flips to `ONLINE` **only
after** the heartbeat arrives and to `OFFLINE` with "heartbeat expired" after the timeout.

## 11. Do not redo

- Do not reintroduce `KAGGLE_SCRIPT_URL` / `COLAB_IMAGE_URL` / `COLAB_VOICE_URL` / `KOKORO_VOICE_URL` or any
  endpoint-probe path in `packages/shared/src/providers/registry.ts`.
- Do not restore `OFFLINE_AGENTS` / `OFFLINE_FALLBACK` or any synthetic worker list.
- Do not rebuild the scheduler/lease/runtime-supervisor architecture or add a second schema/migration.
- Do not revert `start: node --import tsx src/index.ts`.
- Do not move status derivation back into the components or duplicate the Supabase env logic.
- Do not add `*` to CORS, and do not put secrets in Vercel.

## 12. Verification

- Verified locally: 134 tests, both typechecks, `next build`, the tsx smoke import, and the CORS/health
  behaviour of the **old** live build.
- **Unverified / not attempted:** the live Render deployment of this code (deploy pending), the live Vercel
  deployment, `NEXT_PUBLIC_API_URL` on Vercel, a real Kaggle push for `bettertrade/notebook7eae283a4a`, a
  real worker registration/heartbeat/ONLINE→OFFLINE transition, and the Colab Image/Voice runtimes.
- **The Script AI worker has NOT been observed ONLINE.** Do not report it as online until the heartbeat is
  actually seen. `bun --filter @ostra/web lint` could not be run (no ESLint config committed).
