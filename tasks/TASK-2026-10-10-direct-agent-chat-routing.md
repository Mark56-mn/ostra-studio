# TASK — Repair Direct Agent Chat and Multi-Agent Routing

**Date:** 2026-10-10  
**Repository:** `Mark56-mn/ostra-studio`  
**Priority:** P0 — core user-facing workflow is incomplete  
**Scope:** Frontend + Render API + tests + documentation + handoff  
**Non-negotiable:** No mock mode, no fabricated replies, no fake “online” states, no success UI unless the real backend confirms success.

## 1. User-visible failures to fix

The user reports:
1. They cannot choose which AI agent to chat with.
2. They cannot reliably chat with the Management Team / manager AI.
3. The manager is not actually coordinating with the other AI models/workers.

Audit of the current repository and deployed site confirms the following:

- Deployed site: https://ostra-studio-web.vercel.app/
- Repo: https://github.com/Mark56-mn/ostra-studio
- Render API: https://ostra-studio-1.onrender.com
- The live `GET /api/agents/roster` endpoint currently returns HTTP 200 and reports `manager`, `overseer`, `script`, `image`, and `voice` as available through `nvidia/nemotron-3-super-120b-a12b`. This proves the hosted NVIDIA route is reachable, but does NOT prove Kaggle workers are connected or that separate models are being used.
- The live `GET /api/agents/management` endpoint returns HTTP 200 and reports the manager available through NVIDIA. Therefore, do not begin by assuming the manager API key is missing. Test the actual POST flow and inspect its real response.
- `/chat` is a single-agent chat page whose copy and implementation address the Script AI only. It has no agent selector.
- `/management` has a “Give instructions” form and “Send to Management Team” / “Brief + run production round” buttons, but no general participant selector or direct chat with each selected participant.
- Backend `apps/api/src/routes/agents.ts` exposes management and production-round actions, but the public route table does not currently expose a direct “send a message to any selected agent” endpoint.
- The live roster currently shows the same NVIDIA model for all roles. These are currently role-specific prompts over a shared hosted model, not proof that distinct Kaggle/model workers are connected. Display that distinction honestly.

Use the actual latest files on `main` before editing; do not overwrite newer work based on old handoff notes.

## 2. Desired product behavior

Build one coherent **Agent Chat** experience that allows the user to:

- Select a target from a real selector: **Management Team**, **Script AI**, **Image AI**, **Voice AI**, **Showrunner**.
- See each target’s actual status, provider, model, and health detail. Disabled/unavailable targets must remain visible with the reason and must not pretend to answer.
- Send a direct message to the selected target and receive that target’s actual model reply in the transcript.
- Keep a persistent room transcript in Supabase. Every message must record sender, recipient, timestamp, status, actual provider/model/latency where available, and any failure reason.
- Keep Manager chat conversational: subsequent manager turns must receive prior channel context and current project/store state, and the manager must be able to send explicit, persisted instructions/messages to other agents.
- Let the user explicitly trigger a production round where Script → Image → Voice → Showrunner each takes a real turn in the defined order. Report which agents actually answered, skipped, or failed.
- Clearly distinguish **direct chat** from **run production round**. Selecting an agent must not accidentally run all agents.
- Preserve existing season approval, store-write allow-list, human autonomy gate, auto-publish OFF default, worker registration, routing settings, and mobile-first design.

## 3. Backend implementation

### 3.1 Add a direct-agent message endpoint

Add a documented route in `apps/api/src/routes/agents.ts` and register it in `apps/api/src/index.ts`, for example:

`POST /api/agents/rooms/:id/message`

Request body should validate:
- `to_agent`: one of the canonical `AgentKind` values from `@ostra/shared` (manager, script, image, voice, overseer).
- `content`: non-empty, trimmed string with a safe maximum length (use the existing 8,000-character convention).
- Optional supported context fields only; never accept a client-supplied provider URL, secret, or arbitrary model endpoint.

