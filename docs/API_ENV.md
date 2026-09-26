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

# Worker adapters — absence = OFFLINE (truth, not error)
KAGGLE_SCRIPT_URL=https://...
KAGGLE_API_TOKEN=...            # server-only, redacted in logs
KAGGLE_KERNEL_REF=...           # e.g. mark56/studio-script-kernel (exact notebook)
KAGGLE_EXEC_DISABLED=false
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
