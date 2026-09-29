# API (Render) env — `apps/api`

Set these on Render (Environment tab). `SUPABASE_SERVICE_ROLE_KEY` is server-only — never set it as `NEXT_PUBLIC_*`.

```
# Supabase (required — migrations 001 + 002 + 003 + 004)
SUPABASE_URL=https://xxx.supabase.co
# aliases accepted:
SUPABASE_CONNECTION_STRING=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
# optional fallback:
SUPABASE_ANON_KEY=

# CORS — EXTRA origins allowed to call the API (comma-separated).
# https://ostra-studio-web.vercel.app, *.vercel.app previews and http(s)://localhost:* are ALWAYS allowed.
# `*` is never used (worker register/heartbeat are token-protected).
CORS_ORIGINS=https://ostra-studio-web.vercel.app

# --- Runtime Supervisor ---
SCHEDULER_ENABLED=true
SCHEDULER_TICK_MS=60000
CRON_SECRET=...                          # gates POST /api/runtime/tick
WORKER_REGISTRATION_TOKEN=...            # alias: WORKER_REGISTRATION_SECRET — gates POST /api/workers/register + /heartbeat
WORKER_REGISTRATION_SECRET=...           # alias for WORKER_REGISTRATION_TOKEN (either works)
WORKER_HEARTBEAT_TIMEOUT_SEC=90

# Kaggle Script AI — real execution via POST /api/v1/kernels/push (ApiSaveKernelRequest)
# NO KAGGLE_SCRIPT_URL: the supervisor pushes the kernel and waits for worker registration + heartbeat.
KAGGLE_API_TOKEN=...            # server-only, JSON {username,key} or username:key or KGAT_* Bearer, redacted
KAGGLE_KERNEL_REF=bettertrade/notebook7eae283a4a  # REQUIRED exact notebook ref (owner/slug)
KAGGLE_EXEC_DISABLED=false      # true => probe-only, no push

# Colab Image / Voice — real auto-start via POST https://colaboratory.googleapis.com/v1beta/runtimes
# When unset, starters truthfully return NOT_AUTOSTARTABLE/AUTH_FAILED — no fake start.
# provider_run_id is the real Operation name (operations/...); runtime creation != ONLINE until worker registers.
GOOGLE_CLOUD_PROJECT=...         # alias: COLAB_PROJECT_ID / GCP_PROJECT_ID / GOOGLE_PROJECT_ID — allowlisted GCP project
GOOGLE_OAUTH_TOKEN=...           # alias: COLAB_OAUTH_TOKEN / COLAB_ACCESS_TOKEN / GOOGLE_ACCESS_TOKEN — Bearer for scope https://www.googleapis.com/auth/colaboratory
COLAB_IMAGE_BOOTSTRAP_URL=...    # alias: COLAB_BOOTSTRAP_URL — mechanism that starts Image worker and makes it POST /api/workers/register
COLAB_VOICE_BOOTSTRAP_URL=...    # alias: COLAB_BOOTSTRAP_URL — same for Voice worker
COLAB_RUNTIME_SPEC=...           # optional spec id (validated via GET /v1beta/runtimespecs eligible)
COLAB_RUNTIME_ID=...             # optional runtimeId for POST ?runtimeId=…

# REMOVED: COLAB_IMAGE_URL / COLAB_VOICE_URL / KOKORO_VOICE_URL / KAGGLE_SCRIPT_URL
# are no longer read anywhere. Image/Voice state comes from the real Colab runtime + worker
# registration; Script state comes from the Kaggle push lifecycle. Stale values are ignored.

# YouTube OAuth (Phase 9)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=

# Orchestrator
AUTO_PUBLISH=false
PORT=3001
```

### Model switches — `GET /api/models` / `PATCH /api/models/:key`

Backed by the `model_controls` table (migration `004_model_controls.sql`). No new env vars.

```
GET   /api/models            → { models: [{ key, providerId, modelRef, label, provider, runtime,
                                            enabled, dispatch, health, note, updatedAt, updatedBy }],
                                 counts: { total, enabled, disabled, ready }, source: "supabase", timestamp }
PATCH /api/models/:key       → body { enabled: boolean, note?: string }  → { model, changed, actor }
```

