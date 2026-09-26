# Ostra Studio — Architecture

## System model

Ostra has two major planes.

### Control plane

- Web dashboard
- API
- Orchestrator
- task queue/state
- scheduler — **Runtime Supervisor (Render)**: persisted schedules, persisted startup lease, audited startup history, `RuntimeStarter` abstraction
- database
- audit/event stream
- approval system
- provider registry

### Production plane

- Script AI (Kaggle — auto-started via `KaggleRuntimeStarter`; `ONLINE` only after authenticated registration + heartbeat)
- Image AI (Colab — `NOT_AUTOSTARTABLE` until a real programmatic trigger is proven)
- Voice AI (Colab/Kokoro-82M — same)
- FFmpeg renderer
- asset storage
- YouTube integration

## High-level flow

```
                    OSTRA STUDIO
                         |
                    ORCHESTRATOR
              _________/ | \_________
             /           |           \
        SCRIPT AI     IMAGE AI     VOICE AI
             \           |           /
              \__________|__________/
                         |
                   VIDEO ENGINE
                         |
                  ASSET STORAGE
                         |
                   HUMAN REVIEW
                         |
                      YOUTUBE
```

## Runtime Supervisor (new — Phase 10 slice)

```
Dashboard (Vercel)
        ↓
Render Scheduler (tick every 60s + Cron POST /api/runtime/tick)
        ↓
evaluateAndStart: healthy? → lease (persisted, survives restart) → RuntimeStarter → history
        ↓
Kaggle API (Bearer token, KAGGLE_KERNEL_REF — server-only, redacted)
        ↓
Kaggle kernel → Qwen → FastAPI + tunnel (dynamic URL)
        ↓
POST /api/workers/register (x-worker-token / WORKER_REGISTRATION_TOKEN or WORKER_REGISTRATION_SECRET)
        ↓
Workers row upsert on (type,runtime,provider) — endpoint churn handled; status=ONLINE, heartbeat timestamps
        ↓
POST /api/workers/heartbeat (authenticated when token is configured) → extends liveness
        ↓
sweepStaleWorkers: no heartbeat beyond heartbeat_timeout_sec → OFFLINE + TIMEOUT history (tasks stay QUEUED)
```

- **Persisted state:** `runtime_schedules` (local_time + IANA timezone + days_of_week + startup_mode + cooldown + max_attempts), `runtime_startup_leases` (one active per worker_type/runtime, partial unique `released_at is null`, TTL `max(cooldown,30)m`, expiry sweep), `runtime_startup_history` (startup_request_id, worker_id, provider_run_id, started_at/registered_at/completed_at, status `REQUESTED→STARTING→REGISTERING→ONLINE / FAILED / TIMEOUT / CANCELLED`, error_code/error_message, metadata, redacted provider_response).
- **Lifecycle:** `REQUESTED → STARTING → REGISTERING → ONLINE`; failures → `FAILED` (Kaggle auth/rate-limit, max_attempts), `TIMEOUT` (no registration within heartbeat window), `CANCELLED`/`skipped_*` (already online, not_autostartable, cooldown, lease held). Never `ONLINE` from a request alone.
- **Duplicate protection:** already-healthy check + persisted lease + cooldown, all surviving Render restart. Bounded retries via `max_start_attempts`; no infinite loops.
- **Run Now** (`POST /api/runtime/run-now`) reuses the exact same `evaluateAndStart` path as the scheduler tick.

## Worker adapter model

Each worker is exposed through a stable capability contract rather than hard-coded provider logic.

Examples:

- ScriptProvider
- ImageProvider
- VoiceProvider
- VideoRenderer
- StorageProvider
- YouTubeProvider
- NotificationProvider

A provider implementation can change without changing workflow/domain logic.

**Runtime start** is also adapter-based: `RuntimeStarter` (`runtime`, `provider`, `autostartable`, `start() → RuntimeStartOutcome`). `KaggleRuntimeStarter` is the first real implementation (auth check `GET /api/v1/kernels/list?mine=true`, redacted); `ColabImageRuntimeStarter` / `ColabVoiceRuntimeStarter` are explicit `NOT_AUTOSTARTABLE` until a verified trigger exists. Registry is `resolveRuntimeStarters()` / `findStarter()`.

## Agent states

Minimum states:

- OFFLINE
- CONNECTING
- ONLINE
- IDLE
- QUEUED
- WORKING
- WAITING
- COMPLETED
- FAILED
- RETRYING

A worker heartbeat/health signal must be distinguishable from a completed production task. `isHeartbeatStale` / `isHealthyWorker` + `heartbeat_timeout_sec` (default 90, per-worker tunable) determine liveness; `sweepStaleWorkers` transitions `OFFLINE`.