Behavior:
1. Validate the room exists and is a `studio` room.
2. Persist the director’s message addressed to the selected agent **before** calling any model.
3. Resolve the selected agent’s backend using the existing `resolveChannelBackend` and current routing/health policy.
4. Call the real agent using the existing `runAgentTurn` / `callAgent` / `agentChannel.ts` abstractions. Reuse the shared prompt builder and action allow-list; do not create a parallel fake implementation.
5. Ensure the selected agent sees the user’s actual message as a director note/context, not merely the generic “it is your turn” instruction. If the current prompt builder cannot represent that cleanly, extend it explicitly and test it.
6. Persist the selected agent’s actual reply and any explicit peer-directed messages, with real backend metadata and status.
7. Apply store writes only through the existing `applyStoreActions` allow-list. Preserve audit events and prohibit destructive operations.
8. Return the persisted transcript, selected agent’s turn result, updated roster, and real errors.
9. If the target is offline or the provider fails, return an honest 4xx/5xx response with a stable error code and explanation. Do not manufacture an assistant row or success message.
10. If the selected target is `manager`, use the same actual manager execution path and autonomy restrictions as the existing Management Team handler. Do not silently bypass the autonomy gate for worker starts.

Review existing `manageRoom` and `dispatchRound` implementations before designing the endpoint. Reuse their persistence logic rather than duplicating it.

### 3.2 Make manager-to-agent coordination real and traceable

- Verify that a manager model output can create explicit peer messages through the existing agent protocol.
- Verify those messages are persisted in `agent_messages` with correct `from_agent`, `to_agent`, `kind`, and status.
- Verify the receiving agent sees those messages in its context on its real next turn.
- Verify the manager receives actual results from agents on later turns and reports the outcome to the director.
- Do not mark messages delivered merely because they were inserted. Delivery must reflect a real target-agent call.
- Keep runtime-start requests behind the existing `managerAutonomy()` gate and supervisor checks.
- If manager currently just writes instructions but never schedules/runs recipients, make that gap explicit in the result and implement a controlled handoff/round mechanism. Do not imply that an agent is working just because a message was queued.

### 3.3 Provider and worker routing truth

- Reuse the current provider registry/routing controls. Do not hardcode NVIDIA for every role.
- A role may use NVIDIA NIM when configured, or a genuinely online registered worker (Kaggle notebook) according to the current routing policy.
- Check worker endpoint health/heartbeat and capability before sending a task to it.
- If all roles are currently mapped to the same NVIDIA model, show: “Shared model, role-specific instructions” rather than implying independent models.
- In the UI, distinguish the agent’s **role** from the actual **provider/model/worker** answering it.
- Do not claim the two Kaggle notebooks are connected unless each has a registered, healthy endpoint and a successful real request has been verified.
- Never leak full worker endpoints or secrets to browser code; show host/provider metadata only.

## 4. Frontend implementation

### 4.1 Agent Chat page

Modify `apps/web/src/app/chat/page.tsx` or create a shared chat component used by both `/chat` and `/management`:

- Add an obvious **“Chat with”** selector for the five real roles.
- Populate status from `GET /api/agents/roster`; do not hardcode status as online.
- Preserve existing room selection, transcript, project binding, live store panel, auto-work control, and stop behavior.
- When a user selects a role, send to that role using the new direct-agent endpoint; do not always call `POST /api/chat/rooms/:id/messages` (that route is currently Script-AI-specific).
- Show the recipient label on the human message and the actual responding role on the reply.
- Display provider/model and latency from the actual response.
- Disable send only when appropriate (empty content, missing room, or an in-flight turn); if target is offline, explain why and allow selection of another role.
- Ensure the mobile layout remains usable on Android: selector and composer should not overflow horizontally.

### 4.2 Management page

Modify `apps/web/src/app/management/page.tsx` so that it functions as a true manager conversation, not only a brief-submission form:

- Keep the existing management status/policy card and autonomy controls.
- Make the manager transcript and message composer clearly conversational and persistent.
- Add a visible “Talk to Management Team” target or reuse the shared selector.
- Keep “Run production round” as a separate explicit action.
- Show API failure messages directly in the conversation area and never show the green success state if the manager call failed.
- If no room exists, create one and then send the message without a stale empty `roomId` race.
- Ensure send controls work with Enter / Shift+Enter consistently on mobile and desktop.
- Avoid having two pages that appear to chat with the same agent but route to different backends without explaining that distinction.

