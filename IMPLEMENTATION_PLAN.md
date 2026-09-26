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

## Phase 5 — Image AI adapter

Connect the actual Colab image model.

Required:
- worker registration
- health
- task submission
- artifact return
- image versioning
- failure/retry behavior

## Phase 6 — Voice adapter

Implement provider-independent voice capability.

Initial:
- Kokoro-82M

Future adapters:
- Piper
- ElevenLabs
- other providers

Voice must support scene/segment-level regeneration.

## Phase 7 — Video rendering

Implement real FFmpeg rendering:
- image sequencing
- narration synchronization
- subtitles
- transitions
- music/SFX hooks
- output validation
- resumable/retryable rendering where practical

## Phase 8 — Human review

Implement:
- video preview
- asset preview
- approve
- reject
- request changes
- regenerate selected assets
- revision tracking

## Phase 9 — YouTube

Implement real YouTube authentication/upload.

Rules:
- approval required
- upload state persisted
- video id persisted
- failures recoverable
- no secret in frontend

## Phase 10 — Scheduler and automation

Only after the manual production pipeline is reliable.

Initial target:
- one video per week

Later:
- configurable cadence
- queued episodes
- notifications
- automated preparation

## Phase 11 — Analytics

Add YouTube metrics and creator-facing reporting.

## Definition of done for the first production milestone

A real original episode can travel through:

story → script → scenes → images → voice → FFmpeg video → storage → human approval

without mock data.

YouTube upload can follow after the review gate is verified.