- Catalog keys live in `packages/shared/src/providers/models.ts`: `script-qwen3-1-7b`, `image-colab-image`,
  `voice-kokoro-82m`, `video-ffmpeg`, `youtube-youtube-api`. Unknown key → `404` + `known`; non-boolean
  `enabled` → `400`; Supabase unreadable → `503` + `reason` (never a list that assumes "all on").
- `dispatch` is derived, not stored: `READY` = switch ON **and** `health.status === "ONLINE"`.
  The switch never changes `health` — switching a model off cannot make it look ONLINE, and switching it
  on cannot make it look usable.
- Enforced in `apps/api/src/lib/scheduler.ts` (`schedulerTick` + `runNowByWorker`, the only paths that
  start an external runtime): a switched-off model returns `skipped_disabled` and records
  `runtime_startup_history.result = 'skipped_disabled'` / `error_code = MODEL_DISABLED`.
- Fail-open: if `model_controls` does not exist yet the supervisor logs the read error and allows the run.

### Kaggle auto-start (real, not probe-only) — `KaggleRuntimeStarter`

`GET /api/v1/kernels/list?pageSize=1` (auth gate) → `GET /api/v1/kernels/pull?user_name={owner}&kernel_slug={slug}` (kernel source + `metadata.currentVersionNumber`) → `POST /api/v1/kernels/push` via `ApiSaveKernelRequest{ slug, newTitle, text, language, kernelType, isPrivate, enableInternet, enableGpu/Tpu, … }` → `ApiSaveKernelResponse{ versionNumber, url, ref }` → `provider_run_id = ref@vN` (`bettertrade/notebook7eae283a4a@vN`). A bare `notebook7eae283a4a` is resolved via `resolveKaggleKernelRef()` → `GET /api/v1/kernels/list?group=profile&search=`; a ref with a slash bypasses that search. `/api/v1/kernels/list` rejects `mine=true` (HTTP 400) and `GET /api/v1/kernels/{owner}/{slug}` returns the HTML site page (404), so neither is used any more. `KGAT_*` tokens authenticate as `Bearer`. The push reply's `ref` is the **site form** `"/code/owner/slug"` (verified live), so `canonicalizeKernelRef()` normalizes it back to `owner/slug` before building `provider_run_id = owner/slug@vN` (the raw value is kept as `provider_response.providerRef`). If the kernel source cannot be read the starter fails with the real HTTP status and never calls push. Read-only credential check: `bun run verify:kaggle --kernel-ref=bettertrade/notebook7eae283a4a`. A push only *requests* a run: ONLINE additionally requires the notebook's bootstrap cell (`scripts/kaggle-worker-bootstrap.py`) to register and heartbeat — keep the live notebook in sync with `bun run sync:notebook --apply`.

### Colab auto-start (real API, truthful when not allowlisted) — `ColabImageRuntimeStarter` / `ColabVoiceRuntimeStarter`

Both `autostartable=true` so the scheduler can attempt; missing `GOOGLE_CLOUD_PROJECT`→`NOT_AUTOSTARTABLE`, missing `GOOGLE_OAUTH_TOKEN`→`AUTH_FAILED`, missing bootstrap→`NOT_AUTOSTARTABLE` (notebook URL is not an execution method), spec `eligible=false`→`NOT_AUTOSTARTABLE`, `GET /v1beta/runtimespecs` allowlist check. On success, `POST /v1beta/runtimes` → `Operation{ name: operations/... }` → real `provider_run_id`.

Supabase migrations (run once, idempotent, in order):
- `supabase/migrations/001_initial.sql`
- `supabase/migrations/002_runtime_supervisor.sql`
- `supabase/migrations/003_runtime_supervisor_extensions.sql`

Storage bucket: `ostra-assets`

## Render build & start (deploy config)

Render hosts `apps/api` from this Bun workspace. Known-good service settings:

- **Root Directory:** repository root (the workspace root), **not** `apps/api` — `@ostra/shared`
  is a sibling workspace package resolved via the API's tsconfig `paths` (`../../packages/shared/src/index.ts`).
- **Runtime:** Node **≥ 20.6** (`node --import tsx` requires Node 20.6+; Node 24 is verified). Declared in
  `engines.node` on the root and `apps/api` `package.json`.
