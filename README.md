# Ostra Studio

Ostra Studio is a mobile-first AI production control platform for an original manhwa YouTube channel.

The goal is not merely to upload videos. Ostra coordinates a production pipeline in which specialized real AI workers create stories, scripts, scene specifications, images, narration, and finished videos, while the creator retains final approval before publication.

## Deployment topology

- **Vercel** → entire website / dashboard / frontend (`apps/web` — Next.js 14, `NEXT_PUBLIC_API_URL` only, no secrets)
- **Render** → backend API + Orchestrator + Scheduler + Runtime Supervisor (`apps/api` — Express, owns **all** secrets, CORS-locked to Vercel)
- **Supabase** → Postgres + Storage (shared; migrations `001` + `002` + `003`, bucket `ostra-assets`)
- **Kaggle** → Script AI (Render probes `KAGGLE_SCRIPT_URL`; auto-start via `KaggleRuntimeStarter` → worker self-registration → health-gated `ONLINE`)
- **Google Colab** → Image AI + Voice AI (adapters present; `NOT_AUTOSTARTABLE` until a real trigger is proven — no fake start)
- **FFmpeg** → deterministic video renderer, kept **independently replaceable** (never assumed stable on Render Free)

Frontend and backend are **not** merged into one Render deployment. Vercel calls Render via `NEXT_PUBLIC_API_URL`. Render calls Supabase / Kaggle / Colab.

## Core pipeline

User story/idea
→ Script AI
→ Scene breakdown
→ Image AI
→ Voice AI
→ Video engine
→ Quality control
→ Human approval
→ YouTube
→ Analytics

## Initial runtimes

- Script AI: Kaggle (`RuntimeStarter` `kaggle` — full auto-start lifecycle)
- Image AI: Colab (`colab:image` — `NOT_AUTOSTARTABLE` until verified)
- Voice AI: Kokoro-82M on Colab (`colab:voice` — `NOT_AUTOSTARTABLE` until verified)
- Video: FFmpeg deterministic renderer (adapter `VideoRenderer`, replaceable)
- Database/Storage: Supabase (Postgres + Storage)
- Frontend: Next.js 14, mobile-first (Vercel)
- Backend: Express + Supabase (Render)
- YouTube: official API after the review gate is stable

## Critical rules

- No mock mode. No fake agents. No fake success states. No fake startup — worker is `ONLINE` only after registration + health pass.
- Real services report their real status (`OFFLINE` when unconfigured — never faked; `NOT_AUTOSTARTABLE` for Colab until trigger is proven).
- AI providers are adapters and must be replaceable (`packages/shared/src/providers/{contracts,registry,runtimeStarters}.ts`).
- Kaggle and Colab are initial runtimes, not permanent dependencies. Startup mode is stored per schedule (`kaggle_kernel` / `colab_notebook` / `not_autostartable`), never hard-coded.
- ElevenLabs is optional, never mandatory. Kokoro-82M is the initial free voice.
- Human approval is required before publishing by default (`AUTO_PUBLISH=false`).
- Failed work must not destroy successful work. Production assets are versioned. Startup failures leave queued tasks intact (`QUEUED`).
- Large binaries go to Supabase Storage, never database rows.
- Secrets never belong in frontend code (`apps/web` holds only `NEXT_PUBLIC_API_URL`).
- Every important workflow action is auditable (`events` + `runtime_startup_history` with `startup_request_id`, `error_code`, lifecycle `REQUESTED→STARTING→REGISTERING→ONLINE/FAILED/TIMEOUT/CANCELLED`).
- Every agent task ends with a handover in `handoffs/`. Task is not done until handover is written.

## Runtime auto-start

Render hosts the **Runtime Supervisor**: persisted schedules (`runtime_schedules` — `local_time` + IANA `timezone` + `days_of_week` + `cooldown` + `max_start_attempts`), a persisted startup lease (`runtime_startup_leases` — survives Render restart), and audited history (`runtime_startup_history`). Startup lifecycle is:

