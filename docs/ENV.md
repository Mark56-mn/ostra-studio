# Environment — split by deployment (Vercel vs Render)

**Critical rule:** `SUPABASE_SERVICE_ROLE_KEY`, `KAGGLE_API_TOKEN`, `WORKER_REGISTRATION_TOKEN` / `WORKER_REGISTRATION_SECRET`, and all
`KAGGLE_*` / `COLAB_*` / `KOKORO_*` / `GOOGLE_*` URLs live **only on Render** (`apps/api`). The Vercel frontend
(`apps/web`) must never hold secrets — it only needs the Render URL.

## Vercel — `apps/web` (frontend, no secrets)

Set in Vercel project env (and locally in `apps/web/.env.local` for dev):

```bash
NEXT_PUBLIC_API_URL=https://ostra-studio-1.onrender.com   # the real production API
NEXT_PUBLIC_APP_NAME=Ostra Studio
```

`NEXT_PUBLIC_API_URL` must be set for the **Production** environment in Vercel. Never put `KAGGLE_API_TOKEN`
or `SUPABASE_SERVICE_ROLE_KEY` here — the browser must never receive them.

If it is missing, the dashboard says `RENDER API · NOT_CONFIGURED` (not a provider failure). If the API is
unreachable it says `BACKEND OFFLINE — Unable to reach Render API`. It never falls back to fake worker rows.

## Render — `apps/api` (backend + Orchestrator + Scheduler + Runtime Supervisor, owns all secrets)

Set in Render service env (Environment tab):

