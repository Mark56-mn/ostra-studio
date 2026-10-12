# TASK — Verify Deployment and Repair the End-to-End Production Loop

**Date:** 2026-10-11  
**Priority:** P0 — the user has demonstrated that the production loop stalls  
**Repository:** `Mark56-mn/ostra-studio`  
**Live web:** https://ostra-studio-web.vercel.app/  
**Live API:** https://ostra-studio-1.onrender.com  
**Important:** Do not redo the direct-agent selector from scratch. Recent commits already added per-agent conversations and response-envelope salvage. First verify those commits are deployed, then fix the actual blocked handoffs.

## 1. Current evidence

Latest commits on `main` at task creation:
- `0c23796819b3963d57fc579a26a0540dc8219884` — direct one-to-one conversations with each agent.
- `8b0bf595c3002c70be5b9639087a385f4f403e62` — salvage malformed/truncated agent JSON envelopes and increase turn output budget.

The latest repository has:
- `apps/web/src/app/chat/page.tsx` — TALKING TO target selection and per-target transcript state.
- `apps/web/src/lib/chat.ts` — direct-chat API client and target/status types.
- `apps/api/src/routes/chat.ts` — direct target/message/conversation handlers.
- `apps/api/src/lib/agentChannel.ts` — persisted peer messages and peer delivery.
- `apps/api/src/index.ts` — API route registration.

Previous live checks (2026-10-10) returned HTTP 200 from `/api/agents/roster` and `/api/agents/management`, but showed all five roles routed to the same NVIDIA Nemotron hosted model and no registered worker candidates. This proves a shared hosted model can answer; it does NOT prove independent Kaggle models are connected. The returned timestamp was 2026-10-10, so perform fresh, cache-busted checks to establish whether the current commit is deployed.

The screen recording demonstrates a real loop stall: Voice AI waits for a script excerpt, Image AI waits for finalized specifications, and a production round does not resolve those dependencies. Do not assume the UI alone is responsible.

## 2. First: establish deployment truth

1. Record the current `main` SHA and the Render service's deployed commit/release. If the Render service is behind `8b0bf595c3002c70be5b9639087a385f4f403e62`, deploy the existing code before modifying it.
2. Confirm the Vercel deployment contains the direct-agent selector and uses the correct Render base URL.
3. Perform fresh live requests (avoid cached results) to:
   - `GET /health`
   - `GET /api/agents/roster`
   - `GET /api/agents/management`
4. Create or use a test studio room and exercise each direct conversation route. Never send a real story or publish anything during verification.
5. Capture status, response bodies (redact secrets), server logs, and actual commit/deployment identifiers.

## 3. Diagnose the production-round stall

Trace the actual code path:
- `apps/api/src/routes/agents.ts` — `dispatchRound`, `manageRoom`
- `apps/api/src/lib/agentChannel.ts` — `runProductionRound`, `runAgentTurn`, `deliverPeerMessages`, `settleInbox`
- `apps/api/src/routes/chat.ts` — `sendToAgent`, conversation persistence
- `packages/shared/src/agent/agents.ts` — channel/direct-chat prompts and message protocol
- `apps/api/src/lib/agentRuntime.ts` — provider/model resolution and call results
- migrations for `agent_messages`, `chat_messages.target_kind`, worker registry and heartbeats.

For each turn, prove:
1. The exact user/manager instruction is included in the receiving agent's model context.
2. The provider call succeeds and its actual output is parsed.
3. Every explicit peer message is persisted with correct sender/recipient.
4. The intended recipient is really invoked (not merely marked queued/delivered).
5. The recipient's reply and outputs are persisted and available to the next stage.
6. Errors are recorded and surfaced to the UI without pretending the pipeline progressed.

Do not treat a vague natural-language statement like “waiting for script excerpt” as a resolved dependency. Use structured task/artifact references and explicit stage statuses. An agent may proceed only when the required artifact exists; otherwise it must create a concrete request to the responsible agent, and the orchestrator must either execute that handoff or leave it clearly blocked with a reason.

## 4. Required orchestration behavior

Implement or repair the smallest correct fix using existing architecture:
- Director → Management Team direct chat works as a normal multi-turn conversation.
- Manager instructions become persisted peer messages with real delivery outcomes.
- Script AI produces a versioned script artifact / scene breakdown.
- Image AI receives the finalized script/scene artifact IDs and produces image prompts or image assets, not just a request to wait.
- Voice AI receives finalized narration/script text and produces narration/audio outputs or a truthful provider failure.
- Showrunner checks completed artifacts and reports exact missing/failed stages.
- Production-round response summarizes each stage as `completed`, `blocked`, `skipped_offline`, or `failed`, with a human-readable reason and linked artifact IDs.
- Retries must be idempotent so one retry cannot duplicate messages, scenes, or assets.
- A round should stop or pause on a genuine dependency failure rather than repeatedly calling the same agents with no new context.
- Preserve human approval; YouTube publishing remains OFF unless the user explicitly approves.

## 5. Worker/model honesty

Current live roster previously reported the same NVIDIA Nemotron model for all roles with zero worker candidates. Label this as shared hosted-model role routing. Do not claim Kaggle/Colab is connected unless a fresh worker heartbeat and a real model call are verified. Image generation and voice generation must use their actual media providers, not the text LLM pretending to create media.

## 6. Tests and completion criteria

Add/extend automated tests for:
- Manager-to-script handoff and actual recipient invocation.
- Script output persisted and passed to image stage.
- Script/narration passed to voice stage.
- Missing artifact leaves the round blocked with a clear reason.
- Provider failure and offline worker produce honest statuses.
- Malformed/truncated JSON response salvage does not lose the reply or peer messages.
- Idempotent retry does not duplicate persisted output.
- Approval/publishing guard remains intact.

Run API and web typecheck, lint, and tests available in the repo. Fix regressions. Update README/API docs if behavior changes. Do not claim tests passed unless they were actually run.

## 7. Task/handoff discipline

- Work in small, coherent changes; do not redesign the site or replace working subsystems.
- Update/create task notes as needed.
- Before finishing, create/update `handoffs/HANDOFF-2026-10-11-production-loop-repair.md` following `HANDOFF_PROTOCOL.md`.
- Handoff must state actual deployed commit, checks actually run, what remains unverified, and the next agent's single recommended task.
- Commit and push implementation, then verify the deployed behavior against the same live scenario from the screen recording.

**Done means:** the user can select Management Team and ask a question; the manager can issue a real instruction to Script AI; Script AI's actual output is stored; Image/Voice receive the relevant artifact; the production round reports truthful per-stage outcomes; and live verification shows no unresolved wait caused by missing orchestration.
