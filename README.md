# Ostra Studio

Ostra Studio is a mobile-first AI production control platform for an original manhwa YouTube channel.

The goal is not merely to upload videos. Ostra coordinates a production pipeline in which specialized real AI workers create stories, scripts, scene specifications, images, narration, and finished videos, while the creator retains final approval before publication.

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

- Script AI: existing Kaggle-hosted model/service
- Image AI: Google Colab-hosted image model
- Voice AI: Kokoro-82M initially, with provider adapters for future alternatives
- Video: FFmpeg-based deterministic renderer
- Database/storage: Supabase candidate
- Frontend: mobile-first web application
- YouTube: official API integration after the production pipeline is stable

## Critical rules

- No mock mode.
- No fake agents.
- No fake success states.
- Real services report their real status.
- AI providers are adapters and must be replaceable.
- Kaggle and Colab are initial runtimes, not permanent architectural dependencies.
- ElevenLabs is optional, never mandatory.
- Human approval is required before publishing by default.
- Failed work must not destroy successful work.
- Production assets are versioned.
- Secrets never belong in frontend code.
- Every important workflow action is auditable.
- Every agent task ends with a handover document for the next agent.

## Repository instructions

Before changing code, read:

1. `PROJECT_CONTEXT.md`
2. `ARCHITECTURE.md`
3. `CONSTRAINTS.md`
4. `AGENT_CONTRACTS.md`
5. `IMPLEMENTATION_PLAN.md`
6. `HANDOFF_PROTOCOL.md`
7. The latest file under `handoffs/`

Do not invent architecture when the repository already specifies it. If a decision genuinely needs to change, document why and update the relevant specification.

## Agent handover rule

Every agent that performs repository work MUST create or update a handover file in `handoffs/` before finishing.

The handover must state:

- what was changed
- files changed
- current implementation status
- tests/checks run and results
- known issues
- unfinished work
- important decisions
- environment/configuration requirements
- exact next recommended task
- anything the next agent must not redo

A task is not considered complete until the handover is written.

## Current status

The repository is at the documentation/foundation stage. The next implementation agent should establish the project foundation according to the implementation plan, not create mock workers.
