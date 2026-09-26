# Environment — split by deployment (Vercel vs Render)

**Critical rule:** `SUPABASE_SERVICE_ROLE_KEY`, `KAGGLE_API_TOKEN`, `WORKER_REGISTRATION_TOKEN` / `WORKER_REGISTRATION_SECRET`, and all
`KAGGLE_*` / `COLAB_*` / `KOKORO_*` URLs live **only on Render** (`apps/api`). The Vercel frontend
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
KAGGLE_KERNEL_REF=mark56/studio-script-kernel  # Kernel ref for auto-start (required — exact notebook)
KAGGLE_EXEC_DISABLED=false                # set true for probe-only mode (auth check without execution)
COLAB_IMAGE_URL=https://...               # Image AI (Colab) — health probe (NOT_AUTOSTARTABLE for auto-start)
COLAB_VOICE_URL=https://...               # Voice AI (Colab) — health probe (NOT_AUTOSTARTABLE)
KOKORO_VOICE_URL=https://...              # Kokoro-82M — health probe

# YouTube OAuth (Phase 9)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=

# Orchestrator
AUTO_PUBLISH=false                        # keep false until you explicitly want auto-upload
PORT=3001                                 # Render injects PORT; 3001 is the local default
```

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
