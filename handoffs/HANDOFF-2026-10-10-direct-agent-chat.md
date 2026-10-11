# Handover — Direct agent chat: choose which agent you are talking to

Date: 2026-10-10
Branch: `main` (working tree **not** committed — Freebuff's Changes panel owns Save/Share/commit)

## 1. Task

Continue the in-flight work on the Agent Chat room: the director should be able to open ONE room and choose
WHICH canonical agent to talk to — Management Team, Script AI, Image AI, Voice AI or Showrunner — with each
agent's conversation kept separate, and with any peer handoff an agent makes being real, deliverable work
instead of a promise in prose.

State when picked up: the backend and the shared prompt/helpers for this were written but uncommitted and
**not wired to anything** — one of them did not even compile, the routes were not registered, the columns
they need did not exist in the database, and the web app had no way to pick an agent (the page still called
the original single-agent endpoint). The README already described the feature as shipped.

## 2. Result

Done for the requested scope, and finished end to end:

1. **It compiles.** `apps/api/src/lib/agentChannel.ts` used `AGENT_ALL_KINDS` without importing it; the API
   build failed with `TS2304`. Fixed (and the duplicate `@ostra/shared` import merged into one).
2. **The routes exist.** `GET /api/chat/rooms/:id/targets`, `POST /api/chat/rooms/:id/message` and
   `GET /api/chat/rooms/:id/conversation/:kind` are registered in `apps/api/src/index.ts`. They were written
   but unreachable before this.
3. **The database matches the code.** Two new migrations, authored AND applied to the live database (see §5):
   - `011_agent_messages_manager.sql` — `agent_messages.from_agent`/`to_agent` were constrained by migration
     `007` to `('director','script','image','voice','overseer')`, i.e. **without `manager`**, so every channel
     row the hosted Management Team wrote — and every handoff addressed to it — was rejected by the check at
     INSERT time and reported by `insertChannelMessage`/`runAgentTurn` as simply "no row". The direct-chat
     feature needs exactly that widening. It only widens the allowed set.
   - `012_chat_targets.sql` — `chat_messages.target_kind` (which agent a turn belongs to), `chat_messages.
     client_msg_id` (send idempotency), the guarded check constraint on the five canonical kinds, the two
     indexes, and a backfill of the pre-existing rows to `'script'` — they came from the original single-agent
     room, whose only backend was the Script AI, so no history disappears from the UI. **108 rows were
     backfilled; 0 rows are now NULL.**
4. **The page can pick an agent.** `/chat` has a **TALKING TO** selector built from the backend's real
   `/targets` answer (each agent's live availability/provider/model, never a hard-coded "online"), its own
   transcript per agent, the agent's name on every message it owns, the real handoffs of a turn rendered
   under that message (`delivered` / `failed` / `queued — not invoked`), and a new **AGENT CHANNEL** panel
   showing the room's real `agent_messages` rows. The auto-work loop sends its continuations to the selected
   agent.
5. **A live backend one release behind does not break the page.** While the deployed API has no direct-chat
   routes, `sendTurn`/`fetchConversation` fall back to the original `/messages` endpoint and the page says so
   in a visible banner. This is temporary and disappears as soon as Render runs this build.
6. Tests, README and `docs/API_ENV.md` updated to match what the code actually does.

## 3. Repository state

`main`, working tree dirty. Nothing committed or pushed. Migrations `011` and `012` **are applied to the live
database** (the code is not: the Render API still runs the previous release).

## 4. Files changed

In-flight work that was already in the tree when this session started (reviewed and completed, not rewritten):

- `packages/shared/src/agent/agents.ts` — `DIRECT_CHAT_TARGETS`, `answerSourceLabel`, `sharedModelNote`,
  `buildDirectChatPrompt`.
- `packages/shared/src/agent/protocol.ts` — `create_season` / `submit_season` added to `AGENT_ACTION_OPS` and
  to `AGENT_ACTION_REFERENCE` (the season workflow from migration `010` was not reachable from an agent).
- `apps/api/src/routes/chat.ts` — `resolveTarget`, `listTargets`, `sendToAgent`, `listConversation`, the
  `DIRECT_HISTORY_LIMIT` context window and the `isClientId` idempotency guard.
- `apps/api/src/lib/agentChannel.ts` — `HandoffResult` + `deliverPeerMessages` (persist each peer message
  from one turn, then actually invoke each addressed peer via `runAgentTurn`, capped at 3 unique peers).

Changed in this session:

- `apps/api/src/lib/agentChannel.ts` — added the missing `AGENT_ALL_KINDS` import; merged the duplicate
  `@ostra/shared` import. **This was the only compile error in the API.**
- `apps/api/src/index.ts` — registered the three direct-chat routes (and the import block for them).
- `supabase/migrations/011_agent_messages_manager.sql` (new) — widen the `agent_messages` participant checks
  to accept the Management Team. **Applied.**
- `supabase/migrations/012_chat_targets.sql` (new) — `target_kind` + `client_msg_id` + constraint + indexes +
  the backfill. **Applied.**
- `apps/web/src/lib/chat.ts` — `AgentKind` re-export; `DirectTarget`, `Handoff`, `ChannelEntry`,
  `DirectSendResponse`, `DirectSendResult`, `DirectConversation` types; `listTargets`, `sendToAgent`,
  `listConversation`, `sendTurn`; `ChatMessage.target_kind`; the pure helpers `targetStatusLabel` and
  `handoffSentence`.
- `apps/web/src/app/chat/page.tsx` — target state + `selectedTarget`, `refreshTargets`, `fetchConversation` /
  `loadConversation` (with the legacy-endpoint fallback), per-target polling, `performTurn` → `sendTurn` with a
  `client_msg_id`, the **TALKING TO** selector, the agent's name on each message, per-message handoffs, the
  **AGENT CHANNEL** panel, the legacy banner, and updated header badge / empty state / thinking line /
  placeholder / HOW THIS WORKS copy.
- `packages/shared/src/agent/agents.test.ts` — 12 tests for `DIRECT_CHAT_TARGETS`, `answerSourceLabel`,
  `sharedModelNote` and `buildDirectChatPrompt`.
- `apps/web/src/lib/chat.test.ts` — 5 tests for `targetStatusLabel` and `handoffSentence`.
- `README.md` — migrations list now `001 → 012`, `/chat` route description, the direct-chat API block, and the
  duplicate direct-chat API block removed.
- `docs/API_ENV.md` — new "Direct agent chat" section (routes, honest failure codes, `handoffs` semantics,
  idempotency, what migrations `011`/`012` do).

## 5. Tests/checks

All run on the final state of the code, in this workspace:

| Command | Result |
| --- | --- |
| `bun --filter @ostra/api build` (`tsc --noEmit`) | exit 0 (was exit 2, `TS2304: Cannot find name 'AGENT_ALL_KINDS'` before the fix) |
| `bun --filter @ostra/web typecheck` (`tsc --noEmit`) | exit 0 |
| `bun --filter @ostra/web lint` | exit 0; only the 5 pre-existing warnings (`episodes/[id]`, `layout.tsx`, `projects/[id]`, `projects`). **No warning from `chat/page.tsx` or `lib/chat.ts`.** |
| `bun test` | **473 pass, 0 fail** across 35 files. 15 of them were added in this session (10 for the shared helpers, 5 for the web helpers) plus 2 that came with the in-flight work; the auto-work handover recorded 418 before any of this |
| `node scripts/apply-migration.mjs supabase/migrations/011_agent_messages_manager.sql` | `CONNECTED OK` → `APPLIED OK` |
| `node scripts/apply-migration.mjs supabase/migrations/012_chat_targets.sql` | `CONNECTED OK` → `APPLIED OK` |
| schema inspection (temporary script, deleted afterwards) | `chat_messages` has `target_kind text` + `client_msg_id uuid`; `chat_messages_target_kind_check` allows `manager/script/image/voice/overseer` (or NULL); `idx_chat_messages_target` + `idx_chat_messages_client` present; **0 rows with NULL `target_kind`**, 108 rows = `script`; `agent_messages_from_agent_check` and `..._to_agent_check` both include `manager` |
| `freebuff-preview restart` then `GET /chat` | `✓ Compiled /chat in 4.2s (840 modules)`, **`GET /chat 200`**, no error in the fresh log. The served HTML contains `TALKING TO`, `AGENT CHANNEL · REAL DELIVERIES`, the new per-agent empty state (`Nothing said to …`) and no stale `No messages yet` |

Note on the earlier error-log noise: the dev server's rolling log still contains transient
`Syntax Error … Unexpected token 'div'` entries from the moments **between** edits (the file was briefly
invalid mid-edit). The post-restart log is clean and the route serves 200.

## 6. Integration status

- **Supabase / live Postgres** — **verified.** Migrations `011` and `012` applied with the repo's own runner,
  and the resulting columns/constraints/indexes/rows read back from the database (output in §5). The backfill
  is confirmed: 108 legacy rows now carry `target_kind = 'script'`.
- **Render API** — **configured but stale.** The deployed API is built from the previous commit, so
  `/api/chat/rooms/:id/targets`, `/message` and `/conversation/:kind` **do not exist there yet** (404). The
  page detects that and falls back to the original endpoint with a visible banner. A redeploy of `main` after
  committing is required for the feature to be live.
- **NVIDIA NIM free tier** — **not attempted** in this session. The 429/`Retry-After` handling of the direct
  route is the same code path as the pre-existing room, whose shape is unit-tested; no live rate limit was
  triggered on purpose.
- **A real browser session of the selector / handoff delivery** — **not verified.** No browser is available in
  this workspace (the previous handover hit the same wall). The evidence is the compiled route, the served
  SSR markup, the passing tests and the verified schema — not a watched session.
- **Kaggle / Colab runtimes** — **not attempted**, untouched by this work.

## 7. Known issues

- **The API must be redeployed.** Until it is, `/chat` talks only to the Script AI and shows the
  "ONE AGENT PER CONVERSATION IS NOT LIVE YET" banner. This is a release-order issue, not a code bug.
- **A handoff only becomes work when the peer is online.** Up to 3 unique peers are invoked per turn; a
  message to a 4th peer, to an already-invoked peer, or to an offline peer stays `sent` (queued) and is shown
  as queued. The UI never upgrades it to "done".
- **Cost/latency:** one chat turn to the Management Team can now invoke up to 3 further agents synchronously,
  so a single send can take multiple model calls (and can hit the free-tier rate limit for one of them). The
  failures are reported per handoff, but the turn is not cancellable mid-flight.
- **`listConversation` returns up to 200 messages plus the whole channel**, and the page polls it every 3s
  while a turn is not in flight. Fine for a room-sized transcript; it would need a cursor for a huge room.
- **Idempotency is best-effort:** `client_msg_id` is only set when `crypto.randomUUID` exists, and the route
  looks at the last two rows for that id. A retry arriving after the user row but before the assistant row
  inserts a second turn (the model is called twice).
- **The Manager's own channel rows were previously being dropped silently** (see migration `011`). Expect
  older studio rooms to be missing the manager's lines — they were never stored, and nothing is backfilled.
- **`buildDirectChatPrompt` is a new prompt surface.** It reuses the same action allow-list and identity as the
  channel prompt, but its wording has only been unit-tested — no live model has answered from it yet.

## 8. Decisions

- **The fix for the missing `manager` participant is its own migration** rather than being folded into the
  direct-chat one: it is a pre-existing bug in the AI Studio channel with its own blast radius, and a
  one-concern-per-migration history is what `001`…`010` follow.
- **Pre-existing rows are backfilled to `'script'`** rather than left NULL. The alternative — leaving them
  NULL — would have made every existing conversation vanish from the UI, and calling them Script AI turns is
  factually what they were (that route's only backend). Nothing else is backfilled.
- **`client_msg_id` is indexed but deliberately NOT unique**: the user row and its assistant answer share the
  id, so a unique constraint would break the second insert.
- **The chosen agent is mirrored into a ref** (`targetKindRef`), like the bound project already was, so a
  turn started before a re-render still goes to the agent the operator selected.
- **Legacy fallback inside the client library** (`sendTurn`, `fetchConversation`) instead of in the page: it
  keeps the page a thin renderer and makes both the endpoint choice and the "normalise to the same shape"
  step reviewable in one place.
- **Handoffs are rendered per message**, keyed by the assistant message id, rather than as a global list: what
  an agent asked for belongs to the turn that asked.
- **The per-turn peer cap (3) and the history window (24) are constants**, not settings — they bound cost on a
  metered free account (`CONSTRAINTS.md` 22/25).
- **The auto-work loop keeps working unchanged**, but now works the selected agent. No loop policy was
  touched.

## 9. Environment/configuration

- **No new environment variables.** Nothing to set on Render or in the workspace.
- **Migrations `011` and `012` are already applied to the live database.** A fresh environment must run
  `node scripts/apply-migration.mjs supabase/migrations/011_agent_messages_manager.sql` and `…/012_chat_targets.sql`
  (or run every migration `001 → 012` in order, as the README says).
- **A Render redeploy of `main` is required** for the three new API routes to exist. The web app needs no
  configuration change: it reaches the API through the already-configured `NEXT_PUBLIC_API_URL`.
- The API cannot be exercised from this workspace: its Supabase REST URL/key are not in the workspace env
  (only the Postgres connection string is), and the running API lives on Render with its own env.

## 10. Next agent

One recommended task: **ship it, then watch one real turn.** Prerequisites: a Render redeploy of the API (and
for a peer handoff to actually deliver, at least one production agent ONLINE — the Script AI Kaggle worker or
an `NVIDIA_API_KEY`-backed slot).

1. Commit and deploy `main` so Render serves the three new routes; confirm
   `GET /api/chat/rooms/<id>/targets` returns five targets with a real `available` per target.
2. Open `/chat`, pick **Image AI**, send something concrete ("give Kai a scar on the left cheek") and confirm:
   the message is labelled with the agent that answered it, the selector dot matches reality, and no other
   agent's history appears in that conversation.
3. Switch to **Management Team** and confirm the two histories do not mix, then check whether its store plan
   produced a handoff: it must show as `delivered` **with the peer's real answer**, or as queued — never as
   done. Cross-check the same rows on `/studio` (this is also the first time the manager's channel rows can
   be stored at all — see migration `011`).
4. Toggle **Auto-work** ON for one agent and confirm the loop's continuations still land in that agent's
   conversation and still stop on `LOOP DONE` / the step cap / **Stop**.

## 11. Do not redo

- Do not re-create migrations `011` or `012`, and do not re-run them destructively — both are applied and
  idempotent. Do not "fix" the `manager` participant problem again.
- Do not re-add the three direct-chat routes or the `DIRECT_CHAT_TARGETS` / `buildDirectChatPrompt` /
  `deliverPeerMessages` helpers — they exist, are registered/imported, and their tests pass.
- Do not rebuild the auto-work loop, the reasoning block, or the season approval gate.
- Do not redo the earlier backend URL/CORS work: `NEXT_PUBLIC_API_URL` is baked into the bundle and the
  backend is reachable. The only open item there is the Render-side `CORS_ORIGINS` entry, which only the user
  can set.
- Do not put secrets in the frontend, and do not "helpfully" widen `client_msg_id` to a unique index.

## 12. Verification

Unverified and stated as such:

- **A live session in a browser** of the selector, the per-agent history separation, and a handoff actually
  being delivered to a peer (§10 is the script for it).
- **The new endpoints answering on Render** — they are not deployed yet, so they have never returned a real
  response; only the schema they need has been verified.
- **A live model answering from `buildDirectChatPrompt`,** and a live NVIDIA 429 being waited out by the
  direct route.
- **The legacy fallback path end-to-end** (it requires a backend without the new routes, i.e. exactly the
  current Render release — it rendered the page and the banner logic is straightforward, but the fallback
  send itself was not exercised against the live API, only typechecked).
- **Production deploy behaviour:** `freebuff-deploy env set` still refuses until the first deploy is done, so
  a deploy would bake in the sandbox `NEXT_PUBLIC_API_URL`.
