# HANDOFF — AI Studio: agent-to-agent channel, Showrunner, Kaggle agent notebooks

Date: 2026-09-30
Branch: `main`

## 1. Task

The director asked for three things (verbatim intent):

1. Make sure all changes are pushed to GitHub.
2. Move the other AI agents onto Kaggle — "create new notebook for the other agents".
3. Create a chat room where the agents talk to **each other** (Script AI telling Image AI to adjust a
   character's look/face; Image AI telling Voice AI to make audio line up with each scene), and decide
   whether to add one more AI that oversees everything and reports back to the director.

"you are free to make improvement and adjustments".

## 2. Result

All three are implemented, typechecked, unit-tested, and the new DB table is applied to live Supabase.

- **Pushed.** The pending Render-start-command hardening was committed and pushed as `5ae53a8`
  (`main` level with `origin/main` at handover time).
- **Kaggle agent notebooks created.** Three private kernels now exist:
  `bettertrade/ostra-image-agent`, `bettertrade/ostra-voice-agent`, `bettertrade/ostra-overseer-agent`
  (HTTP 200 from the real Kaggle push API). They are generated from repo sources by
  `scripts/kaggle-agent-notebook.ts`.
- **Agent-to-agent channel shipped.** Migration `007` adds `chat_rooms.kind` and the `agent_messages`
  table; `POST /api/agents/rooms/:id/dispatch` runs one bounded production round
  (Script → Image → Voice → Showrunner). New page `/studio`.
- **Overseer added ("Showrunner").** It is a role, not a new provider slot: it prefers a dedicated
  `overseer` worker and falls back to the Script AI worker. It reports the true status to the director.

Nothing is fabricated: an agent is only called when genuinely ONLINE; only messages a model actually
emitted are stored; an offline agent's inbox stays `sent`; failed calls record the real error.

## 3. Repository state

- Branch `main`. `git status` clean except the files listed in §4 (this handover + the docs/code above
  were committed together).
- The Render API cannot be redeployed from this workspace — the operator must redeploy `main` on Render
  for `/api/agents/*` and migration-dependent behaviour to go live (see §9).

## 4. Files changed

New:
- `packages/shared/src/agent/agents.ts` — the agent roster (script/image/voice/overseer), channel
  rendering (`renderChannelTranscript`, `inboxFor`) and the per-agent channel prompt
  (`buildAgentChannelPrompt`).
- `packages/shared/src/agent/agents.test.ts` — roster/channel/prompt tests.
- `supabase/migrations/007_agent_channel.sql` — `chat_rooms.kind` + `agent_messages`.
- `apps/api/src/lib/agentChannel.ts` — round orchestration: `loadChannel`, `insertChannelMessage`,
  `runAgentTurn`, `runProductionRound`.
- `apps/api/src/routes/agents.ts` — roster/rooms/messages/dispatch routes.
- `apps/web/src/lib/agents.ts` (+ `agents.test.ts`) — client + pure helpers.
- `apps/web/src/app/studio/page.tsx` — the AI Studio production channel UI.
- `scripts/kaggle-agent-bootstrap.py` — the generic, identity-parameterized agent bootstrap.
- `scripts/kaggle-agent-notebook.ts` (+ `.test.ts`) — builds/pushes the agent notebooks.
- `handoffs/HANDOFF-2026-09-30-multi-agent-studio.md` — this file.

Modified:
- `packages/shared/src/agent/protocol.ts` — `AgentReply.messages`, `AGENT_MESSAGE_KINDS`,
  `AGENT_PARTICIPANTS`, `normalizeOutboundMessages`, envelope accepts a messages-only answer;
  `protocol.test.ts` gained a "agent-to-agent messages" block.
- `packages/shared/src/index.ts` — exports `./agent/agents`.
- `apps/api/src/lib/agentRuntime.ts` — `resolveAgentBackendFor(supa, types[], {label})`,
  `resolveAgentBackend` (script wrapper), `resolveChannelBackend(supa, agent)` (overseer fallback).
- `apps/api/src/routes/registration.ts` — allows worker type `overseer`.
- `apps/api/src/index.ts` — registers the six `/api/agents/*` routes.
- `apps/web/src/components/TopNav.tsx` — adds the "AI Studio" nav item.
- `README.md`, `AGENT_CONTRACTS.md`, `docs/API_ENV.md` — documentation.

## 5. Tests/checks

Actually run, with real results:

- `bun test` → **265 pass / 0 fail** across 19 files (was 238/16; +agents/agents.test.ts,
  +kaggle-agent-notebook.test.ts, +apps/web/src/lib/agents.test.ts, +4 protocol channel cases).
- `npm run typecheck` (`bun --filter @ostra/web typecheck && bun --filter @ostra/api build`) → both exit 0.
- `node scripts/apply-migration.mjs supabase/migrations/007_agent_channel.sql` → `CONNECTED OK`,
  `APPLIED OK`, `DONE`.
- `node scripts/verify-supabase.mjs` → `TABLES …,agent_messages,…`, `missing: none`, `total tables: 17`.
- `bun scripts/kaggle-agent-notebook.ts --agent=image --agent=voice --agent=overseer` → dry run, 6 cells
  each, ~17.6 KB of notebook source.
- `bun scripts/kaggle-agent-notebook.ts --agent=image --agent=voice --agent=overseer --apply` →
  three HTTP 200 pushes (`versionNumber` 1 / 1 / 0).

## 6. Integration status

- **Supabase** — connected + verified (migration applied; table present).
- **Kaggle (agent notebooks)** — created/verified at the API level (HTTP 200, kernel URLs returned).
  Whether each notebook **runs and registers** is UNVERIFIED (not observed).
- **Kaggle (Script AI worker)** — unavailable all session (its ngrok tunnel was offline); unchanged.
- **Render API** — the new routes exist only in the repo; NOT live until the operator redeploys
  (previous deploy failed with exit 127 — see the Render handover).
- **Hosted fallback** — not attempted (`OPENAI_API_KEY` unset).
- **Live model / channel end-to-end** — NOT verified (no agent was ONLINE during this task).

## 7. Known issues

- **Render not redeployed** → `/studio` will show `HTTP 404` / a clear error until Render is updated.
  This is the same blocker as the previous handover; the Start Command must be
  `bun --filter @ostra/api start` in the Render dashboard.
- **ngrok free tier allows one simultaneous tunnel.** Three agent notebooks running at once will fight
  over it; run one agent at a time (or upgrade ngrok). The Script AI notebook has the same limit.
- **The new agent notebooks are unverified at runtime.** They download `Qwen/Qwen3-1.7B` and start a
  FastAPI server. If the model fails to load, the notebook does not register — honestly.
- **`AGENT_MAX_TOKENS=900`** remains low for a 4-agent round (each turn must emit a JSON envelope);
  a long-thinking model can exhaust the budget. Consider raising it on Render.
- The Showrunner shares the Script AI worker's model when no dedicated `overseer` worker is ONLINE, so
  its "oversight" is a different prompt on the same small model, not a stronger critic.
- `apps/api/src/lib/agentChannel.ts` does one DB read of the store + channel per agent turn; fine at this
  scale but not optimised.

## 8. Decisions

- **Mediated channel, not model-to-model.** Per `CONSTRAINTS.md` #17 and `AGENT_CONTRACTS.md`, every
  peer message is persisted by the orchestrator and every store write goes through the additive
  allow-list. The channel is a table (`agent_messages`), not a side channel.
- **Overseer is a role, not a ProviderId.** Adding a new `ProviderId` would ripple through
  `providerHealth`/`registry`/`models`. Instead the Showrunner resolves `[overseer, script]` and always
  reports which worker answered. Worker type `overseer` was added to registration so a dedicated
  notebook is possible later.
- **Rounds are bounded.** Each agent runs at most once per dispatch; the director presses run again to
  continue. This prevents a chatty model from looping.
- **Agent notebooks are generated from the repo** rather than edited by hand, so `--apply` is an
  idempotent refresh.
- **Envelope extended, parser kept tolerant.** `messages` is parsed by the same `parseAgentResponse`;
  a messages-only envelope is valid; unknown recipients / empty text are dropped silently.

## 9. Environment/configuration

- **No new environment variables.** The channel uses the existing `SUPABASE_*`, `OPENAI_*`, worker
  registration and `AGENT_*` keys.
- **Migration required:** run `supabase/migrations/007_agent_channel.sql` on any environment that does
  not have it (already applied to the shared Supabase).
- **Render:** redeploy `main` with Start Command `bun --filter @ostra/api start` (see
  `HANDOFF-2026-09-30-render-start-command.md`).
- **Kaggle secrets** for the new notebooks: `NGROK_AUTHTOKEN` (required for the tunnel) and, if Render
  sets it, `WORKER_REGISTRATION_TOKEN`. Optional: `OSTRA_API_URL`, `OSTRA_KEEPALIVE_MINUTES` (default 10).
  Secrets are per Kaggle account, so they are shared with the Script AI notebook.

## 10. Next agent

Redeploy the Render API, then **verify the channel end-to-end**: start one agent notebook from
`/runner` (or manually on Kaggle), confirm it registers as worker type `image`/`voice`/`overseer`, open
`/studio`, create a channel bound to a project, and run a round. Confirm that a real message is written
to `agent_messages`, that a Script AI peer request is delivered to Image AI, and that the Showrunner
reports the true status. Report any turn that fails with its real reason.

## 11. Do not redo

- Do not re-apply migration `007` if `verify-supabase.mjs` lists `agent_messages`.
- Do not re-create the three Kaggle kernels by hand; `bun scripts/kaggle-agent-notebook.ts --apply`
  refreshes them idempotently.
- Do not add `messages` handling in a second place — `parseAgentResponse` already owns it.
- Do not introduce a new `ProviderId` for the overseer.

## 12. Verification

Unverified and must be stated as such:

- No agent was ONLINE, so **no** round has been executed against a live model; the entire model-facing
  path (channel prompt → call → parse → persist) is covered by unit tests only, not a live call.
- The three new Kaggle notebooks have not been run; whether they load the model, tunnel and register is
  unknown.
- The `/studio` page has not been rendered against a live Render API (the routes are not deployed yet).
- `chat_rooms.kind` / `agent_messages` existence is confirmed by `verify-supabase.mjs`; no ad-hoc row
  reads were performed from this workspace.