Startup attempts have their own lifecycle (`runtime_startup_history.status`): `REQUESTED`, `STARTING`, `REGISTERING`, `ONLINE`, `FAILED`, `TIMEOUT`, `CANCELLED` (with legacy lower-case aliases for backward compat).

## Task model

A task should identify:

- task id
- project
- episode
- scene where relevant
- task type
- assigned worker
- required inputs
- dependencies
- status
- attempts
- output artifacts
- error details
- created/started/completed timestamps

Tasks must be resumable where possible. Offline workers leave tasks `QUEUED` — no deletion on startup failure.

## Event model

Important operations produce immutable/auditable events such as:

- worker.connected
- worker.disconnected
- worker.registration_received / worker.health_check_passed / worker.heartbeat_received / worker.timeout / worker.offline
- scheduler.triggered / scheduler.skipped_already_online / scheduler.skipped_in_progress / scheduler.skipped_cooldown / scheduler.skipped_not_autostartable / scheduler.start_requested / scheduler.start_failed / scheduler.schedule_created|updated|deleted
- task.created
- task.started
- task.waiting
- task.completed
- task.failed
- artifact.created
- artifact.versioned
- agent.message
- approval.requested
- approval.granted
- approval.rejected
- youtube.upload.started
- youtube.upload.completed

Startup attempts are also persisted in `runtime_startup_history` with `startup_request_id` correlation.

## Agent communication

Agents communicate through the orchestrator.

```
Script AI -> Orchestrator -> Image AI
Image AI  -> Orchestrator -> Script AI
Voice AI  -> Orchestrator -> Video Engine
```

Messages should reference structured tasks/artifacts rather than depending on free-form conversation alone.

## Shared artifact model

Artifacts are immutable/versioned production outputs.

Examples:

- script
- scene specification
- character reference
- generated image
- narration audio
- subtitle file
- thumbnail
- draft video
- final video

Never destroy a successful version merely because a new version is generated.

## Storage separation

Database stores metadata and state.

Object storage stores large binary assets.

Do not put large video/audio/image binaries directly into database rows.

## Failure behavior

External runtime unavailable:
- worker becomes OFFLINE
- queued tasks remain intact
- no fake completion is emitted
- startup history records `FAILED` with `error_code` (e.g. `AUTH_FAILED`, `RATE_LIMITED`, `MAX_ATTEMPTS`)

Task failure:
- preserve previous successful artifacts
- capture structured error
- allow retry
- do not silently regenerate unrelated completed work

Startup failure taxonomy (six cases):
- A already online → `skipped_already_online` / `CANCELLED`
- B Kaggle API failure → `FAILED` + `worker.offline`, no fake ONLINE
- C no registration within timeout → `TIMEOUT` → `OFFLINE` via `sweepStaleWorkers`
- D tunnel URL changes → new registration upserts endpoint
- E Render restarts → lease row persists/expires over restart, no duplicate start
- F schedule changes → `PATCH local_time` respected on next tick (timezone-aware `nextRunUtc`)

## Approval flow

```
PRODUCTION
   |
QUALITY CHECK
   |
READY_FOR_REVIEW
   |
HUMAN APPROVAL
   |---- reject/request changes --> revision workflow
   |
 APPROVED
   |
UPLOAD QUEUE
   |
YOUTUBE
```

## Future extensibility

The architecture may later support:
- research worker
- thumbnail worker
- SEO worker
- analytics worker
- community worker
- additional image/voice providers

Do not implement future workers until the core production path needs them.


## External runtime supervisor

The scheduler is part of the Render control plane and supervises temporary production runtimes.

```text
                    RENDER CONTROL PLANE
                           |
                    RUNTIME SUPERVISOR
                    /        |        \
                   /         |         \
             Kaggle       Colab       Colab
             Script       Image        Voice
                |            |           |
                +------------+-----------+
                             |
                       registration
                        + heartbeat
                             |
                       ORCHESTRATOR
```

A schedule fires a startup request; it does not itself establish worker availability. A worker becomes ONLINE only after registration and health validation.

Each runtime starter implements a replaceable capability such as:
`startRuntime(workerType, runtimeConfig)`.

The scheduler owns:
- schedules
- timezone conversion
- startup leases
- duplicate protection
- retries
- startup history
- next/last run
- runtime lifecycle state

The worker owns:
- service startup
- registration
- endpoint publication
- heartbeat
- health response

For tunnel-based workers, the endpoint may change between sessions and must be updated through registration.
