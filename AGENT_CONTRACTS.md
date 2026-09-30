# Ostra Studio — Agent Contracts

## Purpose

This document defines how production workers interact with Ostra. It is a contract, not a prompt.

## General worker contract

Every worker must expose:

- identity
- worker type
- provider
- model
- runtime
- health/status
- capabilities
- current task
- last heartbeat
- error state where applicable

Every task response must identify:
- task id
- status
- artifacts produced
- structured metadata
- error information if failed

## Script Worker

Input:
- project/story context
- episode context
- requested task
- relevant previous artifacts

Output may include:
- story updates
- episode outline
- script
- scene specifications
- narration
- image specifications
- structured decisions

It must not directly mutate unrelated production state.

## Image Worker

Input:
- scene specification
- character/location references
- visual style
- generation settings

Output:
- image artifact(s)
- provider/model metadata
- generation parameters where safe
- version information

## Voice Worker

Input:
- narration/dialogue segment
- selected voice
- language
- provider settings

Output:
- audio artifact
- duration
- provider/model metadata
- version information

Initial provider target: Kokoro-82M.

## Renderer

Input:
- ordered scene assets
- audio
- subtitle/timing information
- production settings

Output:
- video artifact
- render metadata
- validation information

Renderer must be deterministic where practical.

## YouTube Worker

Input:
- approved video
- title
- description
- thumbnail
- publishing settings

Output:
- YouTube video id
- upload/publish status
- timestamps
- returned URL when available

It must refuse/stop when approval is absent.

## Runtime Supervisor Contract (Phase 10 slice — shipped)

### Worker self-registration

When an external runtime (Kaggle Script AI notebook) starts, it must register itself:

- `POST /api/workers/register` — body `{ worker_id?, worker_type, runtime, provider, model?, endpoint?, capabilities?, metadata?, registration_token? }` — header `x-worker-token` or `Authorization: Bearer <token>` also accepted.
- Token is `WORKER_REGISTRATION_TOKEN` (alias `WORKER_REGISTRATION_SECRET`) — server-only, never committed or displayed in the dashboard, never logged, validated by the backend. When the variable is set, the request **must** carry it; when not set, open registration is allowed but still audited (dev only).
- Identity: `worker_id` slug like `script-ai-kaggle`; persisted in `workers.worker_id`. Registration upserts on `(type, runtime, provider)` — not on endpoint — so the `endpoint` (tunnel URL, dynamic per Kaggle session) is replaced on every re-registration. `registered_at` + `last_heartbeat_at` + `last_seen_at` are set; `heartbeat_timeout_sec` (default 90, clamped 30..600) is recorded; `error`/`error_code`/`error_message` are cleared.
- On success: emits `worker.registration_received` + `worker.health_check_passed`; advances the most recent pending `runtime_startup_history` row from `REQUESTED/STARTING` to `registered`/`REGISTERING` and then `health_passed`/`ONLINE` with `worker_id` + `registered_at`. Returns `{ worker, health:"ONLINE" }`.

### Heartbeat

- `POST /api/workers/heartbeat` — body `{ worker_type, runtime, provider, status?, endpoint?, current_task?, metadata? }` — same token accepted. When `WORKER_REGISTRATION_TOKEN`/`WORKER_REGISTRATION_SECRET` is configured, heartbeat **requires** the token (401 if missing/wrong).
- Updates `last_heartbeat_at`, `last_seen_at`, `status` (allowed: `ONLINE|IDLE|WORKING|WAITING|QUEUED`), optional `endpoint` and `current_task`/`metadata`, and clears stale error fields. Emits `worker.heartbeat_received`.
- Liveness: `isHealthyWorker` requires a non-stale heartbeat within `heartbeat_timeout_sec`. `sweepStaleWorkers` (called on every scheduler tick) marks stale workers `OFFLINE` with `error_code=HEARTBEAT_TIMEOUT` and emits `worker.timeout` + `worker.offline`; it also advances pending startup rows to `timed_out`/`TIMEOUT`. Tasks that were `QUEUED` remain `QUEUED` — never deleted on timeout.

### RuntimeStarter abstraction

- `RuntimeStarter` (`runtime`, `provider`, `autostartable`, `start(input) → RuntimeStartOutcome`) is the sole interface the scheduler depends on. `KaggleRuntimeStarter` (autostartable) checks `KAGGLE_KERNEL_REF` then `KAGGLE_API_TOKEN`, supports `KAGGLE_EXEC_DISABLED=true`, performs an auth check against `https://www.kaggle.com/api/v1/kernels/list?mine=true` with bearer token, and returns `requested` with `startup_request_id` + `provider_run_id` only on 200; 401/403→`AUTH_FAILED`, 429→`RATE_LIMITED`; all `provider_response` is `redactSecrets()`-scrubbed. `ColabImage`/`ColabVoiceRuntimeStarter` are explicit `NOT_AUTOSTARTABLE` until a verified trigger is proven. `resolveRuntimeStarters()` / `findStarter()` is the registry.