```
SCHEDULE FIRES → CHECK WORKER HEALTHY? → ALREADY ONLINE → skip (recorded, Case A)
                         ↓ NO
             Acquire lease (persisted — survives restart, Case E) → KAGGLE/COLAB STARTER
                         ↓
             History: REQUESTED → STARTING (NOT ONLINE yet)
                         ↓ (Kaggle API accepted OR failed → FAILED, Case B)
             Worker registers via POST /api/workers/register (x-worker-token, dynamic tunnel endpoint, Case D)
                         ↓
             History: REGISTERING → health check → ONLINE → health_passed
                         ↓
             POST /api/workers/heartbeat keeps it ONLINE; no heartbeat → TIMEOUT → OFFLINE (Case C, queued tasks preserved)
                         ↓
             Schedule edit 09:00→05:00 persists and next run moves immediately (Case F)
```

Duplicate protection: healthy check + in-progress lease + per-worker cooldown before any start. Bounded retries via `max_start_attempts` + `cooldown_minutes`. Colab starters return `NOT_AUTOSTARTABLE` (explicit, not a fake button) until a real trigger mechanism is proven and tested. **Run Now** (`POST /api/runtime/run-now`) runs the exact same lifecycle as scheduled start.

## Repository instructions

Each spec is mandatory before changing code:

1. `PROJECT_CONTEXT.md`
2. `ARCHITECTURE.md`
3. `CONSTRAINTS.md` (30 non-negotiables)
4. `AGENT_CONTRACTS.md`
5. `IMPLEMENTATION_PLAN.md` (Phases 0–11)
6. `HANDOFF_PROTOCOL.md` (12 required handover sections)
7. `tsk task` (master blueprint, 1345 lines)
8. The latest file under `handoffs/`

## Quick start

```bash
bun install

# --- Supabase (once) ---
# 1) Create project at https://supabase.com
# 2) Run ALL three migrations in order in SQL editor:
#    supabase/migrations/001_initial.sql
#    supabase/migrations/002_runtime_supervisor.sql
#    supabase/migrations/003_runtime_supervisor_extensions.sql
# 3) Create Storage bucket `ostra-assets`

# --- Render env (apps/api — secrets live here only) ---
# SUPABASE_URL (or SUPABASE_CONNECTION_STRING / NEXT_PUBLIC_SUPABASE_URL)
# SUPABASE_SERVICE_ROLE_KEY, CORS_ORIGINS,
# WORKER_REGISTRATION_TOKEN (or WORKER_REGISTRATION_SECRET), CRON_SECRET,
# SCHEDULER_ENABLED, KAGGLE_API_TOKEN, KAGGLE_KERNEL_REF, KOKORO_*, COLAB_*, AUTO_PUBLISH=false
# See docs/ENV.md + docs/API_ENV.md for the full list.

# --- Vercel env (apps/web — no secrets) ---
# NEXT_PUBLIC_API_URL=https://your-render-api.onrender.com

# Local dev:
bun run dev              # → Next.js on 0.0.0.0:$PORT (defaults to 3000)

# Typecheck + build:
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix apps/api run build
bun test packages/shared/src/
```

## Workspace layout

