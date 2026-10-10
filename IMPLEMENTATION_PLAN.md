# Ostra Studio — Implementation Plan

## Deployment topology (non-negotiable initial direction)

- Ostra Studio website/dashboard: **Vercel**.
- Backend API + Orchestrator: **Render**.
- Database: **Supabase Postgres**.
- Large production files: **Supabase Storage**.
- Script AI: Kaggle initially.
- Image AI: Google Colab initially.
- Voice AI: Google Colab initially.
- Heavy video rendering: a worker/runtime separate from the Render control API when practical; do not assume Render Free is suitable for long FFmpeg jobs.

The frontend must communicate with the backend through a documented API. Do not merge frontend and backend into a single Render deployment merely for convenience. Keep deployment boundaries replaceable.

## Phase 0 — Repository foundation

Create the application foundation and documentation structure.

Required:
- project setup
- environment strategy
- base application structure
- database schema plan
- provider interface plan
- task/event domain models
- handover system

No mock agents.

**Status: shipped** — `supabase/migrations/001_initial.sql`, `packages/shared` domain/contracts, `docs/ENV.md`, `handoffs/`.

## Phase 1 — Domain foundation

Implement:
- projects
- stories/story bible
- episodes
- scenes
- assets
- agents
- tasks
- task dependencies
- events
- approvals

**Status: shipped** — domain schemas, projects/episodes/scenes/artifacts/tasks/events/approvals routes on Render, Supabase schema.

## Phase 2 — Orchestrator

Implement real:
- worker registration
- health/heartbeat
- task lifecycle
- dependencies
- retries
- artifact tracking
- event logging
- controlled agent messaging

**Status: shipped (Phase 2 spine + Runtime Supervisor extension)** — `apps/api/src/routes/registration.ts` (upsert on `(type,runtime,provider)`, dynamic endpoint, heartbeat auth, `sweepStaleWorkers`), `apps/api/src/lib/workerHealth.ts`, `packages/shared/src/orchestrator/state.ts`, events audit.

## Phase 3 — Dashboard

Implement:
- project view
- episode pipeline
- agent status
- Agent Room
- task/activity timeline
- asset browser
- errors
- approvals

Must be mobile-first.

**Status: shipped** — `apps/web` (`/`, `/projects`, `/projects/[id]`, `/episodes/[id]`, `/agents`, `/activity`, `/runtimes`), `AgentRoom`, mobile-first tailwind, `apiUrl()` wiring to Render.

## Phase 4 — Script AI adapter

Connect the existing real Kaggle Script AI.

Required:
- authentication/secure connection mechanism
- health check
- task submission
- result retrieval
- timeout/error handling
- reconnect behavior

Do not fake results when Kaggle is unavailable.

**Status: adapter shipped, live verification pending** — `KaggleRuntimeStarter` (real Kaggle API `GET /api/v1/kernels/list?mine=true` auth check, `KAGGLE_API_TOKEN` + `KAGGLE_KERNEL_REF` server-only, redacted responses, `KAGGLE_EXEC_DISABLED` probe mode, never ONLINE from request alone) in `packages/shared/src/providers/runtimeStarters.ts`. Health comes from `POST /api/workers/register` + `POST /api/workers/heartbeat` (authenticated). Needs a real Render+Supabase+Kaggle deployment to exercise the full `Render→Kaggle→Notebook→Qwen→FastAPI+tunnel→register→health→ONLINE` loop; see the latest handover's §10 for the exact steps.

## Phase 5 — Image AI adapter

Connect the actual Colab image model.

Required:
- worker registration
- health
- task submission
- artifact return
- image versioning
- failure/retry behavior

**Status: adapter shipped and live-probed; the endpoint is not enabled for this account (2026-10-09)** — the image provider adapter (`packages/shared/src/providers/media.ts` + `apps/api/src/lib/mediaProviders.ts`) targets NVIDIA's `POST …/v1/images/generations` and the documented Cosmos route, with an honest error map (401/403 → NOT_AUTHORIZED, 429 → RATE_LIMITED with the real Retry-After, timeout → TIMEOUT that explicitly does NOT claim generation stopped). The live probe from this account's key returned **HTTP 404 for every image model** (flux.1-schnell, sdxl-turbo, diffusiongemma) while the same host correctly returns 400 for malformed requests — i.e. no image model is *enabled for this account*. Enabling one on build.nvidia.com makes the adapter work with no code change. `ColabImageRuntimeStarter` remains `NOT_AUTOSTARTABLE` (honest), scheduler skips with `not_autostartable`. `POST /api/media/probe` reports the real availability any time it is asked.

## Phase 6 — Voice adapter

Implement provider-independent voice capability.

Initial:
- Kokoro-82M

Future adapters:
- Piper
- ElevenLabs
- other providers

Voice must support scene/segment-level regeneration.

