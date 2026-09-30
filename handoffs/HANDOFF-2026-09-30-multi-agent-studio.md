# HANDOFF — AI Studio: agent-to-agent channel, Showrunner, Kaggle agent notebooks

Date: 2026-09-30
Branch: `main`

## 1. Task

The director asked for three things:

1. Make sure all changes are pushed to GitHub.
2. Move the other AI agents onto Kaggle — "create new notebook for the other agents".
3. Create a chat room where the agents talk to **each other** (Script AI telling Image AI to adjust a
   character's look/face; Image AI telling Voice AI to make audio line up with each scene), and decide
   whether to add one more AI that oversees everything and reports back to the director.

Then, after seeing the notebooks pushed: **"test all the new ai agent you added and make sure all of
them are responding for ngrok"** — the director will supply ngrok tokens.

## 2. Result

Implemented, typechecked, unit-tested, applied to live Supabase, and **live-tested against real Kaggle
runs**.

- **Pushed** (`5ae53a8` Render-start hardening, then `c77b6d8` this feature).
- **Three agent Kaggle notebooks created and verified running:**
  `bettertrade/ostra-image-agent`, `bettertrade/ostra-voice-agent`,
  `bettertrade/ostra-showrunner-agent`. Each real run: installs deps → loads `Qwen/Qwen3-1.7B` → serves
  `/health` HTTP 200 → registers + heartbeats. Verified in the worker registry: `image`, `voice` and
  `overseer` all reached **ONLINE** with fresh heartbeats.
- **Channel shipped.** Migration `007` (`chat_rooms.kind` + `agent_messages`) and
  `POST /api/agents/rooms/:id/dispatch` run a bounded round (Script → Image → Voice → Showrunner).
  New page `/studio`.
- **Showrunner added** as a role (prefers an `overseer` worker, falls back to the Script AI worker).

**What is still missing to be reachable:** no ngrok token is set in the Kaggle account, so each agent
registers with **no endpoint**. The tested failure is exact:
`[ostra] ngrok tunnel FAILED (RuntimeError: no ngrok token: set the Kaggle secret NGROK_AUTHTOKEN_IMAGE (or NGROK_AUTHTOKEN))`.
Adding the tokens turns these ONLINE-and-reachable.

## 3. Repository state

- Branch `main`; the feature commit is pushed. Migration `007` **and `008`** are applied to the shared
  Supabase.
- The Render API is **not** redeployed: `/api/agents/*` is not live there (the deploy still fails at the
  start step — see `HANDOFF-2026-09-30-render-start-command.md`). The operator must fix the Render
  Start Command and redeploy.

## 4. Files changed

New:
- `packages/shared/src/agent/agents.ts` (+ test) — roster, channel rendering, per-agent channel prompt.
- `supabase/migrations/007_agent_channel.sql` — `chat_rooms.kind` + `agent_messages`.
- `supabase/migrations/008_overseer_worker_type.sql` — allow `overseer` in `workers_type_check`.
- `apps/api/src/lib/agentChannel.ts` — round orchestration.
- `apps/api/src/routes/agents.ts` — roster/rooms/messages/dispatch.
- `apps/web/src/lib/agents.ts` (+ test) — client + helpers.
- `apps/web/src/app/studio/page.tsx` — AI Studio UI.
- `scripts/kaggle-agent-bootstrap.py` — generic identity-parameterized bootstrap.
- `scripts/kaggle-agent-notebook.ts` (+ test) — builds/pushes agent notebooks (`--agent`, `--apply`,
  `--dump`, `--list`, `--slug=`, `--owner=`, `--kernel-ref=`).
- `handoffs/HANDOFF-2026-09-30-multi-agent-studio.md` — this file.

Modified:
- `packages/shared/src/agent/protocol.ts` (+ test) — `AgentReply.messages`, message parsing.
- `packages/shared/src/index.ts` — export `./agent/agents`.
- `apps/api/src/lib/agentRuntime.ts` — `resolveAgentBackendFor` / `resolveChannelBackend`.
- `apps/api/src/routes/registration.ts` — accept worker type `overseer`.
- `apps/api/src/index.ts` — register `/api/agents/*`.
- `apps/web/src/components/TopNav.tsx` — "AI Studio" nav item.
- `scripts/kaggle-live-check.ts` — **bug fix:** `--kernel-ref=` now overrides `KAGGLE_KERNEL_REF`
  (it was silently ignored whenever the env var was set); new `--raw` flag prints the whole run log.
- `README.md`, `AGENT_CONTRACTS.md`, `docs/API_ENV.md`.

## 5. Tests/checks

Actually run, with real results:

- `bun test` → **267 pass / 0 fail** across 19 files.
- `npm run typecheck` → web + api both exit 0. `bun run lint` → exit 0 (pre-existing warnings only).
- `node scripts/apply-migration.mjs …007…` and `…008…` → `APPLIED OK` each.
- `node scripts/verify-supabase.mjs` → `agent_messages` present, 17 tables, `missing: none`.
- `bun scripts/kaggle-agent-notebook.ts --agent=image --agent=voice --agent=overseer --apply` →
  HTTP 200; later `--list` shows all three kernels with real `lastRunTime`.
- `bun scripts/kaggle-live-check.ts --kernel-ref=bettertrade/ostra-{image,voice,showrunner}-agent --logs`
  → read each run's real stdout.
- `GET https://ostra-studio-1.onrender.com/api/workers` → `image`, `voice`, `overseer` recorded ONLINE
  with fresh heartbeats and `NO-ENDPOINT`.

## 6. Integration status

- **Supabase** — connected + verified (migrations 007/008 applied; `agent_messages` present).
- **Kaggle (agent notebooks)** — **verified running**: model loaded, `/health` 200, worker registered.
  Endpoint reachability NOT verified (no ngrok token).
- **Kaggle (Script AI)** — its last run (05:30) registered successfully; currently OFFLINE.
- **ngrok** — unavailable: no token in Kaggle secrets, so no public URL for any agent notebook.
  The Script notebook's own tunnel (`oversleep-gift-bonfire.ngrok-free.dev`) was from an earlier run.
- **Render API** — new routes not deployed; operator action required.
- **Live channel round** — NOT executed (no agent is reachable without a tunnel).

## 7. Known issues

- **No ngrok token in Kaggle secrets** → every agent notebook registers with no endpoint, so
  `resolveChannelBackend` skips it (it requires a non-empty endpoint). This is the remaining blocker.
- **ngrok free plan = one tunnel per account.** Running several agents together needs a token per agent
  from separate ngrok accounts; the generator already reads `NGROK_AUTHTOKEN_<AGENT>` first.
- **Kaggle concurrent-session limit.** A kernel push while another run is active returns HTTP 200 with
  `versionNumber: 0` and creates a hidden draft instead of a runnable kernel. Retry when no other run is
  active — that is exactly how `ostra-showrunner-agent` eventually created (v1) after image/voice ended.
  Two orphaned `[Private Notebook]` drafts exist for the earlier `ostra-overseer-agent` attempts; Kaggle
  has no delete-kernel API, so they were left alone.
- **The `overseer` slug rename:** the working kernel is `ostra-showrunner-agent` (title "Ostra Showrunner
  agent"); `ostra-overseer-agent` never materialized.
- **Notebooks run the same small model for every role.** The role comes from the prompt, so Image/Voice
  AI are art/audio *directors* that reason in text; their actual image/TTS pipelines are still separate.
- **Render start command** still must be fixed by the operator.
- **`AGENT_MAX_TOKENS=900`** is tight for a 4-agent round; consider raising it on Render.

## 8. Decisions

- **Mediated channel, not model-to-model** (`CONSTRAINTS.md` #17): every peer message is persisted and
  every store write uses the additive allow-list.
- **Overseer is a role, not a `ProviderId`** — avoids rippling through provider health/registry; a
  dedicated `overseer` worker is preferred when present.
- **Rounds are bounded** (each agent once per dispatch).
- **Notebooks are generated from the repo** so `--apply` is an idempotent refresh; identity is a single
  substituted `OSTRA_AGENT` line.
- **Per-agent ngrok secret names** (`NGROK_AUTHTOKEN_<AGENT>` → `NGROK_AUTHTOKEN`) so separate ngrok
  accounts work from one Kaggle account.
- **Migration 008 widens, never narrows**, the worker-type constraint.

## 9. Environment/configuration

- **Migrations required:** `007_agent_channel.sql` and `008_overseer_worker_type.sql` (both applied here;
  run them on any other environment).
- **Kaggle secrets** (Kaggle → Add-ons → Secrets, per Kaggle account — NOT the Render/Vercel/Freebuff
  env): `NGROK_AUTHTOKEN_IMAGE`, `NGROK_AUTHTOKEN_VOICE`, `NGROK_AUTHTOKEN_OVERSEER` (one per ngrok
  account), or a shared `NGROK_AUTHTOKEN`; plus `WORKER_REGISTRATION_TOKEN` only if Render sets it.
  Optional: `OSTRA_API_URL`, `OSTRA_KEEPALIVE_MINUTES`.
- **No new Render/Vercel env vars.** Render must be redeployed with Start Command
  `bun --filter @ostra/api start`.

## 10. Next agent

1. Operator: fix the Render Start Command and redeploy (so `/api/agents/*` is live).
2. Operator: add the per-agent ngrok tokens as **Kaggle secrets**, then re-push the notebooks
   (`bun scripts/kaggle-agent-notebook.ts --agent=image --agent=voice --agent=overseer --apply`) or press
   Run in Kaggle.
3. Then verify the full loop: agents register **with** endpoints, open `/studio`, run a round, and confirm
   a Script AI peer request is delivered to Image AI and the Showrunner reports the real status.

## 11. Do not redo

- Do not re-apply migrations `007`/`008` if `verify-supabase.mjs` lists `agent_messages` and `overseer`
  registrations succeed.
- Do not re-create the kernels by hand; `--apply` refreshes them. Note the Showrunner kernel is
  `ostra-showrunner-agent`.
- Do not add `messages` parsing in a second place; `parseAgentResponse` owns it.
- Do not re-fix the `--kernel-ref` precedence bug in `kaggle-live-check.ts` — it is fixed.
- Do not give the notebooks a unique `ngrok` account token expectation beyond
  `NGROK_AUTHTOKEN_<AGENT>` → `NGROK_AUTHTOKEN`.

## 12. Verification

Verified live: all three agent notebooks run, load the model, serve `/health` 200, and register/heartbeat
(the `overseer` registration was proven only after migration 008). Stated unverified:

- **No agent is reachable** — none has a public endpoint (no ngrok token), so no channel round against a
  live model has been executed; the model-facing prompt→call→parse→persist path is unit-tested only.
- The `/studio` page has not been rendered against a live Render API (routes not deployed).
- The image/audio **production** work (actual image generation, TTS) is not implemented in these
  notebooks; they are the agents' reasoning/direction layer.
