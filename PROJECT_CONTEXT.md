# Ostra Studio — Project Context

## 1. Product

Ostra Studio is the control plane and production workspace for a creator who wants to produce original manhwa storytelling videos for YouTube with specialized AI workers.

The creator supplies original story ideas and remains the director and final approver.

Initial target cadence: one finished video per week.

## 2. Production workers

### Script AI
Initial runtime: Kaggle.

Responsibilities:
- story development
- episode planning
- script writing
- dialogue
- narration text
- scene breakdown
- image specifications
- continuity checks
- authorized tool use

The existing Kaggle model/service is the first real Script AI integration. Do not replace it with a fake implementation.

**Runtime auto-start:** Script AI is auto-started on Render via `KaggleRuntimeStarter` → real Kaggle API (`KAGGLE_API_TOKEN` + `KAGGLE_KERNEL_REF`, server-only, redacted) → notebook kernel → Qwen → FastAPI + tunnel → authenticated `POST /api/workers/register` (worker_id `script-ai-kaggle`-style, dynamic endpoint per session) → heartbeat `POST /api/workers/heartbeat` → health-gated `ONLINE`. No fake success: a Kaggle API `requested` never implies `ONLINE`; only heartbeat does. See `supabase/migrations/002` + `003` and `packages/shared/src/providers/runtimeStarters.ts`.

### Image AI
Initial runtime: Google Colab.

Responsibilities:
- character visuals
- environments
- scene artwork
- thumbnails
- visual assets

It receives structured scene specifications and relevant references.

**Auto-start status:** `NOT_AUTOSTARTABLE` until a reliable external trigger for Colab is researched and verified. The adapter interface (`ColabImageRuntimeStarter`) exists but explicitly returns `NOT_AUTOSTARTABLE`; the Render scheduler records `not_autostartable` / `CANCELLED` and emits `scheduler.skipped_not_autostartable` instead of faking a start. Manual registration + heartbeat still works.

### Voice AI
Initial provider: Kokoro-82M, initially expected to run in Colab.

Responsibilities:
- narration
- dialogue/voice segments
- scene audio

Voice is provider-independent. Future adapters may include Piper, ElevenLabs, or other providers.

**Auto-start status:** Same as Image AI — `ColabVoiceRuntimeStarter` is `NOT_AUTOSTARTABLE` until proven; architecture supports future providers without rewriting the scheduler.

### Video engine
Initial technology: FFmpeg.

It combines approved production assets into deterministic video output.

## 3. Control plane

The orchestrator owns:
- workflow state
- task creation
- task dependencies
- worker registration
- worker health/heartbeat
- context delivery
- agent messages
- artifacts
- retries
- errors
- audit events
- approval gates

Agents must not become uncontrolled peers that directly manage each other.

**Runtime Supervisor (shipped — Phase 10 slice):** Render hosts the scheduler (`apps/api/src/lib/scheduler.ts` + `lease.ts` + `workerHealth.ts`, tick every 60s + `POST /api/runtime/tick` for Cron), persisted schedules (`runtime_schedules` — `local_time HH:MM` + IANA `timezone` + `days_of_week` + `startup_mode` + `max_start_attempts` + `cooldown_minutes`, editable from `/runtimes`), a persisted startup lease (`runtime_startup_leases` — one active per `(worker_type,runtime)`, survives Render restart), and audited startup history (`runtime_startup_history` — `startup_request_id`, `worker_id`, `started_at/registered_at/completed_at`, `status REQUESTED→STARTING→REGISTERING→ONLINE/FAILED/TIMEOUT/CANCELLED`, `error_code`). Duplicate protection: healthy check + lease + cooldown; bounded retries; `Run Now` shares the exact same lifecycle. Dashboard `/runtimes` exposes operational events (`scheduler.*`, `worker.*`).

## 4. Shared context

Every project should have persistent:
- story bible
- characters
- locations
- world rules
- timeline
- story arcs
- visual style
- production settings

Every episode should have:
- concept
- outline
- script
- narration
- scenes
- image requests
- images
- audio
- video
- thumbnail
- quality-control status
- approval status
- YouTube status

## 5. Transparency

The UI should expose operational events, decisions, task inputs/outputs, tool calls, errors, and timestamps.

Do not expose hidden chain-of-thought verbatim. Show concise operational rationale instead.

`/runtimes` shows auditable startup history (lifecycle + `error_code`) and the `scheduler.*` / `worker.*` event taxonomy; `/activity` shows the full immutable `events` stream. Secrets are never logged or displayed.

## 6. Human control

Default:
`AUTO_PUBLISH=false`

The creator must be able to:
- approve
- reject
- request changes
- regenerate selected assets

No video is automatically published unless the creator explicitly enables that behavior.

## 7. Infrastructure philosophy

Keep the control plane lightweight. Heavy model inference should stay in external runtimes when practical.

Initial direction:
- frontend: Vercel-compatible (`apps/web` — only `NEXT_PUBLIC_API_URL`, no secrets)
- API + Orchestrator + Scheduler: Render (`apps/api` — owns all secrets, CORS-locked to Vercel)
- database: Supabase Postgres (`supabase/migrations/001` + `002` + `003`)
- storage: Supabase Storage
- Script AI: Kaggle (auto-started via `KaggleRuntimeStarter`)
- Image/Voice: Colab (adapters present, `NOT_AUTOSTARTABLE` until verified)
- renderer: FFmpeg worker
- YouTube: official API

These are replaceable implementation choices, not permanent dependencies. Vercel never hosts the scheduler; `SUPABASE_CONNECTION_STRING` is an alias for `SUPABASE_URL` on Render; `WORKER_REGISTRATION_SECRET` is an alias for `WORKER_REGISTRATION_TOKEN`.

## 8. User constraints

The dashboard must work well from an Android phone:
- mobile-first
- responsive
- touch-friendly
- lightweight
- usable for monitoring and approval
- video preview on mobile

`/runtimes` (the runtime auto-start control surface) is explicitly mobile-first: stacked schedule cards, touch-friendly `Run Now` / Edit / Pause / Delete, `days_of_week` chip toggles, and an inline edit sheet — no desktop required.

## 9. Development philosophy

Build the real architecture first and connect real services as their adapters are implemented.

Do not build fake agents just to make screens look complete.

If a service is unavailable, show its actual state: OFFLINE, WAITING, FAILED, etc.

Preserve working infrastructure and avoid unnecessary rewrites.

The Runtime Supervisor slice demonstrates this: real Supabase-persisted schedules with timezone-aware `nextRunUtc` (Intl-based, handles `Africa/Lagos` DST scan), real Kaggle auth probe (no fake execution), real `NOT_AUTOSTARTABLE` for Colab with an explicit reason, and heartbeat-gated `ONLINE` (never from a request alone).

## 10. External runtime scheduling

Ostra may automatically start temporary AI runtimes so the creator does not need to manually start every notebook/session.

Initial targets are Script AI on Kaggle and Image/Voice AI on Colab. The Render backend controls schedules; Vercel is only the control UI.

Schedules are configurable data. The creator can configure morning, afternoon, and evening windows, change a time such as 09:00 to 05:00, add/remove windows, enable/disable them, and set the timezone.

A scheduled trigger is not an ONLINE signal. A worker must register and pass health validation before Ostra reports it as ONLINE.