### 4.3 Honest activity and status display

For each transcript event show:
- sender → recipient;
- message kind (director message, handoff, position/report, failure);
- sent/delivered/failed status;
- real model/provider and latency when available;
- actual failure detail when not successful.

Avoid showing every agent as “ONLINE” solely because the same hosted NVIDIA fallback is reachable if the intent is to represent independent worker availability. If both role backend availability and worker runtime health matter, display them as separate statuses.

## 5. Tests required

Add/update unit/integration tests covering:

1. Selector roster comes from backend data and includes all canonical roles.
2. Sending a direct message to `manager` calls the real manager path and returns its actual response.
3. Sending to `script`, `image`, `voice`, and `overseer` targets the selected role, not always Script AI or manager.
4. Invalid target / empty message / overlong message is rejected.
5. Offline selected target returns an honest failure and does not fabricate an assistant reply.
6. Model transport failure persists the director’s message but does not create a fake assistant response.
7. Manager-to-agent peer messages are persisted and delivered only after a real receiving-agent call.
8. A production round runs only when explicitly requested and reports per-agent outcomes.
9. Provider/model metadata in the transcript matches the actual responder.
10. Existing autonomy restrictions, no-delete action allow-list, season approval gate, and auto-publish OFF behavior remain unchanged.
11. Existing `/api/chat` Script-AI route continues working for backward compatibility.
12. Mobile selector/composer build and TypeScript types remain valid.

Run the full repository checks, not just the new tests:
- `bun test`
- `bun --filter @ostra/web typecheck`
- `bun --filter @ostra/web lint`
- `bun --filter @ostra/api build`

Fix any new failures. Report any pre-existing failures separately.

## 6. Live verification (required before calling it done)

After implementation and deployment:

1. Check `GET https://ostra-studio-1.onrender.com/api/health`.
2. Check `GET https://ostra-studio-1.onrender.com/api/agents/roster` and `/api/agents/management`.
3. From the live UI, send a harmless test question to the manager and then to Script AI. Confirm each response’s backend metadata and transcript persistence.
4. Test an Image AI or Voice AI direct message and verify it is routed to the selected role.
5. Run a production round once and confirm per-agent results, including failures/skips.
6. Confirm no fabricated responses and no secret/full endpoint leakage.
7. Verify the deployed Vercel UI is built from the commit containing the changes and that the Render API is running the matching backend commit.
8. If Kaggle is not registered/healthy, state that clearly; do not mark the Kaggle workers online by inference.

Do not claim live verification if only unit tests or static HTML were checked.

## 7. Files likely involved

Inspect the latest versions before editing:
- `apps/web/src/app/chat/page.tsx`
- `apps/web/src/app/management/page.tsx`
- `apps/web/src/lib/agents.ts`
- `apps/web/src/lib/chat.ts`
- `apps/web/src/lib/api.ts`
- `apps/api/src/routes/agents.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/lib/agentChannel.ts`
- `apps/api/src/lib/agentRuntime.ts`
- `apps/api/src/index.ts`
- `packages/shared/src/agent/agents.ts`
- `packages/shared/src/agent/protocol.ts`
- relevant tests, docs, and Supabase migrations only if the existing schema cannot support the required behavior.

Do not add a new database table if the existing `chat_rooms` / `agent_messages` structure can support this task.

## 8. Task and handoff discipline

- Create/update a task file under `tasks/` for any follow-up work discovered.
- On completion, create a new detailed handoff file under `handoffs/` for the next agent.
- Handoff must include: exact commit SHA, changed files, commands run and results, live endpoints tested, deployed commit IDs, what remains incomplete, and exact next steps.
- Update `README.md` and `docs/API_ENV.md` to document the actual endpoint and UI behavior.
- Do not mark this task complete until the direct agent selector, manager chat, and agent-to-agent handoff flow have all been exercised against the deployed services.

## 9. Definition of done

The user can open the site on Android, choose Management Team or any other agent, send a message, see a real response from the selected agent, see the real provider/model/worker that answered, and observe persisted manager-to-agent handoffs. A round is only run when explicitly requested. Offline workers or exhausted provider quotas produce clear errors rather than fake progress.
