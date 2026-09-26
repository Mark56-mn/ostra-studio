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

### Image AI
Initial runtime: Google Colab.

Responsibilities:
- character visuals
- environments
- scene artwork
- thumbnails
- visual assets

It receives structured scene specifications and relevant references.

### Voice AI
Initial provider: Kokoro-82M, initially expected to run in Colab.

Responsibilities:
- narration
- dialogue/voice segments
- scene audio

Voice is provider-independent. Future adapters may include Piper, ElevenLabs, or other providers.

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
- frontend: Vercel-compatible
- database: Supabase Postgres
- storage: Supabase Storage
- Script AI: Kaggle
- Image/Voice: Colab
- renderer: FFmpeg worker
- YouTube: official API

These are replaceable implementation choices, not permanent dependencies.

## 8. User constraints

The dashboard must work well from an Android phone:
- mobile-first
- responsive
- touch-friendly
- lightweight
- usable for monitoring and approval
- video preview on mobile

## 9. Development philosophy

Build the real architecture first and connect real services as their adapters are implemented.

Do not build fake agents just to make screens look complete.

If a service is unavailable, show its actual state: OFFLINE, WAITING, FAILED, etc.

Preserve working infrastructure and avoid unnecessary rewrites.