```bash
# Supabase — required for persistence (migrations 001 + 002 + 003)
SUPABASE_URL=https://xxx.supabase.co
# aliases (all accepted):
SUPABASE_CONNECTION_STRING=https://xxx.supabase.co  # alias for SUPABASE_URL
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co     # compat alias
SUPABASE_SERVICE_ROLE_KEY=eyJ...        # server-only, never NEXT_PUBLIC_
# optional fallbacks:
SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# CORS — EXTRA origins allowed to call the API (comma-separated).
# https://ostra-studio-web.vercel.app, *.vercel.app previews and http(s)://localhost:* are always allowed.
# `*` is never used (worker register/heartbeat are token-protected).
CORS_ORIGINS=https://ostra-studio-web.vercel.app

# --- Runtime Supervisor ---
# Scheduler (Render owns the tick; no frontend scheduler)
SCHEDULER_ENABLED=true                   # set false to disable internal 60s tick
SCHEDULER_TICK_MS=60000                  # tick interval (ms), internal fallback
CRON_SECRET=change-me                     # optional — POST /api/runtime/tick requires x-cron-secret when set
WORKER_REGISTRATION_TOKEN=change-me       # alias: WORKER_REGISTRATION_SECRET — shared secret workers must send as x-worker-token / Authorization: Bearer or JSON registration_token
WORKER_REGISTRATION_SECRET=change-me      # alias for WORKER_REGISTRATION_TOKEN (either works)
WORKER_HEARTBEAT_TIMEOUT_SEC=90           # seconds before ONLINE → OFFLINE (per-worker, tunable via workers.heartbeat_timeout_sec)

# Script AI (Kaggle) — the supervisor pushes the notebook and waits for the worker to self-register.
# There is NO KAGGLE_SCRIPT_URL anymore: a hand-maintained endpoint is not part of the architecture.
# Both values below are required for autostart; configuration alone is NEVER ONLINE.
KAGGLE_API_TOKEN=...                      # JSON {"username","key"}, username:key, or KGAT_* Bearer — server-only, always redacted
KAGGLE_KERNEL_REF=bettertrade/notebook7eae283a4a  # REQUIRED — exact notebook ref (owner/slug)
KAGGLE_EXEC_DISABLED=false                # true => probe-only mode (auth check, no push)

# Colab Image / Voice — real auto-start via Colab Enterprise API (colaboratory.googleapis.com)
# When unset, Colab starters remain truthfully NOT_AUTOSTARTABLE — no fake start.
# When set, the scheduler does: POST https://colaboratory.googleapis.com/v1beta/runtimes → Operation{name: operations/...} → history REQUESTED→STARTING → worker must POST /api/workers/register → health → ONLINE.
#
# Google/Colab auth — OAuth token for https://www.googleapis.com/auth/colaboratory (server-only):
GOOGLE_OAUTH_TOKEN=ya29....               # primary name; alias: COLAB_OAUTH_TOKEN / COLAB_ACCESS_TOKEN / GOOGLE_ACCESS_TOKEN
COLAB_OAUTH_TOKEN=ya29....                # alias for GOOGLE_OAUTH_TOKEN
# GCP project that is allowlisted for Colab Enterprise API (beta):
GOOGLE_CLOUD_PROJECT=my-gcp-project       # primary name; aliases: COLAB_PROJECT_ID / GCP_PROJECT_ID / GOOGLE_PROJECT_ID
COLAB_PROJECT_ID=my-gcp-project           # alias for GOOGLE_CLOUD_PROJECT
# Worker bootstrap — the mechanism that actually starts Image/Voice inside the runtime and makes it POST /api/workers/register.
# A notebook URL alone is NOT an execution method (per spec).
COLAB_IMAGE_BOOTSTRAP_URL=https://...     # required to autostart image worker (or COLAB_BOOTSTRAP_URL)
COLAB_VOICE_BOOTSTRAP_URL=https://...     # required to autostart voice worker (or COLAB_BOOTSTRAP_URL)
COLAB_BOOTSTRAP_URL=https://...           # generic fallback for both workers
# Optional: runtime selection
COLAB_RUNTIME_SPEC=...                    # runtime spec id, validated via GET /v1beta/runtimespecs (eligible check)
COLAB_RUNTIME_ID=...                      # optional runtimeId for POST /v1beta/runtimes?runtimeId=…

# REMOVED: COLAB_IMAGE_URL / COLAB_VOICE_URL / KOKORO_VOICE_URL / KAGGLE_SCRIPT_URL.
# Those probe-only endpoints are no longer read anywhere in the codebase. Image/Voice state now comes
# from a real Colab runtime + worker registration; Script state comes from the Kaggle push lifecycle.
# If they are still set on Render they are ignored (they cannot make a provider appear ONLINE).

# Hosted backup — NVIDIA NIM (build.nvidia.com). Optional. When set it becomes the backup every agent
# slot answers from while its own runtime is not ONLINE, and it can be forced for all of them from /models.
# The key is server-only (it never reaches the browser) and is only ever sent to an allowlisted NVIDIA host.
NVIDIA_API_KEY=                            # build.nvidia.com → Get API Key (keys look like nvapi-...)
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1   # default; another host is refused, not used
NVIDIA_CHAT_MODEL=nvidia/nemotron-3-super-120b-a12b   # default; must be in the vetted catalog
# Catalog entries were verified CALLABLE on the live key 2026-10-08 (see docs/API_ENV.md for the table).
# A retired id (meta/llama-3.3-70b-instruct, EOL 2026-08-26) fails as MODEL_RETIRED and names its
# successor — refused before any request is sent, so it can never silently degrade a room. A NIM 404
# (listed, but not callable by this key) is MODEL_UNAVAILABLE. Neither is retried as a transient.
NVIDIA_MODEL_<SLOT>=                       # optional per-slot override (SCRIPT/IMAGE/VOICE/OVERSEER/MANAGER)
NVIDIA_THINKING=true                       # request reasoning where the model documents a switch
NVIDIA_RATE_LIMIT_PER_MIN=20               # local free-tier guard (1..600) → 429 RATE_LIMITED
# Routing mode (own | auto | nvidia + per-slot overrides) lives in the provider_routing table
# (migration 009), not in an env var — see docs/API_ENV.md → "Provider routing".

# YouTube OAuth (Phase 9)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=

# Orchestrator
AUTO_PUBLISH=false                        # keep false until you explicitly want auto-upload
PORT=3001                                 # Render injects PORT; 3001 is the local default
```

### Kaggle auto-start detail (real execution)