- **Build Command:** `bun install && bun --filter @ostra/api build` (`build` = `tsc --noEmit`, a typecheck — it emits no files).
- **Start Command:** `bun --filter @ostra/api start` (equivalently, from `apps/api`: `node --import tsx src/index.ts`).
- `PORT` is injected by Render; the app binds `0.0.0.0:$PORT` (local default `3001`).

### Deploy-failure checklist

- **Only `bun.lock` ships** (no `package-lock.json`/`yarn.lock`). Use `bun install`; `npm ci` fails outright.
- **`tsx` is a devDependency.** Never install with `--omit=dev`/`--production`, or `node --import tsx`
  cannot resolve the loader and the service exits at start.
- **Never resolve TypeScript globally** (`npx tsc` / `bunx tsc` without a local install). The current
  `typescript@latest` is **7.x**, which **removed `baseUrl`** and fails the build with
  `error TS5102: Option 'baseUrl' has been removed`. The tsconfigs no longer set `baseUrl` (redundant
  since TS 4.1 — `paths` resolve relative to the config file), so any TS ≥ 4.1 works.
- A build that typechecks green locally but fails on Render almost always means an **unpinned tool**
  (global TS) or an **install that dropped devDependencies** — not a source error.

## Health contract

`GET /health` and `GET /api/health` return the identical envelope; `GET /api/providers` returns the same
object so the dashboard has one parser:

```jsonc
{
  "ok": false,                // true only when Supabase is ONLINE and no provider is in ERROR
  "status": "DEGRADED",       // ONLINE | DEGRADED | ERROR  (the backend itself)
  "app": "ostra-api",
  "host": "render",
  "autoPublish": false,
  "supabase": { "ok": true, "status": "ONLINE", "provider": "supabase", "latencyMs": 41, "reason": "connected via SUPABASE_URL", "checkedAt": "…" },
  "providers": {
    "script":  { "id": "script",  "provider": "kaggle",       "runtime": "kaggle", "health": { "ok": false, "status": "NOT_CONFIGURED", "reason": "Set KAGGLE_API_TOKEN and KAGGLE_KERNEL_REF on Render", "checkedAt": "…" } },
    "image":   { "id": "image",   "provider": "colab-image",  "runtime": "colab",  "health": { … } },
    "voice":   { "id": "voice",   "provider": "kokoro-82m",   "runtime": "colab",  "health": { … } },
    "video":   { "id": "video",   "provider": "ffmpeg",       "runtime": "local",  "health": { … } },
    "youtube": { "id": "youtube", "provider": "youtube-api",  "runtime": "api",    "health": { … } },
    "storage": { "id": "storage", "provider": "supabase-storage", "runtime": "supabase", "health": { … } }
  },
  "timestamp": "2026-09-28T04:20:00.000Z",
  "at": "2026-09-28T04:20:00.000Z"   // deprecated alias of timestamp
}
```

Derivation (see `packages/shared/src/providers/health.ts`):
fresh worker heartbeat → `ONLINE`; in-flight startup (< 20 min) with no worker → `STARTING`; existing but
stale/failed worker → `OFFLINE`/`ERROR`; missing credentials → `NOT_CONFIGURED`; failed/timed-out last attempt
→ `ERROR`; configured and idle → `OFFLINE`. Provider checks are bounded and isolated — one dead provider never
suppresses the rest.

`GET /api/workers` returns `{ workers: [...], source: "supabase", timestamp }` where each row carries a
derived `health` (`workerDisplayHealth`) so the dashboard cannot show a stale row as ONLINE. When Supabase is
not configured it returns `503` with `error` + `reason` (never a fake offline worker list).

New tables (002+003):
- `runtime_schedules` — persisted schedules (local_time + timezone + days_of_week + startup_mode + cooldown + max_attempts)
- `runtime_startup_leases` — persisted startup lease/lock (survives Render restart; partial unique one_active)
- `runtime_startup_history` — auditable history with full lifecycle: startup_request_id, worker_id, provider_run_id, started_at/registered_at/completed_at, status (REQUESTED→STARTING→REGISTERING→ONLINE / FAILED / TIMEOUT / CANCELLED), error_code/error_message, metadata
- `workers` extended with endpoint, registered_at, last_seen_at, heartbeat_timeout_sec, worker_id, error_code, error_message, metadata, current_task
