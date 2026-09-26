# API (Render) env — `apps/api`

Set these on Render (Environment tab). `SUPABASE_SERVICE_ROLE_KEY` is server-only — never set it as `NEXT_PUBLIC_*`.

```
# Supabase (required — migrations 001 + 002 + 003)
SUPABASE_URL=https://xxx.supabase.co
# aliases accepted:
SUPABASE_CONNECTION_STRING=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
# optional fallback:
SUPABASE_ANON_KEY=

# CORS — comma-separated origins allowed to call the API
# In production set to your Vercel domains:
CORS_ORIGINS=https://your-site.vercel.app,https://your-site-preview.vercel.app

# --- Runtime Supervisor ---
SCHEDULER_ENABLED=true
SCHEDULER_TICK_MS=60000
CRON_SECRET=...                          # gates POST /api/runtime/tick
WORKER_REGISTRATION_TOKEN=...            # alias: WORKER_REGISTRATION_SECRET — gates POST /api/workers/register + /heartbeat
WORKER_REGISTRATION_SECRET=...           # alias for WORKER_REGISTRATION_TOKEN (either works)
WORKER_HEARTBEAT_TIMEOUT_SEC=90

# Kaggle Script AI — real execution via POST /api/v1/kernels/push (ApiSaveKernelRequest)
KAGGLE_SCRIPT_URL=https://...
KAGGLE_API_TOKEN=...            # server-only, JSON {username,key} or username:key or KGAT_* Bearer, redacted
KAGGLE_KERNEL_REF=...           # e.g. mark56/studio-script-kernel or legacy notebook7eae283a4a (resolved to owner/slug)
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

# Legacy health probes (probe-only, no auto-start)
COLAB_IMAGE_URL=https://...
COLAB_VOICE_URL=https://...
KOKORO_VOICE_URL=https://...

# YouTube OAuth (Phase 9)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=

# Orchestrator
AUTO_PUBLISH=false
PORT=3001
```

### Kaggle auto-start (real, not probe-only) — `KaggleRuntimeStarter`

`POST /api/v1/kernels/push` via `ApiSaveKernelRequest{ slug, newTitle, text, language, kernelType, isPrivate, enableInternet, enableGpu/Tpu, … }` → `ApiSaveKernelResponse{ versionNumber, url, ref }` → `provider_run_id = ref@vN`. `notebook7eae283a4a` resolved by `resolveKaggleKernelRef()` via `GET /api/v1/kernels/list?mine=true&search=`.

### Colab auto-start (real API, truthful when not allowlisted) — `ColabImageRuntimeStarter` / `ColabVoiceRuntimeStarter`

Both `autostartable=true` so the scheduler can attempt; missing `GOOGLE_CLOUD_PROJECT`→`NOT_AUTOSTARTABLE`, missing `GOOGLE_OAUTH_TOKEN`→`AUTH_FAILED`, missing bootstrap→`NOT_AUTOSTARTABLE` (notebook URL is not an execution method), spec `eligible=false`→`NOT_AUTOSTARTABLE`, `GET /v1beta/runtimespecs` allowlist check. On success, `POST /v1beta/runtimes` → `Operation{ name: operations/... }` → real `provider_run_id`.

Supabase migrations (run once, idempotent, in order):
- `supabase/migrations/001_initial.sql`
- `supabase/migrations/002_runtime_supervisor.sql`
- `supabase/migrations/003_runtime_supervisor_extensions.sql`

Storage bucket: `ostra-assets`

New tables (002+003):
- `runtime_schedules` — persisted schedules (local_time + timezone + days_of_week + startup_mode + cooldown + max_attempts)
- `runtime_startup_leases` — persisted startup lease/lock (survives Render restart; partial unique one_active)
- `runtime_startup_history` — auditable history with full lifecycle: startup_request_id, worker_id, provider_run_id, started_at/registered_at/completed_at, status (REQUESTED→STARTING→REGISTERING→ONLINE / FAILED / TIMEOUT / CANCELLED), error_code/error_message, metadata
- `workers` extended with endpoint, registered_at, last_seen_at, heartbeat_timeout_sec, worker_id, error_code, error_message, metadata, current_task
