# HANDOFF — AI Studio: agent-to-agent channel, Showrunner, Kaggle agent notebooks

Date: 2026-09-30
Branch: `main`

## Addendum (2026-09-30, later): multi-account Kaggle tokens + live probe results

The workspace env now holds TWO Kaggle API tokens (`KAGGLE_API_TOKEN_1`, `KAGGLE_API_TOKEN_2`; the old
single `KAGGLE_API_TOKEN` name was replaced). Support added (all verified: 276 tests, typecheck, lint):

- `packages/shared/src/lib/env.ts` — new `kaggleApiTokens()`: plain `KAGGLE_API_TOKEN` first, then
  `KAGGLE_API_TOKEN_<n>` in numeric order, then other suffixed names; blank values skipped, duplicates
  merged. `kaggleConfig()` falls back to the first numbered token, so the deployed Script path keeps
  working with either naming scheme. `redactSecrets()` scrubs every `KAGGLE_API_TOKEN*` key.
- `scripts/kaggle-agent-notebook.ts` — `--list [--token=<n>|all]`, `--whoami` (per-token identity),
  `--token=<n>` to pin one agent to one account, `--agent=all` mapping agent #i → token #(i+1).
  Before every push the script probes the token's REAL account (kernels → datasets → models list) and
  REFUSES an owner mismatch instead of pushing into the wrong account. `probeAccount` is unit-tested
  with mocked fetch (identified / valid-but-empty / 401 / datasets-fallback). A valid token whose
  account owns nothing reports `authenticated:true, owner:null`; pushing there needs an explicit
  `--owner=<account>` (Kaggle arbitrates a wrong account with a real 403). Verified live: Kaggle
  rejects an ownerless slug (`Invalid slug`), so the second account's name cannot be discovered.
- `kaggleConfig()` consumers updated: `kaggle-live-check.ts`, `kaggle-sync-notebook.ts`,
  `env-check.mjs`, `KaggleRuntimeStarter` (via `kaggleConfig()` instead of the raw env name).
  Render still configures the plain `KAGGLE_API_TOKEN` name — production is unaffected.

**Live probe findings (read-only, 2026-09-30 ~18:25Z):**
- Token #1 = account `bettertrade`; kernels there: `ostra-showrunner-agent`, `ostra-voice-agent`,
  `ostra-image-agent` (all last ran ~07:28–07:50Z), `ostra-ai-server`, `notebook7eae283a4a`
  (Script AI, ran 08:00Z), plus the known orphaned `[Private Notebook]` draft.
- Token #2 = a VALID second Kaggle account (Kaggle answers 200 where a garbage token gets 401 —
  verified) that owns no kernels, datasets or models; its username is not listable and pull of a
  bettertrade private kernel fails with this token, so it is a DIFFERENT account. Its name must come
  from the user before notebooks can be pushed under it.
- Render is back UP (`/health` ok, Start Command fixed operator-side) and `/api/agents/roster` is live.
  All four workers show OFFLINE with `endpoint=null` (or stale script endpoint) — the honest state
  after the Kaggle keepalive windows ended; registration worked earlier, reachability still awaits
  ngrok secrets.

**Still blocking agent reachability (unchanged):** Kaggle has no API for user secrets, so the ngrok
authtokens must be entered by hand in Kaggle (Add-ons → Secrets) on the account whose notebooks should
tunnel: `NGROK_AUTHTOKEN_IMAGE`, `NGROK_AUTHTOKEN_VOICE`, `NGROK_AUTHTOKEN_OVERSEER` (each from a
different ngrok account — free plan allows one tunnel), or one shared `NGROK_AUTHTOKEN`. Once they are
in, `bun scripts/kaggle-agent-notebook.ts --agent=<agent> --apply` (or `--agent=all`) triggers fresh
runs that tunnel, register WITH endpoints, and turn the roster ONLINE.

## Addendum 2 (2026-09-30, evening): token #2 identified; multi-account push live

The user named the four accounts: **gridder store**, **Emmanuel ofoye**, **kids city**, **scale hive**.
All four exist as Kaggle profiles with the slugs `gridderstore`, `emmanuelofoye`, `kidscity`,
`scalehive` (display names differ from slugs; `bettertrade`'s display name is "Better Trade" so it is
NOT "gridder store"). Only two tokens are configured, so the identity was resolved EMPIRICALLY:

- **Token #1 = `bettertrade`** (probe + private-kernel pull).
- **Token #2 = `kidscity`** — proven by a real push: targeting `--owner=gridderstore` returned
  `url=https://www.kaggle.com/code/kidscity/ostra-image-agent` (v1 created). After that push the
  account owns kernels and `probeAccount` identifies it normally.

**Two Kaggle API behaviours discovered (verified live, worth remembering):**
1. `POST /kernels/push` silently IGNORES a foreign owner in the slug for personal accounts — a push
   with any owner always lands on the TOKEN's own account (HTTP 200). You cannot create kernels on an
   account whose API token you do not hold. So `emmanuelofoye` / `gridderstore` / `scalehive` can only
   host agents once the user adds their tokens (`KAGGLE_API_TOKEN_3`, `_4`, …).
2. On kernel CREATE, Kaggle derives the slug from `newTitle` and ignores the requested slug:
   `--agent=overseer` (title "Ostra Showrunner agent") was created as `kidscity/ostra-showrunner-agent`
   even though the slug said `ostra-overseer-agent`. (This retroactively explains the historical
   "overseer slug never materialized" mystery on bettertrade.) Updates to an EXISTING kernel keep its
   slug, so version bumps are unaffected.