```
apps/web/               # Next.js frontend — Vercel
  src/app/runtimes/     # ← runtime scheduling dashboard (mobile-first, editable days_of_week, next-run hint)
apps/api/               # Express API + Orchestrator + Scheduler + Supervisor — Render
  src/lib/scheduler.ts  # tick + duplicate protection + REQUESTED→STARTING lifecycle
  src/lib/lease.ts      # persisted lease (survives restart)
  src/lib/workerHealth.ts
  src/routes/{schedules,runtime,registration}.ts
packages/shared/        # Domain, contracts, state, events — single source of truth
  src/domain/schedules.ts  # isDueNow, nextRunUtc, tzOffsetMinutes, validateScheduleCreate
  src/providers/runtimeStarters.ts  # RuntimeStarter, KaggleRuntimeStarter, Colab* (NOT_AUTOSTARTABLE)
  src/orchestrator/state.ts
supabase/migrations/001_initial.sql  # domain
supabase/migrations/002_runtime_supervisor.sql  # schedules + leases + history + worker extensions
supabase/migrations/003_runtime_supervisor_extensions.sql  # full spec §4-5 (worker_id, error_code, startup_request_id, status lifecycle)
docs/ENV.md             # split env reference (now includes supervisor vars + aliases)
handoffs/               # mandatory handovers
```

## Routes (apps/web)

- `/` — cinematic landing
- `/projects` — projects + episodes + Agent Room
- `/runtimes` — **runtime schedules** (create/edit/toggle/delete, days_of_week, Run Now), Agent Room, provider health, startup history with lifecycle states
- `/projects/[id]` — story bible + characters + locations + episodes
- `/episodes/[id]` — episode detail, pipeline, tasks, scenes, approvals, artifacts
- `/agents` — Agent Room + live provider health probe (from Render)
- `/activity` — immutable audit log (polls Render)
- `/api/health` — shim that proxies to `NEXT_PUBLIC_API_URL/api/health`

## API (apps/api on Render)

- `GET  /health` / `GET /api/health` — truth + provider probe
- `GET  /api/providers`
- `GET|POST /api/projects` · `GET|PATCH /api/projects/:id`
- `GET|POST /api/characters` · `PATCH|DELETE /api/characters/:id`
- `GET|POST /api/locations` · `PATCH|DELETE /api/locations/:id`
- `GET|POST /api/episodes` · `GET|PATCH /api/episodes/:id`
- `GET|POST /api/scenes` · `PATCH|DELETE /api/scenes/:id`
- `GET|POST /api/tasks` · `PATCH /api/tasks/:id`
- `GET|POST /api/events`
- `GET|POST /api/approvals`
- `GET|POST /api/workers` · `PATCH /api/workers/:id` · `POST /api/workers/:id/heartbeat` · `POST /api/workers/register` · `POST /api/workers/heartbeat` (by identity — now authenticated when token is set, supports dynamic endpoint, `current_task`, `metadata`)
- Runtime supervisor:
  - `GET|POST /api/runtime/schedules` · `GET|PATCH|DELETE /api/runtime/schedules/:id` · `POST /api/runtime/schedules/seed`
  - `POST /api/runtime/tick` (Cron-gated via `x-cron-secret`/`x-worker-token` — aliases `WORKER_REGISTRATION_SECRET`) — minute-level due check + heartbeat sweep
  - `POST /api/runtime/run-now` (`{ schedule_id }` or `{ worker_type,runtime,provider }`) — same lifecycle as tick
  - `GET  /api/runtime/history` (`scheduleId`, `worker_type`, `runtime`, `limit`) — now includes `startup_request_id`, `status`, `error_code`, `started_at`, `registered_at`
- `GET|POST /api/artifacts`

## Agent handover rule

Every agent that performs repository work MUST create or update a handover in `handoffs/` before finishing:

`handoffs/HANDOFF-YYYY-MM-DD-<short-task-name>.md` with the 12 required sections in `HANDOFF_PROTOCOL.md`.

## Current status

**Runtime auto-start supervisor shipped — build-verified 2026-09-26.** Kaggle auto-start lifecycle is real (auth check + history + lease + registration + heartbeat-gated `ONLINE` with `REQUESTED→STARTING→REGISTERING→ONLINE`); Colab correctly returns `NOT_AUTOSTARTABLE` until a genuine trigger is proven. No mocks, no fake ONLINE, no hard-coded schedules. See the latest handover in `handoffs/` for tests, known issues, and the exact next task.