**Status: REAL TTS VERIFIED LIVE (2026-10-09)** — `nvidia/magpie-tts-multilingual` answered **HTTP 200 with a real 67,628-byte WAV** (RIFF header verified) through the adapter in `apps/api/src/lib/mediaProviders.ts` (`buildTtsFields` + `looksLikeWav`, so a 200 that is not audio is refused rather than called generated). `ElevenLabs` stays optional (`CONSTRAINTS.md` 8) and is not required. Self-hosted Kokoro-82M remains the quota-free adapter target; `ColabVoiceRuntimeStarter` is still `NOT_AUTOSTARTABLE` because no real Colab trigger is proven.

## Phase 6A — Season-first approval workflow (spec §5)

**Status: shipped (2026-10-09)** — `supabase/migrations/010_seasons_and_notifications.sql` adds `seasons`
(one complete package per cycle: title, premise, per-episode synopses, cast, world, arcs, ending,
open `assumptions`, production estimate) and `notifications` (in-app inbox, idempotent via
`dedupe_key`). The decision logic is pure and unit-tested in `packages/shared/src/domain/seasons.ts`
(17 tests): only a human decision can approve, an approved season is locked against edits, and
`productionGate()` refuses image/voice/video/YouTube task creation with `409 SEASON_NOT_APPROVED`
until a season for that project is approved — enforced in `apps/api/src/routes/tasks.ts`, the same
rule the `/seasons` page renders. `POST /api/seasons/:id/submit` raises the notification the spec's
Phase 3 asks for. Routes: `/api/seasons` (+ `/submit`, `/decision`), `/api/notifications`.
UI: `/seasons` (package review, approve / request changes / reject, gate banner, inbox).

## Phase 7 — Video rendering

Implement real FFmpeg rendering:
- image sequencing
- narration synchronization
- subtitles
- transitions
- music/SFX hooks
- output validation
- resumable/retryable rendering where practical

**Status: not started** — `VideoRenderer` contract exists; FFmpeg is marked independently replaceable (never assumed stable on Render Free).

## Phase 8 — Human review

Implement:
- video preview
- asset preview
- approve
- reject
- request changes
- regenerate selected assets
- revision tracking

**Status: spine exists** — `/episodes/[id]` + approvals route + `AUTO_PUBLISH=false` gate; deep review UI pending.

## Phase 9 — YouTube

Implement real YouTube authentication/upload.

Rules:
- approval required
- upload state persisted
- video id persisted
- failures recoverable
- no secret in frontend

**Status: not started** — YouTube provider is an offline stub; OAuth env vars documented.

## Phase 10 — Scheduler and automation

Only after the manual production pipeline is reliable.

Initial target:
- one video per week

Later:
- configurable cadence
- queued episodes
- notifications
- automated preparation

**Status: first production slice shipped (2026-09-26) — Runtime Auto-Start Supervisor.** The spec's 29-part vertical slice is implemented on Render: persisted `runtime_schedules` (`local_time` + IANA `timezone` + `days_of_week` + `startup_mode` + `max_start_attempts` + `cooldown_minutes`), persisted `runtime_startup_leases` (survives restart), audited `runtime_startup_history` (lifecycle `REQUESTED→STARTING→REGISTERING→ONLINE / FAILED / TIMEOUT / CANCELLED`, `startup_request_id`, `error_code`, `started_at`/`registered_at`), `RuntimeStarter` abstraction (`KaggleRuntimeStarter` real, Colab `NOT_AUTOSTARTABLE`), authenticated registration + heartbeat with dynamic tunnel endpoint, mobile-first `/runtimes` dashboard (editable schedules, `days_of_week`, next-run hint, Run Now sharing the same lease lifecycle), and six auditable failure cases. Verify the live `Render→Kaggle→Notebook→register→heartbeat→ONLINE` loop from a real deployment before expanding to Image/Voice auto-start (Phases 5/6) and weekly cadence automation.

## Phase 11 — Analytics

Add YouTube metrics and creator-facing reporting.

**Status: not started.**

## Definition of done for the first production milestone

A real original episode can travel through:

story → script → scenes → images → voice → FFmpeg video → storage → human approval

without mock data.

YouTube upload can follow after the review gate is verified.


## Phase 10A — External runtime auto-start supervisor

Before broad production automation, implement a configurable runtime supervisor in the Render control plane.

Scope:
- configurable multiple daily startup times per worker
- timezone-aware schedules
- enable/disable schedule windows
- manual Run Now
- persisted next/last run metadata
- duplicate-run protection
- startup leases/timeouts
- runtime registration and heartbeat
- real health validation
- startup history/events

Initial workers:
- Script AI / Kaggle
- Image AI / Colab
- Voice AI / Colab

Important: Kaggle API execution is a real trigger mechanism, but the trigger itself does not prove that the model API is reachable. The worker must register and pass health checks before being considered ONLINE.

Colab startup must remain adapter-based and must only be marked supported after a real trigger mechanism is verified. Do not create a fake Colab startup.

Suggested initial UI schedule examples (editable, not hard-coded):
- Morning 09:00
- Afternoon 14:00
- Evening 20:00

The creator must be able to change 09:00 to 05:00, add/remove windows, enable/disable them, and set timezone without code changes.

Free-tier quotas/session limits must surface as real provider failures or unavailable states.