**Current agent → account distribution (all pushed this session):**
- `bettertrade/ostra-voice-agent` v3 (token #1)
- `kidscity/ostra-image-agent` v1 (token #2)
- `kidscity/ostra-showrunner-agent` v1 (token #2)
- `bettertrade/notebook7eae283a4a` — Script AI (operator-managed)
- The stale `bettertrade/ostra-image-agent` + `ostra-showrunner-agent` kernels still exist but are no
  longer the ones being used; prefer the kidscity copies so ngrok secrets can be split per account.

To push to the remaining named accounts, ask the user to add each account's API token to the env as
`KAGGLE_API_TOKEN_3` (Emmanuel ofoye = `emmanuelofoye`), `_4` (`gridderstore`), `_5` (`scalehive`) —
then `bun scripts/kaggle-agent-notebook.ts --agent=<agent> --token=<n> --owner=<slug> --apply`.

## Addendum 3 (2026-10-01): token #3 = scalehive; Image AI moved; one shared ngrok token

**Token slot numbers do NOT track the user's account order — always verify.** Addendum 2 guessed
`_3` = emmanuelofoye; in reality the single new key the user added (`KAGGLE_API_TOKEN_3`) belongs to
**`scalehive`**. `--whoami` showed it valid-but-empty (owner not listable), so the identity was proven
the same way as kidscity: a push with explicit `--owner=` landed at
`url=https://www.kaggle.com/code/scalehive/ostra-image-agent` (v1 created, private, internet+GPU on).

**Distribution now (supersedes Addendum 2's note):**
- `bettertrade/ostra-voice-agent` v3 (token #1)
- `scalehive/ostra-image-agent` v1 (token #3) — supersedes the kidscity copy
- `kidscity/ostra-showrunner-agent` v1 (token #2) — kidscity still cannot run (pip had no internet;
  near-certain cause: the account is not phone-verified)
- `bettertrade/notebook7eae283a4a` — Script AI (operator-managed)
- Still MISSING: tokens for `emmanuelofoye` and `gridderstore` (user said "the other keys" but only
  one arrived). Add as `KAGGLE_API_TOKEN_4`/`_5`; verify each with `--whoami` before trusting the slot.

**ngrok: the user chose ONE shared token.** No code change needed — the tunnel cell already tries
`NGROK_AUTHTOKEN_<AGENT>` first and falls back to shared `NGROK_AUTHTOKEN`. Operationally: add the
SAME secret value under the name `NGROK_AUTHTOKEN` in Kaggle → Add-ons → Secrets on EVERY account
hosting a notebook (bettertrade + scalehive now). Free-plan caveat stands: one ngrok account = one
online tunnel at a time, so a single shared token means only ONE agent publicly reachable at a time;
simultaneous agents still need one free ngrok account per agent (per-agent secret names keep working).

**bettertrade voice run diagnosis (2026-09-30):** install OK, model server up, but the run had no
`NGROK_AUTHTOKEN_VOICE`/`NGROK_AUTHTOKEN` secret AND its register call to Render timed out
(read timeout=20 — likely Render cold-start). Re-run after adding the secret.

## Addendum 4 (2026-10-01): three verified accounts, model upgrade, benchmark notebook

**Operator update:** bettertrade, kidscity and emmanuelofoye are the verified/usable accounts
(emmanuelofoye is Colab-linked but has NO Kaggle API token yet). kidscity is now phone/verified, so its
earlier pip failure should not recur. scalehive (token #3) is NOT verified — its token sits unused in
env. A shared `NGROK_AUTHTOKEN` was added to the workspace env and to two Kaggle accounts.

**Recalculated distribution (two tokens until emmanuelofoye's arrives):**
- `bettertrade/notebook7eae283a4a` — Script AI (operator-managed)
- `bettertrade/ostra-voice-agent` v4 (token #1) — now model-selecting
- `kidscity/ostra-showrunner-agent` v2 (token #2) — updated in place with `--slug=ostra-showrunner-agent`
  (a create targeting `ostra-overseer-agent` 409'd on the title; updates keep slug+title, which is the
  reliable path for existing kernels)
- `bettertrade/ostra-model-benchmark` v1 — new benchmark notebook
- Image AI: WAITING for emmanuelofoye's Kaggle API token (add as `KAGGLE_API_TOKEN_4`; token #3
  scalehive can then be removed). A Colab link alone cannot push/refresh Kaggle notebooks.

**Model upgrade (no longer 1.7B-only):** agent notebooks now pick the strongest model the GPU can
serve — `OSTRA_MODEL` secret overrides → `OSTRA_MODEL_DEFAULT` (generator-injected pin) → VRAM rule
(≥15 GiB ⇒ `Qwen/Qwen3-4B`, else `Qwen/Qwen3-1.7B`). Roster default in
`packages/shared/src/agent/agents.ts` and the bootstrap profiles are now `Qwen/Qwen3-4B` (fits a free
T4: ~8 GB weights + KV cache, leaving headroom; 7–8B bf16 does NOT fit and would OOM before
tunnel/registration). The registration reports the model the run ACTUALLY booted, so the backend never
claims a model that isn't running.

**Benchmark notebook** (`scripts/kaggle-model-benchmark.ts`, one CLI, `--apply`/`--dump`/`--token=`/
`--model=`): candidates `Qwen3-4B-Instruct-2507`, `Qwen3-4B`, `Qwen3-1.7B`; measures real load time,
peak VRAM (`torch.cuda.max_memory_allocated`), tokens/s over a real `generate()` on the real GPU;
writes `ostra-model-benchmark.json` with a tok/s ranking + RECOMMENDED. No simulated numbers: a model
that fails to load is reported as failed with its real error. Results:
`bun scripts/kaggle-live-check.ts --kernel-ref=bettertrade/ostra-model-benchmark --logs`.

**ngrok single-token decision:** tunnel cell already falls back to shared `NGROK_AUTHTOKEN` (per-agent
names still win if present). Free plan = ONE online tunnel per ngrok account ⇒ with a single shared
token only ONE agent is publicly reachable at a time; run agents sequentially or stagger runs.

**Checks:** 282 tests / 0 fail (incl. new model-selection + benchmark tests; env-test sandboxes now
clear `KAGGLE_API_TOKEN_3..5`/`NGROK_AUTHTOKEN` so real env cannot leak into assertions), typecheck 0,
lint 0 (pre-existing warning only).

## Addendum 5 (2026-10-02): token #4 = gridderstore, NOT emmanuelofoye

The operator added a 4th key saying "check all of them for it eg #5". There is **no
`KAGGLE_API_TOKEN_5`** — the env holds exactly `_1.._4`, so the new key landed in `_4`. The full
`--whoami` (all identities now empirically proven) reads:

- **#1 = `bettertrade`** (probe + private pull)
- **#2 = `kidscity`** (probe)
- **#3 = `scalehive`** (probe; account unverified per operator — token unused)
- **#4 = `gridderstore`** (display name "Gridder Store") — NOT `emmanuelofoye`

The key the operator supplied as "Emmanuel ofoye's" authenticates as **`gridderstore`**.
`emmanuelofoye` is a real, separate Kaggle profile (page title "Emmanuel Ofoye | Kaggle"). Two
possible explanations: the token was generated while the Kaggle session was logged in as
`gridderstore`, or "gridderstore" IS the operator's handle for that person's business account —
only the operator can say. gridderstore is not on the operator's verified list (bettertrade,
kidscity, emmanuelofoye).

**Image AI push with token #4 landed at `gridderstore/ostra-image-agent` v1** (HTTP 200, private,
internet+GPU on, created 2026-10-02T08:53:43Z). The response URL was the identity reveal (Addendum 2
behaviour #1); since then `--list --token=4` reads `account: gridderstore` because the new kernel
made the previously-empty account listable. Image AI now exists as kidscity v1, scalehive v1 and
gridderstore v1 — none of them on emmanuelofoye.

**If emmanuelofoye is truly wanted:** regenerate the key while logged in as `emmanuelofoye`
(kaggle.com → Settings → API → Create New Token), add it to the env, re-run `--whoami` (the token
should read `account: emmanuelofoye`), then
`bun scripts/kaggle-agent-notebook.ts --agent=image --token=<n> --owner=emmanuelofoye --apply`.

**Operator confirmed (2026-10-02): token #4 is the WRONG account.** Treat `gridderstore` as not-one
of ours; its `ostra-image-agent` notebook stays private and unused. Next key the operator adds must
be verified by `--whoami` reading `account: emmanuelofoye` BEFORE any push — slot numbers have never
tracked account order (Addendum 3 lesson).

## Addendum 6 (2026-10-02, later): launch wiring audit; Script AI model upgrade; token #4 STILL missing

**The emmanuelofoye key did not persist.** The operator said they added it as #4, but the env now
holds exactly `_1` (bettertrade), `_2` (kidscity), `_3` (scalehive) — the gridderstore key was
deleted and NO `_4`/`_5` exists. The save in the Keys UI did not complete. Re-add the key, then
verify with `--whoami` before pushing Image AI.

**Wiring audit (launch-critical facts, all verified live):**
1. Render registration is OPEN — a heartbeat probe for an unregistered identity returned
   `404 worker not found` (not 401), so `WORKER_REGISTRATION_TOKEN` is NOT set on Render. Kaggle
   accounts therefore need NO registration secret; the ONLY required secret is `NGROK_AUTHTOKEN`.
   Optional launch hardening: set `WORKER_REGISTRATION_TOKEN` on Render and as a Kaggle secret on
   every hosting account.
2. Dispatch calls the worker's registered ngrok endpoint directly (apps/api/src/lib/agentRuntime.ts:
   fresh heartbeat + endpoint required) — no tunnel ⇒ registered but unreachable.
3. Live `/api/workers`: 4 workers registered, ALL OFFLINE with stale heartbeats (script + showrunner
   point at the dead `oversleep-gift-bonfire.ngrok-free.dev`; image/voice have no endpoint).
   Registrations upsert by (type, runtime, provider), so fresh runs refresh these same rows.
4. The Script AI notebook's own tunnel cell reads only shared `NGROK_AUTHTOKEN` (no per-agent name)
   — it competes with other agents for the single free-plan tunnel.

**Script AI model upgrade (drop-1.7B fleet-wide, COMPLETED):**
- `scripts/kaggle-sync-notebook.ts` now manages two more cells of `bettertrade/notebook7eae283a4a`:
  a VRAM-selecting model-load cell (OSTRA_MODEL secret → ≥15 GiB ⇒ Qwen3-4B else 1.7B) and the
  chat-server cell (reports `MODEL_ID` in /health and every completion — the operator's old cell
  hardcoded "Qwen/Qwen3-1.7B" in both). The managed smoke test now sends `MODEL_ID` too.
- BOTH bootstraps now report the model ACTUALLY booted. Agent bootstrap reporting chain is
  `globals().get("MODEL_ID") or _secret("OSTRA_MODEL") or _PROFILE["model"]` — the previous chain
  self-shadowed (the bootstrap defined `OSTRA_MODEL_DEFAULT = "Qwen/Qwen3-1.7B"` itself, so a T4
  booting 4B would have REGISTERED 1.7B). That line is removed; the pin belongs to the generator's
  server cell only. Script bootstrap reports `MODEL_ID` or `"unknown"`.
- New test pins the reporting chain; suite 283 pass / 0 fail.
- Pushed: `bettertrade/notebook7eae283a4a` **v16** (HTTP 200) — a run was auto-requested. Default
  keepalive is 10 min, so the worker goes OFFLINE after that unless `OSTRA_KEEPALIVE_MINUTES` is set
  (e.g. 480) as a Kaggle secret before launch day.

**FIRST FULLY-WIRED WORKER (2026-10-02 ~10:35Z):** the v16 run registered — `script-ai-kaggle`
ONLINE, fresh heartbeats, and its tunnel genuinely serves (`GET /health` → 200). Notable: the fresh
run's ngrok URL was the SAME stable subdomain as previous runs, so endpoints are apparently
persistent, not per-run random. The run served `Qwen/Qwen3-1.7B` because it got NO GPU (metadata
`enableGpu: true` is set; almost certainly Kaggle's weekly GPU quota is exhausted) — the VRAM rule
honestly downgraded and the registry reports what is really serving. When quota returns, the same
notebook auto-upgrades to Qwen3-4B with no changes.

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

---

## Addendum 7 — 2026-10-02: account reality, the VRAM gate bug, registration resilience

### 13. Token naming: the operator's `emmanuel_ofoye_KAGGLE_API_TOKEN` was unreadable (now fixed)

- The loader only accepted `KAGGLE_API_TOKEN`, `KAGGLE_API_TOKEN_<n>`, `KAGGLE_API_TOKEN_<NAME>`. A
  key saved as `emmanuel_ofoye_KAGGLE_API_TOKEN` was **silently ignored** — the agent looked
  "unconfigured" even though the key itself was correct.
- `kaggleApiTokens()` now also reads any `<NAME>_KAGGLE_API_TOKEN` variable, **after** the numbered
  slots, so `--token=1..3` keep meaning the same accounts. Test added in
  `packages/shared/src/lib/env.test.ts` ("owner-labelled name … is read, after numbered slots").
  `redactSecrets()` was widened the same way (`endsWith("KAGGLE_API_TOKEN")`) so a labelled key can
  never be printed.
- At the time of writing the key was **not in the environment under any name** (`freebuff-env list`
  shows only `KAGGLE_API_TOKEN_1..3`), so it still has to be added.

### 14. Verified account distribution (from `--list`, 2026-10-02)

| slot | account | kernels present |
|---|---|---|
| 1 | `bettertrade` | `notebook7eae283a4a` (Script AI), `ostra-voice-agent`, `ostra-model-benchmark` |
| 2 | `kidscity` | `ostra-image-agent`, `ostra-showrunner-agent` (both have real 2026-10-01 runs — connecting a Google account appears to have unblocked this account) |
| 3 | `scalehive` | `ostra-image-agent` (real 2026-10-01 run) |
| 4 | *(absent)* | the Emmanuel Ofoye key is still missing |

**Three accounts already cover the four agents**: Script AI + Voice AI on `bettertrade`, Image AI +
Showrunner on `kidscity`. `emmanuelofoye` is not required for the weekend launch; it is needed only to
retire the stray `gridderstore/ostra-image-agent` notebook and add a 4th independent GPU account.

### 15. Real bug: the VRAM gate could never select Qwen3-4B on Kaggle

- The gate was `_VRAM_GIB >= 15.0`, but every Kaggle run reports a **Tesla T4 = 14.6 GiB**
  (`nvidia-smi` lists two). The intended quality default was therefore unreachable and every agent
  silently served Qwen3-1.7B. The earlier reading "that run got no GPU" was wrong: the run *did* get
  T4s; the gate is why 1.7B was picked.
- Measured evidence from `bettertrade/ostra-model-benchmark` (real run, no estimates): Qwen3-1.7B
  13.6 tok/s, peak 2.21 GiB · Qwen3-4B 12.44 tok/s, peak 7.51 GiB · Qwen3-4B-Instruct-2507 8.13 tok/s,
  peak 3.73 GiB. 4B fits on a T4 with room to spare and costs ~9 % throughput.
- Gate lowered to `>= 14.0` in **both** generators (`scripts/kaggle-agent-notebook.ts`,
  `scripts/kaggle-sync-notebook.ts`) with the measurement quoted in the comment; the test now asserts
  `_VRAM_GIB >= 14\.0`. A Kaggle secret `OSTRA_MODEL` still overrides everything.
- Pushed as `bettertrade/notebook7eae283a4a` **v17** (HTTP 200, previousVersion 16) to exercise the
  4B path on a real T4. **The run log was still empty at 13:15Z** (queued/running), so the 4B boot is
  **not yet verified**. Check
  `bun scripts/kaggle-live-check.ts --kernel-ref=bettertrade/notebook7eae283a4a --logs` for
  `[ostra] model selected: Qwen/Qwen3-4B (gpu=True, vram=14.6 GiB)`.

### 16. Registration resilience + a dead log line fixed

- `bettertrade/ostra-voice-agent` died at `register FAILED: Read timed out. (read timeout=20)` — the
  Render free tier answered slower than 20 s and the agent went OFFLINE because of a slow answer
  rather than a real error. `_post()` now takes a `timeout`, and `_register()` retries a transport
  failure 3× with a 45 s timeout and 10 s between attempts, logging every attempt. A timeout is still
  reported as a failure — only its tolerance changed.
- `scripts/kaggle-agent-bootstrap.py` had two statements collapsed onto one line
  (`return _post(...)    _log(...)`), making the `[ostra] agent=… -> …` log line dead code. Restored to
  separate lines; `python3 -m py_compile` passes for both bootstrap scripts.

### 17. ngrok: the shared token is the real launch blocker

- A shared `NGROK_AUTHTOKEN` hands every agent **the same reserved subdomain**. Proof:
  `kidscity/ostra-showrunner-agent` and `bettertrade/notebook7eae283a4a` both reported
  `https://oversleep-gift-bonfire.ngrok-free.dev` — whichever run starts last takes the URL, so the
  other worker's endpoint points at the wrong model server. Free ngrok = 1 tunnel per account.
- So yes: each hosting account needs its own ngrok account, and the notebooks need
  `NGROK_AUTHTOKEN_SCRIPT` + `NGROK_AUTHTOKEN_VOICE` (on `bettertrade`) and
  `NGROK_AUTHTOKEN_IMAGE` + `NGROK_AUTHTOKEN_OVERSEER` (on `kidscity`) as **Kaggle secrets on that
  account, attached to the notebook**, keeping the shared `NGROK_AUTHTOKEN` only as fallback.
- Adding those variables to the Freebuff workspace `.env` does **not** reach the notebooks: the tunnel
  cell reads them through `kaggle_secrets`, i.e. from Kaggle's own secret store. Proof:
  `bettertrade/ostra-voice-agent` logged `no ngrok token: set the Kaggle secret NGROK_AUTHTOKEN_VOICE
  (or NGROK_AUTHTOKEN)` even though `NGROK_AUTHTOKEN_VOICE` exists in the workspace `.env`.

### 18. Honest state at 13:01Z on 2026-10-02

All four rows in `/api/workers` are `OFFLINE` with `HEARTBEAT_TIMEOUT`, which is expected: a Kaggle run
only keeps a worker online for `OSTRA_KEEPALIVE_MINUTES` (default 10). Set
`OSTRA_KEEPALIVE_MINUTES=480` as a Kaggle secret on each hosting account before launch. The Script AI
and Showrunner rows still carry a verified 200 `/health` body from their last runs; Image and Voice
have `endpoint: null`.

### 19. Checks actually run today

`bun test` → **284 pass / 0 fail** (20 files) · `npm run typecheck` → web + api exit 0 ·
`bun run lint` → exit 0 (two pre-existing `react-hooks/exhaustive-deps` warnings in
`apps/web/src/app/projects/**`) · `python3 -m py_compile` on both bootstraps → OK.

---

## Addendum 8 — 2026-10-02 (later): why the notebooks "don't read" the ngrok tokens, and two push bugs

### 20. The operator's ngrok tokens still do not reach the notebooks — and now the notebook says why

The operator added ngrok tokens to the Kaggle accounts. Two independent reasons the notebooks cannot
see them, both now surfaced in the run log instead of a generic failure:

1. **Workspace `.env` ≠ Kaggle secrets.** `NGROK_AUTHTOKEN_VOICE/_OVERSEER/_IMAGE` exist in the
   Freebuff workspace `.env`; the tunnel cell reads them through `kaggle_secrets`, which only sees
   secrets stored on the Kaggle account **and attached to that notebook**.
2. **"Created" is not "attached".** `UserSecretsClient.get_secret(label)` is documented as returning
   the value *only if the secret is attached to the current kernel*; there is no list method, so a
   missing secret is indistinguishable from a wrong label. The managed tunnel cell now asks the
   service with a label that cannot exist (`__ostra_secret_probe__`) and prints the service's real
   answer, plus every label it tried and the per-label error class. If the probe says no secrets
   exist for this kernel, the fix is "tick this notebook in Add-ons > Secrets", not "rename it".
   Applied to `tunnelCell()` and to the Script AI managed cell in `kaggle-sync-notebook.ts`; test
   added ("reports WHICH secret lookup failed …").

### 21. Bug: `KAGGLE_KERNEL_REF` hijacked every agent push

`kaggle-agent-notebook.ts` fell back to `cfg.kernelRef` (the env `KAGGLE_KERNEL_REF`, which belongs to
the **Script AI** notebook) when pinning the target owner, so `--agent=image --token=2` was REFUSED
with *"token #2 owns kidscity but the push targets bettertrade"*. Only an explicit
`--kernel-ref=`/`--owner=` may pin an agent notebook now; when the env var is set the script prints a
NOTE saying it is ignoring it. The plan output also no longer prints a guessed owner (`slug:
bettertrade/ostra-image-agent` while pushing to kidscity) — it prints the owner as the token's
account.

### 22. Bug: the showrunner slug drifted from the deployed notebook

`agentKernelSlug("overseer")` returned `ostra-overseer-agent`, but the live notebook is
`kidscity/ostra-showrunner-agent`, so the push 409'd on the duplicate title *and* would have left the
running showrunner notebook un-updated. The slug now returns `ostra-showrunner-agent`; test asserts it.

### 23. Pushes made (all HTTP 200), runs requested — **no run has produced output yet**

| kernel | account | version |
|---|---|---|
| `notebook7eae283a4a` (Script AI) | bettertrade | v17 |
| `ostra-voice-agent` | bettertrade | v5 |
| `ostra-image-agent` | kidscity | v2 |
| `ostra-showrunner-agent` | kidscity | v3 |

All four run logs were empty when last read (15:56Z, ~5 min after the pushes). That is consistent
with a Kaggle GPU queue — **and equally consistent with an exhausted weekly GPU quota**, which would
never start. The operator can settle it in one glance in the Kaggle UI: *Active sessions → queued*
vs *error*. Until a log exists, the 4B boot and the ngrok attach are **unverified**.

### 24. The Emmanuel Ofoye key is STILL not in the environment

`freebuff-env list` (checked twice, 15:47Z and 15:56Z) shows only `KAGGLE_API_TOKEN_1..3`, and
`freebuff-deploy env list` is empty. Neither `KAGGLE_API_TOKEN_4` nor
`emmanuel_ofoye_KAGGLE_API_TOKEN` is present, so both saves were lost. It is not needed to launch —
`bettertrade` (Script + Voice) and `kidscity` (Image + Showrunner) already cover the four agents — but
the stray `gridderstore/ostra-image-agent` notebook cannot be retired without it.

---

## Addendum 9 — 2026-10-02 (evening): 4B verified live; env key names cannot contain a dot

### 25. **Qwen3-4B is now proven on Kaggle hardware**

`bettertrade/ostra-voice-agent` v5 ran with the lowered gate and logged:

```
[ostra] model selected: Qwen/Qwen3-4B (gpu=True, vram=14.6 GiB)
```

That verifies the §15 fix end to end: a 14.6 GiB T4 now serves the 4B model instead of silently
falling back to 1.7B. It also confirms the dead-log-line repair — `[ostra] agent=voice
worker_id=voice-ai-kaggle -> https://ostra-studio-1.onrender.com` and `[ostra] model=Qwen/Qwen3-4B`
now actually print (they were unreachable code, §16).

### 26. `KAGGLE_API_TOKEN_4.5` can never be saved — env key names may not contain a dot

The operator's second naming attempt was `KAGGLE_API_TOKEN_4.5`. Verified directly: the environment
tool rejects any key with a dot in it (`freebuff-env set` → `Invalid env key:
OSTRA.DOTTED.NAME.TEST`, tested with a throwaway name). Shells cannot export such names either. So
the save failed before it could ever reach `kaggleApiTokens()`. `KAGGLE_API_TOKEN_4` is the name to
use; `emmanuel_ofoye_KAGGLE_API_TOKEN` would also work now that labelled names are read.

### 27. The ngrok diagnostic was unreadable in the log — Kaggle truncates log lines

Voice v5 proved the new lookup reporting fires (all four labels → `BackendError`), but the whole
diagnosis sat on **one** long line and Kaggle's log API cut it at ~200 characters — so the actual
answer (wrong label vs. nothing attached) never reached the log. The tunnel cells now print one short
line per fact:

```
[ostra] ngrok secret lookup failed for this notebook
[ostra]   tried NGROK_AUTHTOKEN_VOICE -> BackendError: …
[ostra]   probe __ostra_secret_probe__ -> BackendError: …
[ostra]   fix: secrets must be ATTACHED, not just created (Add-ons > Secrets, tick THIS notebook)
```

Pushed as `bettertrade/ostra-voice-agent` v6 to read the probe answer. **Its log was still empty when
last checked (queued)** — the attach question is therefore still open, though the evidence so far
(plain `NGROK_AUTHTOKEN` also `BackendError` on the voice notebook, while the same account's Script AI
notebook has a working tunnel) points at per-notebook attachment.

### 28. v6 gave the definitive answer — and Voice AI registered ONLINE on Qwen3-4B

```
[ostra]   tried NGROK_AUTHTOKEN_VOICE -> BackendError: … 'No user secrets exist for kernel id 136…'
[ostra]   probe __ostra_secret_probe__ -> BackendError: … 'No user secrets exist for kernel id 136…'
[ostra] register -> HTTP 200 {"worker":{…"type":"voice","model":"Qwen/Qwen3-4B","status":"ONLINE"…
```

- The cause is **not** a wrong label: Kaggle reports **zero user secrets exist for that kernel**. The
  secret must be *attached* to `bettertrade/ostra-voice-agent` (Add-ons → Secrets → tick the
  notebook); a secret created on the account but not attached is invisible to that notebook, which is
  exactly why the earlier "it does not read them" report was accurate.
- Registration itself now works: `HTTP 200 … "status":"ONLINE"` with `Qwen/Qwen3-4B`. Voice AI is
  registered but **not reachable** (`endpoint=(no tunnel URL)`), so dispatch to it cannot succeed
  until the secret is attached. That distinction is deliberate: registered ≠ reachable.

### 29. Token #4 = `emmanuelofoye`, confirmed, and Image AI pushed there

The operator supplied the value in chat (their name had a trailing underscore,
`emmanuel_ofoye_KAGGLE_API_TOKEN_`, which no suffix/label form would have matched either, so it was
saved as the canonical `KAGGLE_API_TOKEN_4`). Verified, not assumed:

```
--- token #4 ---   account: emmanuelofoye   (no kernels matching 'ostra')
POST /kernels/push -> HTTP 200  emmanuelofoye/ostra-image-agent  v1
```

That is the **fourth real Kaggle account**, and one agent per account is what the launch wants:
Kaggle runs **one notebook session per account**, so four agents need four accounts.

| agent | account | kernel |
|---|---|---|
| Script AI | bettertrade | `notebook7eae283a4a` |
| Voice AI | bettertrade | `ostra-voice-agent` (second session — run it when Script AI is idle) |
| Showrunner | kidscity | `ostra-showrunner-agent` |
| Image AI | emmanuelofoye | `ostra-image-agent` (v1, fresh account) |

- **Hazard to avoid:** `kidscity/ostra-image-agent` v2 is also queued, and two Image notebooks would
  fight over the *same* worker row (registration upserts by type+runtime+provider). Cancel that run
  in Kaggle, or delete that notebook — it is now redundant.
- `emmanuelofoye` is a brand-new account and has produced no run log yet. A new Kaggle account often
  cannot start a session until email/phone is verified (this is exactly what blocked `kidscity` before
  a Google account was connected). **Unverified** until a log appears.
- Each hosting account needs its own ngrok secret **attached to its notebook**: `NGROK_AUTHTOKEN_SCRIPT`
  / `_VOICE` (bettertrade), `_OVERSEER` (kidscity), `_IMAGE` (emmanuelofoye).
- Security note: the token was pasted in chat, so treat it as exposed — regenerate it in Kaggle
  (Settings → API) once the launch is stable and update `KAGGLE_API_TOKEN_4`.

### 30. Full end-to-end test, 2026-10-02 21:00–21:20Z — what is proven and what is not

Static: `bun test` **285 pass / 0 fail**, `npm run typecheck` 0, `bun run lint` 0.

Live API (`ostra-studio-1.onrender.com`): `/api/health` → `ok:true`, Supabase connected (497 ms);
`/api/agents/roster` → all four agents `available:false` with the real reason instead of a mock.

Real rows created for the test: project `launch-readiness-check`
(`952e81ef-fd0f-43f2-85bd-4b8641f66949`) and studio room `Launch readiness round`
(`90eca29d-2cee-4510-a288-afe4fee699cd`). Delete them if the workspace should stay clean.

**Every worker now reports `Qwen/Qwen3-4B`** — the §15 gate fix is in force across all four agents,
not just Script AI.

**Real model inference over a real tunnel** (Showrunner, kidscity, its own ngrok account):

```
GET  https://backpedal-nursing-yam.ngrok-free.dev/health  -> {"ok":true,"agent":"overseer","model":"Qwen/Qwen3-4B"}
POST …/v1/chat/completions                                   -> real generated text (Qwen3-4B, 2× Tesla T4)
```

Note the subdomain differs from bettertrade's `oversleep-gift-bonfire`, which confirms the per-agent
ngrok tokens now in use really are separate accounts — the §17 collision is gone.

**A real production round was dispatched** (`POST /api/agents/rooms/:id/dispatch`, brief persisted
first, `changed: 0`, `failedWrites: 0`):

| turn | result |
|---|---|
| script | `ok:false`, `backend:null`, honest error: no ONLINE worker with an endpoint |
| image | `ok:false`, same honest error — no fake reply |
| voice | `ok:false`, same honest error |
| **overseer** | **`ok:true`**, `backend:{kind:"project_worker", provider:"kaggle", model:"Qwen/Qwen3-4B", endpointHost:"backpedal-nursing-yam.ngrok-free.dev"}`, `latencyMs:53171`, real reply |

The Showrunner's own answer was correct about the system it is watching: *"The production channel is
not yet live. The Director's query to Script AI remains unanswered…"*. A second round behaved the same
(`latencyMs:40403`). **This is the first time the orchestrator → tunnel → GPU model → persisted channel
loop has been exercised with a real model.**

Not proven / still open:

- **Script AI came up ONLINE on Qwen3-4B at 21:08:54 but with `endpoint: null`** — its ngrok tunnel did
  not come up, so the orchestrator correctly refuses to use it. Cause **not** established: this
  kernel's run log is unreadable (`GET /kernels/output` → HTTP 200, **0 entries**) while the run is in
  progress, so the new tunnel diagnostics cannot be seen. Prime suspect is the one-tunnel-per-ngrok
  -account rule on the shared token, aggravated by bettertrade holding two notebooks. Re-read the log
  after the run finishes.
- `bettertrade/notebook7eae283a4a` reported `currentVersionNumber=19` although this session pushed 18
  only — someone/something saved another version from the Kaggle UI, which is expected if the operator
  is working in the notebooks directly.
- Image AI (`emmanuelofoye/ostra-image-agent`) **did run** — heartbeat 18:02 today, model Qwen3-4B —
  but registered with no endpoint: no ngrok secret attached to that notebook yet.
- Voice AI: registered ONLINE on Qwen3-4B (v6, §28) but never had a tunnel (zero attached secrets).
- Reminder still standing: `kidscity/ostra-image-agent` v2 must be cancelled or deleted so two Image
  notebooks cannot fight over one worker row.

---

## Addendum 10 — 2026-10-03: the dashboard said "not configured" while the agents were on Kaggle/Qwen3-4B

### 1. The report

The dashboard (/models, /, provider cards) reported Image AI and Voice AI as
`NOT_CONFIGURED — "Set GOOGLE_CLOUD_PROJECT (Colab API project) on Render"`, labelled Script AI
"Qwen3 1.7B", and had **no row at all** for the Showrunner. The UI was not lying about its own data —
it was faithfully rendering a stale provider catalog.

### 2. Root cause (two, both real)

1. **Provider slots were pinned to a runtime that was never the production plan.**
   `apps/api/src/lib/providerHealth.ts` hard-coded `image → runtime "colab"` and
   `voice → runtime "colab"`. `pickWorker(workers, "image", "colab")` therefore never matched the
   real worker row (the agent notebooks register as `runtime: "kaggle"`), so the slot fell through
   `deriveProviderHealth` to the `!configured` branch and reported NOT_CONFIGURED **even when the
   Kaggle worker was ONLINE**. The same pin made the Showrunner invisible: `overseer` was not a
   provider id at all (`PROVIDER_IDS` had 6 entries, no overseer).
2. **The model catalog described the pre-launch plan.** `MODEL_CATALOG` had `script-qwen3-1-7b`
   ("Qwen3 1.7B"), `image-colab-image` and `voice-kokoro-82m` — none of which is what runs today
   (four Kaggle notebooks on Qwen3-4B).

A third, cosmetic, problem: the landing page carried the hard-coded sentence "Image / Voice stay
NOT_CONFIGURED until their Colab bootstrap is wired", which is now false.

### 3. The fix

- `packages/shared/src/providers/health.ts`: `overseer` is now a provider id; `workerDisplayHealth`
  puts the worker's own `model` into `health.detail` (never inferred from config).
- `apps/api/src/lib/providerHealth.ts`: agent slots resolve their worker **by type, across whatever
  runtime the worker registered on** (`runtimes: []`); the provider/runtime label comes from the real
  worker row when there is one. Configuration for those slots = a Kaggle token **or** the Colab
  config; when neither exists the reason names both runtimes. Script keeps `kaggleConfig()` (it also
  needs `KAGGLE_KERNEL_REF` to autostart); video/youtube unchanged and still honestly NOT_CONFIGURED.
- `packages/shared/src/providers/models.ts`: catalog is now the four real agents on `qwen3-4b` +
  video + youtube; added `LEGACY_MODEL_KEYS` / `resolveStoredModelKey` so a switch stored under a
  retired key (`script-qwen3-1-7b`, `image-colab-image`, `voice-kokoro-82m`) still counts for the
  entry that replaced it — a model upgrade must not silently reset an operator's ON/OFF choice — and
  `liveModelFromHealth()` which reads the model a worker reported.
- `apps/api/src/routes/models.ts`: `mergeModelViews` applies the legacy key (current key wins),
  surfaces `liveModel`, and shows the live provider/runtime instead of the planned ones.
- Web: models page prints the live model (`no model reported` when nothing has registered);
  `PROVIDER_ORDER`/`PROVIDER_LABELS` include the Showrunner; landing-page copy corrected.

### 4. Verified (real data, 2026-10-03)

- `bun test` → **304 pass / 0 fail** (21 files; new `apps/api/src/lib/providerHealth.test.ts`).
- `npm run typecheck` → exit 0 · `bun run lint` → exit 0 (pre-existing warnings only).
- Fed the **real** worker rows from `GET https://ostra-studio-1.onrender.com/api/workers` through the
  new derivation: script/image/voice/overseer now report `OFFLINE — worker status OFFLINE`,
  `runtime=kaggle`, `liveModel=Qwen/Qwen3-4B`, and `/api/models` lists four agent rows instead of
  three. Before the change the same rows produced `NOT_CONFIGURED — Set GOOGLE_CLOUD_PROJECT`.
  Video/YouTube still report NOT_CONFIGURED (true: not deployed).

### 5. NOT done / operator must know

- **Render has not been redeployed.** Until the API on Render runs this commit the deployed
  `/api/health` and `/api/models` still return the old catalog, so the browser will still show
  "not configured". Push + redeploy Render, then reload the dashboard.
- This changes **what is reported**, not worker uptime. The four agents are still OFFLINE for the
  reasons in Addendum 10 §"not proven": Script and Voice registered with `endpoint: null` (no ngrok
  secret attached), and `OSTRA_KEEPALIVE_MINUTES=480` is still missing on every hosting account, so
  heartbeats expire after the default 10-minute idle window.
- `apps/api/src/lib/providerHealth.ts` now exports `pickWorker`, `providerDefinitions` and the
  `ProviderDef` type for the unit tests. They are pure; no behaviour change from the export.
- `packages/shared/src/providers/registry.ts` was deliberately left alone: it is the autostart
  adapter map (nothing consumes it except its own test), and the runtime supervisor still needs the
  Colab starters to exist as an alternative runtime.

### 6. Two more real bugs found while verifying in the browser

1. **`/agents` and `/runner` were returning HTTP 500 in the web app.** `packages/shared/src/agent/agents.ts`
   imported `"./protocol.js"`. Bun and `tsc` rewrite that to `protocol.ts`; **webpack does not**, so any
   route whose module graph touches `@ostra/shared`'s agent module failed to compile. `/models` compiled
   (it does not import the agent module), which is why only the agent pages looked broken. Fixed by making
   the specifier extensionless; `orchestrator/events.ts → "../domain/schemas.js"` had the same latent bug
   and was fixed too. `packages/shared/src/module-resolution.test.ts` now fails if any non-test file in
   `packages/shared/src` reintroduces a relative `.js` specifier.
2. **Run Now could have started the wrong notebook.** Once the catalog names the real runtime (`kaggle`)
   for image/voice/overseer, `POST /api/runtime/run-now` for those slots would have handed the Kaggle
   starter the one configured kernel (`KAGGLE_KERNEL_REF` = the **Script AI** notebook) and re-pushed it
   under another worker's identity. Catalog entries now carry `autostart` / `autostartNote`; only `script`
   is autostartable, the API answers `409 not_autostartable` with the real reason, and the Runner button
   is disabled with that same reason. The catalog's `runtime`/`provider` are documented as the planned
   home; the health row shows what the worker really registered with.

### 7. Checks actually run for Addendum 10

- `bun test` → **311 pass / 0 fail** (22 files).
- `npm run typecheck` → exit 0 · `bun run lint` → exit 0 (pre-existing warnings only).
- `bun --filter @ostra/web build` → exit 0, all 13 routes compile (the Vercel deploy path).
- Live managed preview after a restart: `/`, `/models`, `/runner`, `/agents`, `/runtimes`, `/chat`,
  `/studio`, `/activity`, `/projects` all **HTTP 200**. `/runner` server-renders four "Qwen3 4B" agent
  cards plus the disabled Run buttons carrying their real reasons.

---

## Addendum 11 — Management Team (hosted, director-facing, with a server-enforced autonomy gate)

### 1. What was added

A **fifth role, `manager`**, called "Management Team" everywhere in the UI. It is a *hosted*
OpenAI-compatible model (the operator's example — Lightning AI `https://lightning.ai/api/v1/` with
`openai/gpt-5.6-luna` — works verbatim, and so does OpenAI or any gateway, because only
`base_url` + bearer key + `POST {base}/chat/completions` is used; **no SDK was added**).

- `packages/shared/src/lib/env.ts` — `managerConfig()` (`MANAGER_API_KEY`/`MANAGER_BASE_URL`/
  `MANAGER_CHAT_MODEL`, falling back to `LIGHTNING_*` then `OPENAI_*`) and `managerAutonomy()`.
- `packages/shared/src/providers/health.ts` — `manager` is now a `ProviderId`.
- `packages/shared/src/providers/models.ts` — catalog entry `manager-hosted` (autostart: false, with the
  reason: there is no runtime to start).
- `packages/shared/src/agent/agents.ts` — manager profile, `AGENT_ALL_KINDS`, manager prompt rules.
- `packages/shared/src/agent/protocol.ts` — `manager` participant, `instruction` message kind, `start`
  list in the envelope (`AgentReply.starts`), and `resolveParticipant()`.
- `apps/api/src/lib/agentRuntime.ts` — `managerBackend()`, `resolveManagerBackend()`, `probeHostedModel()`
  (a real tiny completion, cached 60 s), `hosted_manager` transport, array-shaped `content` support.
- `apps/api/src/lib/managerAutonomy.ts` — **the only** place a requested start is decided.
- `apps/api/src/lib/agentChannel.ts` — manager turn first in a round; its `start` list is applied.
- `apps/api/src/routes/agents.ts` — `GET /api/agents/management`, `POST /api/agents/rooms/:id/manage`.
- `apps/web/src/app/management/page.tsx` + nav entry, `apps/web/src/lib/agents.ts` clients.

### 2. The autonomy rules (server-side, never the model's choice)

`MANAGER_AUTONOMY` ∈ `off` (default) | `instruct` | `full`; anything unrecognised → `off`.

- Instructions to Script/Image/Voice **and the Showrunner** always work (they are ordinary channel rows).
- A `start` request is checked per target: autonomy gate → known worker type → `autostartRefusal()` →
  the same `runNowByWorker()` the Run Now button uses. Refusals are returned as data
  (`refused_autonomy`, `refused_unknown_target`, `not_autostartable`) and shown on `/management`.
- Only `script` was autostartable at the time, so this path could never re-push the Script kernel as another agent. **Superseded by Addendum 12**: all four Kaggle agents now have their own autostart path (each pushes its own notebook), and the same per-slot rule still prevents any cross-slot kernel.

### 3. Honesty notes (what this does NOT do)

- The management team has **no worker row** and never heartbeats: `ONLINE` requires a real completion call.
- It does not run the agents' work: it plans (store `actions`) and instructs. Episodes/seasons are real
  only when the agents actually produce them — throughput is still bounded by GPU sessions, and nothing
  in this code claims otherwise.
- `rosterModels()` skips hosted roles so the Kaggle benchmark never tries to run the management model on a T4.

### 4. Operator steps

1. Add on Render: `MANAGER_API_KEY`, `MANAGER_BASE_URL`, `MANAGER_CHAT_MODEL`, `MANAGER_AUTONOMY`.
   Without `MANAGER_API_KEY` the slot is honestly `NOT_CONFIGURED` and the page says so.
2. Deploy (Render API **and** Vercel — the page is a new route).
3. Open `/management` and send a brief.

### 5. Checks actually run

- `bun test` → **343 pass / 0 fail** (26 files), including new
  `agentRuntime.manager.test.ts`, `managerAutonomy.test.ts`, `env.manager.test.ts`,
  `protocol.manager.test.ts`.
- `npm run typecheck` → exit 0 · `bun run lint` → exit 0 (pre-existing warnings only).
- `bun --filter @ostra/web build` → exit 0, `/management` in the route table.

## Addendum 12 — 2026-10-05: Run Now can start every agent (per-slot Kaggle kernels)

### 1. The bug the director reported

"I can't start/run the other agents except from Script AI." That was real, and deliberate: only
`script` had `autostart: true`, and `POST /api/runtime/run-now` answered
`409 {"action":"not_autostartable"}` for `image` / `voice` / `overseer`. The reason was honest —
the only configured Kaggle kernel was the **Script** notebook (`KAGGLE_KERNEL_REF`), so starting
another slot would have re-pushed the Script kernel under that agent's identity. The fix is per-slot
kernels, **not** an enabled button onto the wrong notebook.

### 2. What changed

- `packages/shared/src/lib/env.ts` — `kaggleKernelRefEnvName(slot)` (script keeps `KAGGLE_KERNEL_REF`,
  others are `KAGGLE_KERNEL_REF_<SLOT>`), `kaggleKernelRef(slot)` (**no cross-slot fallback**), and
  `kaggleApiTokensFor(slot)` (slot-labelled token first, then every configured token).
- `packages/shared/src/providers/runtimeStarters.ts` — `KaggleRuntimeStarter` resolves the ref per slot
  and picks the token whose embedded account owns that ref (`pickKaggleToken`); the missing-ref error
  names the slot's exact variable.
- `packages/shared/src/providers/models.ts` — `image`, `voice` and `overseer` are now `autostart: true`
  (each pushes its own notebook). Refusal notes removed for them; `manager` / `video` / `youtube` keep
  theirs. `autostartRefusal()` is unchanged in meaning: it refuses only a slot with **no** start path.
- `apps/api/src/lib/scheduler.ts` — `runNowByWorker` gains a per-agent kernel guard **before** the lease
  (409 `not_autostartable` naming `KAGGLE_KERNEL_REF_<SLOT>`, recorded in `runtime_startup_history`) and
  passes the slot's ref into the starter; `startViaStarter` applies the same rule to scheduled starts.
- `apps/api/src/lib/managerAutonomy.ts` — `SLOT_RUNTIMES` now covers `script` / `image` / `voice` /
  `overseer`, and `startableTargets()` reports `ok:false` until that slot's own ref is set.
- Runner `/runner` + landing copy + `docs/API_ENV.md`, `docs/WEB_ENV.md`, `AGENT_CONTRACTS.md` updated to
  match; `scripts/kaggle-agent-notebook.ts` now prints the exact Render variables after a push.

### 3. Operator steps (the parts only a human can do)

1. Create/refresh the notebooks: `bun scripts/kaggle-agent-notebook.ts --agent=all --apply` (or per
   agent with `--owner=`/`--token=`), then attach `NGROK_AUTHTOKEN_<AGENT>` +
   `OSTRA_KEEPALIVE_MINUTES=480` to each notebook.
2. On **Render**, set the refs the script printed, e.g.
   `KAGGLE_KERNEL_REF_IMAGE=<owner>/ostra-image-agent`,
   `KAGGLE_KERNEL_REF_VOICE=<owner>/ostra-voice-agent`,
   `KAGGLE_KERNEL_REF_OVERSEER=<owner>/ostra-showrunner-agent` (Script AI keeps `KAGGLE_KERNEL_REF`).
   Add a slot-labelled token (`KAGGLE_API_TOKEN_IMAGE` / `_VOICE` / `_OVERSEER`) when the notebook lives
   on an account other than the default token's.
3. Reload `/runner`: each button is enabled; a slot with no ref reports 409 with the exact variable name.

### 4. Honesty notes

- WIRED is not ONLINE. Enabling the button only means the orchestrator *can* push that notebook; an agent
  still reaches `ONLINE` solely by tunnelling in, registering and heartbeating.
- Kaggle allows **one notebook session per account**, so Speech/AI identities must not share an account's
  session at the same time.
- Nothing was exercised against the live Kaggle API in this change; the starter behaviour is covered by
  mocked-fetch tests (see below) plus the pre-existing live checks.

### 5. Checks actually run

- `bun test` → **352 pass / 0 fail** (26 files), including two new `runtimeStarters` cases: a non-script
  slot with no own ref is refused by name and never names the Script kernel, and a slot with its own ref
  pushes that notebook with the owning account's token.
- `npm run typecheck` → exit 0 · `bun run lint` → exit 0 (pre-existing warnings only).
- `bun --filter @ostra/web build` → exit 0 (`/runner` and `/management` in the route table).

---

## Addendum 13 — 2026-10-08: NVIDIA free models as a backup, a real provider switch, and agent thinking on screen

**Request.** "Adding and using Nvidia free models as a backup for all the ai models we currently have;
should be a place where I can switch all the ai models to nvidia models and use them; add all the
necessary security layers; and I want to see what the agents are thinking when we are having a
conversation."

### What was built

1. **NVIDIA NIM (`build.nvidia.com`) as a hosted backup for every slot.** `NVIDIA_API_KEY` (alias
   `NVIDIA_NIM_API_KEY`) + `NVIDIA_BASE_URL` (default `https://integrate.api.nvidia.com/v1`) +
   `NVIDIA_CHAT_MODEL` (default `meta/llama-3.3-70b-instruct` **at the time — superseded**: that id was
   end-of-lifed by NVIDIA on 2026-08-26; the default is now `nvidia/nemotron-3-super-120b-a12b`, see
   `handoffs/HANDOFF-2026-10-08-nvidia-model-repin.md`) + optional `NVIDIA_MODEL_<SLOT>`,
   `NVIDIA_THINKING`, `NVIDIA_RATE_LIMIT_PER_MIN`. It is a new backend kind `hosted_nvidia`
   (`apps/api/src/lib/agentRuntime.ts`), so the same call path serves Script AI, Image AI, Voice AI, the
   Showrunner and the Management Team.
2. **The switch.** Migration `supabase/migrations/009_provider_routing.sql` (single-row `provider_routing`)
   + `apps/api/src/lib/routing.ts` + `apps/api/src/routes/routing.ts` → `GET|PATCH /api/routing`. Modes:
   `own` (project runtimes only — a room says "nothing can answer" instead of using an API), `auto`
   (default: own worker if genuinely ONLINE, else NVIDIA, else `OPENAI_*`), `nvidia` (everything through
   NIM). Per-slot overrides supported (`{ slot, slotMode }`, `slotMode: null` inherits). UI:
   `apps/web/src/components/ProviderRouting.tsx` on `/models` — three explicit mode cards, a per-agent
   override table, the NVIDIA status card and the catalog list. Every change is audited as
   `events.type = 'routing.changed'`.
3. **Security layers** (all server-side, all unit-tested in
   `packages/shared/src/providers/nvidia.test.ts` / `apps/api/src/lib/agentRuntime.nvidia.test.ts`):
   endpoint allowlist (the key is never sent to a non-NVIDIA host — a wrong `NVIDIA_BASE_URL` is refused
   before the request, verified by asserting `fetch` was not called), model-id allowlist (only the vetted
   catalog is dispatchable), per-model reasoning switch (`enable_thinking`, never a guessed kwarg), no
   forced `response_format: json_object` (it suppresses reasoning and not every NIM model implements it),
   an in-memory sliding-window limiter (`apps/api/src/lib/rateLimit.ts`) → `429 RATE_LIMITED` with a real
   `Retry-After`, secret redaction extended to `nvapi-` values and NVIDIA key names
   (`redactSecrets`), the key added to the server-only `getServerSecret` union, and the endpoint host (never
   the URL) as the only thing ever returned to a client.
4. **Thinking on screen.** Both conversation surfaces now use one component
   (`apps/web/src/components/ThinkingBlock.tsx`), **expanded by default**, with a real word count, above the
   message it belongs to (`/chat`, `/studio`). Nothing is invented: `parseAgentResponse` splits a separate
   `reasoning_content` channel or inline ` thinking…</think>` out of the answer *before* the JSON envelope is
   parsed, and a model that produced no trace renders no block. On the NVIDIA side, thinking is requested
   (and the token budget floored to 2048) only for models that document the switch — see
   `AGENT_CONTRACTS.md` → "Conversation-thinking exception" (its "collapsed by default" wording was
   superseded) and the new "Hosted backup — NVIDIA NIM + provider routing" section.

### Verification (actually run, 2026-10-08)

- `bun test` → **394 pass / 0 fail** (31 files). New: `packages/shared/src/providers/nvidia.test.ts`,
  `packages/shared/src/providers/routing.test.ts`, `apps/api/src/lib/rateLimit.test.ts`,
  `apps/api/src/lib/routing.test.ts`, `apps/api/src/lib/agentRuntime.nvidia.test.ts`.
- `npm run typecheck` → exit 0 (web typecheck + api build).
- `bun run lint` → exit 0 (pre-existing warnings only).

### Not verified (honest limitations)

- **No live NVIDIA call was made** — no `NVIDIA_API_KEY` exists in this workspace, so the real probe,
  the real model ids against the account and the real reasoning channel are unexercised. Every NVIDIA path
  is covered by mocked-fetch tests only; `README.md` and `docs/API_ENV.md` say so.
- Migration `009` **was applied** to the live Postgres database with `node scripts/apply-migration.mjs
  supabase/migrations/009_provider_routing.sql` → `APPLIED OK`. A follow-up read confirms `provider_routing`
  exists with columns `id/mode/slots/updated_by/updated_at`, checks `id = 1` and
  `mode in ('own','auto','nvidia')`, trigger `trg_provider_routing_touch`, and the seeded default row
  (`id=1, mode='auto', slots={}`). The missing-table degrade path is still unit-tested only.
- `/api/routing` was not called live (needs Supabase on the backend); the `/models` panel was verified by
  typecheck/build only, not by rendering against a live backend.

### Operator steps

1. ~~Run `supabase/migrations/009_provider_routing.sql`.~~ Already applied (see above).
2. On Render set `NVIDIA_API_KEY` (build.nvidia.com → Get API Key, `nvapi-…`). Optionally
   `NVIDIA_CHAT_MODEL=<a catalog id>` for a specific lane, or per-slot `NVIDIA_MODEL_<SLOT>`. The ids
   named here originally (`qwen/qwen3-next-80b-a3b-instruct` and the llama defaults) were all confirmed
   gone on 2026-10-08 — use the five live-verified ids in `docs/API_ENV.md`; every catalog entry now
   documents its thinking switch, so `NVIDIA_THINKING` needs no per-model tuning.
3. Open `/models` → pick a routing mode. `NVIDIA for everything` needs no Kaggle runtime at all; `Auto`
   keeps the project's own models first.

### Superseded wording

- `AGENT_CONTRACTS.md` "Agent Chat exception … it is collapsed by default" → replaced by
  "Conversation-thinking exception" (expanded by default, both surfaces).
- `docs/API_ENV.md` chat-page note "collapsible THINKING block" → "expanded THINKING block".