### Scheduler

- Runs on Render only (never Vercel). Tick: `POST /api/runtime/tick` (Cron-gated via `x-cron-secret` or `x-worker-token` — both `WORKER_REGISTRATION_TOKEN`/`WORKER_REGISTRATION_SECRET` aliases accepted; accepts optional `{ at }` for deterministic testing) and an in-process fallback every `SCHEDULER_TICK_MS` (default 60s, first tick +5s). Each tick evaluates enabled `runtime_schedules` via `isDueNow` (minute-exact in the schedule's IANA timezone), sweeps stale heartbeats, and uses a persisted lease (`runtime_startup_leases` — one active per `(worker_type,runtime)` where `released_at is null`, expiry sweep + partial unique, TTL `max(cooldown,30)m`, survives Render restart).
- Startup order per schedule (and per `POST /api/runtime/run-now` — same `evaluateAndStart`): `not_autostartable` guard → already-healthy check (`skipped_already_online` / `CANCELLED`) → cooldown check (`skipped_cooldown`) → bounded retries (`max_start_attempts` in 24h → `FAILED` / `MAX_ATTEMPTS`) → `tryAcquireLease` (`skipped_in_progress` / `LEASE_HELD` on race) → `scheduler.triggered` → `startViaStarter` → on failure `FAILED` + `worker.offline` (tasks stay `QUEUED`) → on success records `REQUESTED` + `STARTING` with `startup_request_id` + `started_at` → `scheduler.start_requested` → lease carries `provider_run_id` → release. Only registration + heartbeat make the worker `ONLINE`; a start request never does.
- Six failure cases are auditable in `runtime_startup_history` + `events`: A `skipped_already_online`, B Kaggle API failure → `FAILED`, C no registration → `TIMEOUT` → `OFFLINE`, D tunnel churn → re-registration replaces endpoint, E Render restart → lease persists, F schedule edit (`PATCH local_time`/`timezone`/`days_of_week`) takes effect on the next tick (timezone-aware `nextRunUtc`).
- `runtime_startup_history` is the audit trail (survives restart): `startup_request_id`, `worker_id`, `provider_run_id`, `started_at`, `registered_at`, `completed_at`, `status` (`REQUESTED→STARTING→REGISTERING→ONLINE / FAILED / TIMEOUT / CANCELLED`), `error_code`/`error_message`, `metadata`, redacted `provider_response`.

## Message rules

Messages should be:
- task-scoped
- structured
- attributable
- timestamped
- persisted when important

Do not use hidden direct agent-to-agent channels that bypass the orchestrator.

## Operational reasoning

Expose concise operational rationale, decisions, and actions.

Do not expose private hidden chain-of-thought.

### Agent Chat exception (2026-09-30 — explicit director request)

The Agent Chat room (`/chat`) shows the Script AI's own thinking in a collapsed **THINKING** block above
its answer, because the director asked to see the reasoning separately the way a coding agent does. This
is a deliberate, narrow exception to the rule above, and it is bounded:

- the trace is the model's real output — Qwen3's inline thinking tags inside `content`, or a server's
  `reasoning_content`-style field — split off by `splitReasoning` **before** the JSON envelope is parsed
  (`packages/shared/src/agent/protocol.ts`). Ostra never writes, summarises or rewords it, and when the
  model does not think there is no trace at all, so no block renders. Nothing is ever fabricated;
- it is collapsed by default, so it never displaces the answer or the operational messages;
- it is persisted as `chat_messages.reasoning` (migration `006_chat_reasoning.sql`) for the room's audit
  trail, and is deliberately **not** sent back to the model on later turns, so it cannot compound;
- everything else keeps the rule: worker/task messages carry concise operational rationale
  (decision / reason / action), not raw chain-of-thought.

## Provider replacement

The workflow must depend on capability contracts, not provider-specific behavior.

For example:
`generate_voice()` is a capability; Kokoro and ElevenLabs are implementations.


## Runtime starter contract

A runtime starter is responsible only for requesting startup of a temporary external worker runtime.

Input:
- worker type
- runtime/provider
- schedule/manual trigger source
- runtime configuration reference

Output:
- startup request id
- provider request/result
- provider run identifier where available
- initial state

It must not claim the worker is ONLINE. Online state is established by worker registration + health validation.

Runtime starters must be replaceable. The initial implementation is:
- Kaggle starter → Kaggle kernel execution
- Colab starters → only after a real trigger mechanism is verified

### Scheduler contract

The scheduler accepts persisted, timezone-aware schedule windows and emits startup requests. It must:
- avoid duplicate starts
- respect enabled/disabled state
- respect cooldown/lease
- record events
- expose next/last run
- preserve queued tasks when a worker cannot start
