# Ostra Studio — Architecture

## System model

Ostra has two major planes.

### Control plane

- Web dashboard
- API
- Orchestrator
- task queue/state
- scheduler
- database
- audit/event stream
- approval system
- provider registry

### Production plane

- Script AI
- Image AI
- Voice AI
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

A worker heartbeat/health signal must be distinguishable from a completed production task.

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

Tasks must be resumable where possible.

## Event model

Important operations produce immutable/auditable events such as:

- worker.connected
- worker.disconnected
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

Task failure:
- preserve previous successful artifacts
- capture structured error
- allow retry
- do not silently regenerate unrelated completed work

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
