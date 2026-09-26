# Environment — split by deployment (Vercel vs Render)

**Critical rule:** `SUPABASE_SERVICE_ROLE_KEY`, `KAGGLE_API_TOKEN`, `WORKER_REGISTRATION_TOKEN` / `WORKER_REGISTRATION_SECRET`, and all
`KAGGLE_*` / `COLAB_*` / `KOKORO_*` / `GOOGLE_*` URLs live **only on Render** (`apps/api`). The Vercel frontend
(`apps/web`) must never hold secrets — it only needs the Render URL.

## Vercel — `apps/web` (frontend, no secrets)

Set in Vercel project env (and locally in `apps/web/.env.local` for dev):

```bash
NEXT_PUBLIC_API_URL=https://your-render-api.onrender.com
NEXT_PUBLIC_APP_NAME=Ostra Studio
```

Leave `NEXT_PUBLIC_API_URL` empty only for local offline truth (shows OFFLINE states without Render).

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

# CORS — which Vercel origins may call the API (comma-separated)
CORS_ORIGINS=https://your-site.vercel.app,https://your-site-preview.vercel.app

# --- Runtime Supervisor ---
# Scheduler (Render owns the tick; no frontend scheduler)
SCHEDULER_ENABLED=true                   # set false to disable internal 60s tick
SCHEDULER_TICK_MS=60000                  # tick interval (ms), internal fallback
CRON_SECRET=change-me                     # optional — POST /api/runtime/tick requires x-cron-secret when set
WORKER_REGISTRATION_TOKEN=change-me       # alias: WORKER_REGISTRATION_SECRET — shared secret workers must send as x-worker-token / Authorization: Bearer or JSON registration_token
WORKER_REGISTRATION_SECRET=change-me      # alias for WORKER_REGISTRATION_TOKEN (either works)
WORKER_HEARTBEAT_TIMEOUT_SEC=90           # seconds before ONLINE → OFFLINE (per-worker, tunable via workers.heartbeat_timeout_sec)

# Worker adapters — absence = OFFLINE (truthful, not an error). Set to go ONLINE:
KAGGLE_SCRIPT_URL=https://...             # Script AI endpoint (when reachable, ScriptProvider probes it)
KAGGLE_API_TOKEN=...                      # Kaggle JSON key (username:key) — server-only, redacted in all logs/responses
KAGGLE_KERNEL_REF=mark56/studio-script-kernel  # Kernel ref for auto-start (required — exact notebook, e.g. mark56/studio-script-kernel)
KAGGLE_EXEC_DISABLED=false                # set true for probe-only mode (auth check without execution)

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

# Legacy health probes (no auto-start; health-probe only)
COLAB_IMAGE_URL=https://...               # Image AI — health probe (truthful OFFLINE if unset)
COLAB_VOICE_URL=https://...               # Voice AI — health probe (truthful OFFLINE if unset)
KOKORO_VOICE_URL=https://...              # Kokoro-82M — health probe

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
- Kernel ref: `KAGGLE_KERNEL_REF` supports `owner/slug` or legacy `notebook7eae283a4a` resolved via `resolveKaggleKernelRef()` → `GET /api/v1/kernels/list?mine=true&search=` + owner inference.
- Flow: `GET /api/v1/kernels/list?mine=true&pageSize=1` auth check → `GET /api/v1/kernels/{owner}/{slug}` fetch source → `POST /api/v1/kernels/push` (`ApiSaveKernelRequest{ slug, text, language, kernelType, isPrivate, enableInternet, … }`) — the SDK equivalent `kaggle.kernels.kernels_api_client.save_kernel(...)`. On success, response `ApiSaveKernelResponse{ versionNumber, url, ref }` is mapped to `provider_run_id = ref@vN` (never synthetic `kaggle:startup_request_id`).
- Quota/rate mapping: 401/403→`AUTH_FAILED`, 429→`RATE_LIMITED`, 402→`QUOTA_EXCEEDED`.

### Colab auto-start detail (real API, truthful when not allowlisted)

- Starters: `ColabImageRuntimeStarter` / `ColabVoiceRuntimeStarter` — both `autostartable=true` so the scheduler can attempt; `start()` returns a truthful code when the environment is incomplete.
- API: `POST https://colaboratory.googleapis.com/v1beta/runtimes[?runtimeId]` with `Authorization: Bearer GOOGLE_OAUTH_TOKEN`, body `{ displayName, runtimeConfig: { runtimeSpec }, labels }` → `Operation{ name: operations/..., done }`. `provider_run_id` is the real Operation name (e.g. `operations/colab-op-123`), never synthetic.
- Error mapping: missing `GOOGLE_CLOUD_PROJECT`→`NOT_AUTOSTARTABLE`, missing `GOOGLE_OAUTH_TOKEN`→`AUTH_FAILED`, missing bootstrap→`NOT_AUTOSTARTABLE` (notebook URL hint), spec `eligible=false`→`NOT_AUTOSTARTABLE`, allowlist `FAILED_PRECONDITION` (403)→`NOT_AUTOSTARTABLE`, 401→`AUTH_FAILED`.
- Important: runtime creation alone does **not** execute notebook cells. The bootstrap URL/script must make the worker `POST /api/workers/register` with `x-worker-token`; only then does history advance `REGISTERING→ONLINE` via health.

## Supabase setup (once)

1. Create project at https://supabase.com
2. Run **all three** migrations in SQL editor (idempotent, in order):
   - `supabase/migrations/001_initial.sql`
   - `supabase/migrations/002_runtime_supervisor.sql`
   - `supabase/migrations/003_runtime_supervisor_extensions.sql`
3. Create Storage bucket `ostra-assets` (private with signed URLs or public — your call)
4. Copy URL + anon key + service_role key into the Render env as above

## Old single-env layout (deprecated)

If you still have root-level `NEXT_PUBLIC_SUPABASE_URL` etc. without `NEXT_PUBLIC_API_URL`, the web now proxies
through `apps/web/src/app/api/health` as a local shim but will show a 502 hint telling you to set the Render URL.
