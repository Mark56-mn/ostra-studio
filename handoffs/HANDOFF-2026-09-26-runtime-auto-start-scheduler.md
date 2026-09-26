# Handoff — Configurable External Runtime Auto-Start Scheduling

## 1. Task
Update Ostra Studio's repository specification to support automatic startup of temporary Script, Image, and Voice AI runtimes multiple times per day, with user-configurable schedules.

## 2. Result
Updated the master task/specification and core architecture documents with a runtime supervisor model.

The specification now defines:
- Render as the scheduler/control-plane host.
- Script AI → Kaggle as the first real auto-start implementation.
- Image AI → Colab and Voice AI → Colab as adapter-based targets, only after a real trigger mechanism is verified.
- Multiple daily schedule windows (morning/afternoon/evening examples).
- Editable times, including changing 09:00 to 05:00.
- Per-worker enable/disable and timezone support.
- Manual Run Now.
- Duplicate-start protection and startup leases.
- Worker registration + health validation before ONLINE status.
- Heartbeats, timeout handling, startup history, and auditable events.

## 3. Repository state
Branch: main
Latest touched commits:
- a1dbf10 — tsk task
- 996df68 — IMPLEMENTATION_PLAN.md
- 1e0f63f — ARCHITECTURE.md
- 079d544 — PROJECT_CONTEXT.md
- 8c8e426 — AGENT_CONTRACTS.md

## 4. Files changed
- tsk task — added section 37, External Runtime Auto-Start Scheduler.
- IMPLEMENTATION_PLAN.md — added Phase 10A.
- ARCHITECTURE.md — added runtime supervisor architecture.
- PROJECT_CONTEXT.md — documented configurable external runtime scheduling.
- AGENT_CONTRACTS.md — added runtime starter and scheduler contracts.

## 5. Tests/checks
Documentation-only specification update. No application tests were run.

## 6. Integration status
- Kaggle API: current public documentation verifies programmatic kernel execution capability; exact production trigger flow for this Ostra notebook is NOT YET VERIFIED.
- Colab auto-start: NOT VERIFIED; do not claim it is supported yet.

## 7. Known issues
The trigger that starts a Kaggle notebook is separate from the FastAPI/tunnel becoming reachable. The Kaggle worker must self-register and heartbeat before Ostra marks it ONLINE.

Kaggle/Colab free-tier runtime quotas and session limits must be handled as real provider states.

## 8. Decisions
- Scheduler is in Render, not Vercel.
- Schedule times are persisted data, not hard-coded source constants.
- Each worker can have independent schedule windows.
- A healthy already-running worker must not be started again.
- Auto-start does not imply auto-publish.
- No fake runtime/startup states.

## 9. Environment/configuration
Planned server-side Kaggle configuration includes:
- KAGGLE_API_TOKEN
- KAGGLE_KERNEL_REF

Never expose these values to frontend code or commit them.

## 10. Next agent
Implement the persisted schedule model and Render scheduler service, then implement and exercise the Kaggle runtime starter against the real Ostra Script AI notebook.

The next agent should verify the exact Kaggle API/CLI command, permissions, kernel status behavior, and how the notebook registers its live endpoint with Ostra.

## 11. Do not redo
Do not recreate the architecture/specification from scratch. The runtime lifecycle, schedule model, failure behavior, and contracts are already documented in the files above.

## 12. Verification
The repository specification changes are committed. Runtime execution, worker registration, heartbeat, and automatic schedule execution remain unverified until implemented and exercised.