- Starter: `KaggleRuntimeStarter` (`packages/shared/src/providers/runtimeStarters.ts`)
- Auth: `KAGGLE_API_TOKEN` (may be JSON `{"username","key"}`, `username:key` Basic, or `KGAT_*` Bearer) via `getKaggleAuthHeader()`.
- Kernel ref: `KAGGLE_KERNEL_REF` is `bettertrade/notebook7eae283a4a` (verified exact notebook for §38). A bare `notebook7eae283a4a` is resolved by `resolveKaggleKernelRef()` via `GET /api/v1/kernels/list?group=profile&pageSize=100&search=<slug>`; a ref containing `/` skips that search entirely.
- Flow (all three endpoints verified against the live Kaggle API):
  1. `GET /api/v1/kernels/list?pageSize=1` — cheap auth gate; 401/403 → `AUTH_FAILED`.
  2. `GET /api/v1/kernels/pull?user_name={owner}&kernel_slug={slug}` — returns `{ blob: { source, language, kernelType }, metadata: { title, currentVersionNumber, isPrivate, enableInternet, enableGpu, enableTpu } }`. The `source` is required: Kaggle triggers a run by accepting a new version.
  3. `POST /api/v1/kernels/push` with `{ slug, newTitle, text, language, kernelType, isPrivate, enableInternet, enableGpu, enableTpu }` → `ApiSaveKernelResponse{ versionNumber, url, ref }` → `provider_run_id = ref@vN` (never synthetic `kaggle:startup_request_id`). The kernel's own `metadata` settings are reused, so a push restarts the runtime without silently rewriting the operator's internet/accelerator/visibility choices.
     - Verified live: the push reply returns `ref` in the **site form** (`"/code/owner/slug"`, e.g. `/code/bettertrade/notebook7eae283a4a`). `canonicalizeKernelRef()` strips the leading `/` and the `code/` segment so `provider_run_id` stays `owner/slug@vN` and matches leases, history, provider health and worker registration; the raw value is preserved as `provider_response.providerRef`.
- Live-API gotchas that previously broke this path silently — do not reintroduce them:
  - `/api/v1/kernels/list` rejects `mine=true` with HTTP 400 `Invalid field 'mine'`. Use `group=profile` to scope a search to the token owner.
  - `GET /api/v1/kernels/{owner}/{slug}` serves the **HTML site page** (HTTP 404, `text/html` for API clients). The notebook source must come from `/kernels/pull`.
  - `KGAT_*` tokens authenticate as `Bearer`, not Basic. Basic `username:key` is only for legacy keys.
- If the source cannot be read, the starter fails with the real HTTP status and **never** calls push.
- Verify credentials without starting a run: `bun run verify:kaggle --kernel-ref=bettertrade/notebook7eae283a4a` (add `--push` to start a real version). Add `--logs` to print the last run's `lastRunTime`, its output files, **and the run log itself**: `GET /api/v1/kernels/output` returns the run's stdout/stderr inline in `logNullable`, so this is the fastest way to see *why* a worker did or did not register. This matters in practice — a version that aborts early writes **no output files at all**, so "0 output files" alone hides the real cause. `--logs` greps the log for `[ostra]` lines, `PapermillExecutionError`, `Exception encountered at` (the exact abort point) and tunnel/registration failures.
- Quota/rate mapping: 401/403→`AUTH_FAILED`, 429→`RATE_LIMITED`, 402→`QUOTA_EXCEEDED`.

### Kaggle notebook bootstrap (what actually makes Script AI ONLINE)

The push only **requests** a run. The notebook itself must then register and keep heartbeating —
`deriveProviderHealth()` never reports ONLINE from configuration or from a successful push.

- Canonical cell: `scripts/kaggle-worker-bootstrap.py`, marked with `# ── Ostra Studio worker bootstrap (managed cell) ──`.
- It reads three **Kaggle secrets** (Add-ons → Secrets):
  - `WORKER_REGISTRATION_TOKEN` (optional) — only needed when the backend sets it, and then it must match `WORKER_REGISTRATION_TOKEN` / `WORKER_REGISTRATION_SECRET` on Render. `registerWorker()` only demands a token when one is configured there; with none configured the API permits open (but still audited) registration, so the cell always attempts registration and reports the real status. A `401` is reported as "the backend requires a registration token", never masked.
  - `OSTRA_API_URL` (optional) — defaults to `https://ostra-studio-1.onrender.com`.
  - `OSTRA_KEEPALIVE_MINUTES` (optional) — how long the cell holds the runtime open (default `10`).
- Order of work, each step reporting its real HTTP status:
  1. `GET {PUBLIC_URL}/health` — the cell verifies its **own public tunnel** from inside the notebook (this is the "is the URL 200 OK?" check).
  2. `POST /api/workers/register` with `endpoint = PUBLIC_URL` and `metadata.tunnel_health` carrying that check's real status, so `/api/workers` shows whether the tunnel answered.
  3. `POST /api/workers/heartbeat` every 30s — comfortably under `WORKER_HEARTBEAT_TIMEOUT_SEC=90`. A 404 heartbeat re-registers instead of silently going dark.
- It writes `ostra-status.json` + `ostra-bootstrap.log` into the working directory. A Kaggle version only publishes output files when the run **ends**, so this is the durable record of the run.
- Keep-alive: a batch run ends when its last cell returns, which would kill the heartbeat thread and drop the worker to OFFLINE within the timeout. When registration succeeds the cell holds the runtime open for `OSTRA_KEEPALIVE_MINUTES` so Script AI is genuinely ONLINE, then ends cleanly so the version publishes its outputs. Raise it for longer uptime; it is capped at 720.
- `bun run sync:notebook` also owns the cells in front of the tunnel: the local API readiness check (waits up to 90s for `:8000` instead of failing instantly), the local chat smoke test, and the ngrok tunnel cell. Verified against a real run log (2026-09-29): **papermill aborts the whole notebook at the first uncaught exception**, and the old `requests.get("http://127.0.0.1:8000/health")` fired before uvicorn had bound the port — the ngrok + bootstrap cells therefore never ran at all. Diagnostics must report, never abort. A dead `python manage.py runserver` cell is retired for the same reason.
- Keep the live notebook in sync with the committed cell:
  `bun run sync:notebook` (dry run) → `bun run sync:notebook --apply` (pushes a **REAL** new kernel version).
  `bun run sync:notebook --dump [--dump-full]` reads the live cell structure without writing.

### Colab auto-start detail (real API, truthful when not allowlisted)

- Starters: `ColabImageRuntimeStarter` / `ColabVoiceRuntimeStarter` — both `autostartable=true` so the scheduler can attempt; `start()` returns a truthful code when the environment is incomplete.
- API: `POST https://colaboratory.googleapis.com/v1beta/runtimes[?runtimeId]` with `Authorization: Bearer GOOGLE_OAUTH_TOKEN`, body `{ displayName, runtimeConfig: { runtimeSpec }, labels }` → `Operation{ name: operations/..., done }`. `provider_run_id` is the real Operation name (e.g. `operations/colab-op-123`), never synthetic.
- Error mapping: missing `GOOGLE_CLOUD_PROJECT`→`NOT_AUTOSTARTABLE`, missing `GOOGLE_OAUTH_TOKEN`→`AUTH_FAILED`, missing bootstrap→`NOT_AUTOSTARTABLE` (notebook URL hint), spec `eligible=false`→`NOT_AUTOSTARTABLE`, allowlist `FAILED_PRECONDITION` (403)→`NOT_AUTOSTARTABLE`, 401→`AUTH_FAILED`.
- Important: runtime creation alone does **not** execute notebook cells. The bootstrap URL/script must make the worker `POST /api/workers/register` with `x-worker-token`; only then does history advance `REGISTERING→ONLINE` via health.

## Supabase setup (once)

1. Create project at https://supabase.com
2. Run **all nine** migrations (idempotent, in order). Either paste them into the Supabase SQL editor or
   run `node scripts/apply-migration.mjs supabase/migrations/<file>.sql` per file:
   - `supabase/migrations/001_initial.sql`
   - `supabase/migrations/002_runtime_supervisor.sql`
   - `supabase/migrations/003_runtime_supervisor_extensions.sql`
   - `supabase/migrations/004_model_controls.sql` (per-model on/off switches → `/api/models` + `/models`)
   - `supabase/migrations/005_conversations.sql` (Agent Chat rooms + messages → `/api/chat/*` + `/chat`)
   - `supabase/migrations/006_chat_reasoning.sql` (reasoning channel for Agent Chat)
   - `supabase/migrations/007_agent_channel.sql` (agent-to-agent channel)
   - `supabase/migrations/008_overseer_worker_type.sql` (Showrunner worker type)
   - `supabase/migrations/009_provider_routing.sql` (own/auto/NVIDIA routing → `/api/routing` + `/models`)
3. Create Storage bucket `ostra-assets` (private with signed URLs or public — your call)
4. Copy URL + anon key + service_role key into the Render env as above

## Status vocabulary (used by the dashboard and the API)

Every provider/surface reports exactly one of these, plus a human-readable `reason`:

| Status | Meaning |
| --- | --- |
| `ONLINE` | A real check passed, or a real worker has a **fresh heartbeat** |
| `STARTING` | A startup request is in flight (REQUESTED/STARTING/REGISTERING) and no worker has registered yet |
| `OFFLINE` | Configured (or previously running) but nothing is running / the heartbeat expired |
| `DEGRADED` | Reachable but incomplete (e.g. Supabase connected, migrations missing) |
| `NOT_CONFIGURED` | Required credentials/host are missing — the reason names the exact keys |
| `ERROR` | The provider/startup actually failed (reason + `errorCode`) |
| `UNKNOWN` | Indeterminate (must never be presented as working) |

Rules the code enforces:

- Configuration presence **never** yields `ONLINE`.
- `ONLINE` for a worker requires a heartbeat younger than `heartbeat_timeout_sec` (default 90s).
- A stale heartbeat flips the worker to `OFFLINE` with `reason: "heartbeat expired — last heartbeat …"`.
- One provider failing never hides the others; `/api/health` always reports every provider.
- All external checks are bounded (Supabase 5s; Kaggle/Colab requests 8–15s) so a dead endpoint cannot hang health.

### Health endpoints

- `GET /health` and `GET /api/health` return the same envelope:
  `{ ok, status, app, host, autoPublish, supabase: ProviderHealth, providers: { <id>: { id, provider, runtime, health } }, timestamp, at }`.
  `ok:true` requires Supabase `ONLINE` **and** no provider in `ERROR`.
- `GET /api/providers` returns the identical envelope (one parser for the dashboard).
- `GET /api/workers` returns the real registry rows with a derived `health` object, or `503` + `reason` when
  Supabase is not configured (there is no synthetic worker list).
- `GET /api/models` returns every switchable AI model with its stored on/off switch **and** the real
  derived `health`, or `503` + `reason` when Supabase cannot be read (never a list that assumes "all on").

## Model switches (`/models` in the dashboard)

Each AI model (Script/Qwen3, Image/Colab, Voice/Kokoro, Video/FFmpeg, YouTube) has one persisted switch
in `model_controls`, flipped from the dashboard **Models** page or via `PATCH /api/models/:key`.

- A model with **no stored row is ON** — the code default, so a fresh database needs no seeding.
- The switch changes **intent only**. `health` is still the same real heartbeat/check state reported by
  `/api/health`, so switching a model off never makes it look `ONLINE` and switching it on never makes
  it usable. `dispatch` is the derived answer (`READY` = ON **and** `health.status === "ONLINE"`;
  `NOT_READY` = ON but not usable; `DISABLED` = switched off).
- Enforcement happens at the only two places an external runtime is started:
  `schedulerTick()` and `runNowByWorker()` in `apps/api/src/lib/scheduler.ts`. A switched-off model is
  refused and recorded as `runtime_startup_history.result = 'skipped_disabled'` (status `CANCELLED`,
  `error_code = MODEL_DISABLED`) plus a `scheduler.skipped_model_disabled` event — never a fake start,
  never a fake failure.
- Every flip is audited as a `model.enabled` / `model.disabled` event with the actor.
- If `model_controls` is missing (migration 004 not applied) the supervisor **fails open** — it logs the
  read error and still allows the run, so an unapplied migration cannot silently halt production.

## Old single-env layout (deprecated)

If root-level `NEXT_PUBLIC_SUPABASE_URL` etc. exist without `NEXT_PUBLIC_API_URL`, the web proxies
through `apps/web/src/app/api/health` as a local dev shim, which now reports `DEGRADED` +
`Backend not configured (NEXT_PUBLIC_API_URL missing)` instead of inventing provider states.
