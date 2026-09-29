# HANDOFF — 2026-09-29 — Agent Chat room (talk to the project's AI, it adjusts the store)

## 1. Task

> "Create a new chat room were I can chat with the ai agent from the application I should be able to chat
> with the ai from the project describe ideas and it adjust the store in real time"

Translation into this repository: a chat room in `apps/web` where the human director talks to the project's
own Script AI (the Qwen model the Kaggle runtime serves), describes ideas in plain language, and the agent
writes the resulting characters / locations / episodes / scenes into the real Supabase store, with the store
panel updating live. No mock mode, no fake replies (`CONSTRAINTS.md` #1–3, #28–29).

## 2. Result

Implemented and typechecked; the honest-failure paths were exercised against a locally booted API.

Shipped:
- **Backend (Render API)** — new `/api/chat/*` routes: rooms (list/create/rebind), transcript
  (list/send), and a store snapshot endpoint. One turn = store the human message → read the live store →
  call the real model → apply the requested store writes → store the assistant row with the writes that
  actually happened.
- **Model selection is real and needs no new credential for the primary path** — the `script` worker that is
  genuinely ONLINE in Supabase (fresh heartbeat, registered endpoint) is called at
  `{endpoint}/v1/chat/completions`, i.e. **the AI this project already runs** (Qwen via the Kaggle tunnel).
  An optional hosted OpenAI-compatible fallback (`OPENAI_API_KEY`) is used only when no worker is ONLINE.
  When neither exists the API answers `503 NO_AGENT_BACKEND` and writes **no** assistant row.
- **Additive agent protocol** (`packages/shared/src/agent/protocol.ts`) — one JSON envelope
  `{reply, actions[]}`, a 10-op allow-list **with no delete op**, a tolerant parser (fenced JSON,
  `action`/`arguments` aliases, flattened args, prose fallback) that reports unsupported ops in `rejected`.
- **Real store writes** (`apps/api/src/lib/storeActions.ts`) — same column allow-lists as the REST routes,
  entities addressed by human handles (project slug/title, character name, episode number, scene index),
  every success audited into `events.agent.store_change`.
- **Migration `005_conversations.sql`** — `chat_rooms` + `chat_messages`. **Applied to live Supabase**
  (idempotent, additive).
- **Frontend** — `/chat` page (transcript + composer, rooms list, live store panel, honesty banner),
  `Agent Chat` nav entry, landing-page CTA + status row. Transcript polls 3s, store panel 6s.
- **Docs** — `docs/API_ENV.md` (full Agent Chat contract + env vars + migration list), `docs/ENV.md`,
  `README.md`, `AGENT_*` untouched.

Not shipped / not possible from this workspace: the live Render API still runs the previous build, so
`/api/chat/*` returns 404 there until Render redeploys. Render is external; this workspace cannot deploy it.

## 3. Repository state

- Branch `main`. Base commit at the start of this task: `ffe24bb` (= `origin/main`, the previous handover).
- This task's changes are committed as **`8867db1`** (feature + docs, 16 files) plus the follow-up handover commit on `main`, and pushed to `origin/main`.
- Base for the previous work: `978b888` (Render TS7 `baseUrl` fix) + `ffe24bb` (its handover).

## 4. Files changed

New:
- `supabase/migrations/005_conversations.sql` — `chat_rooms` (project-scoped transcript, touch trigger) +
  `chat_messages` (role user|assistant, `actions` jsonb = what was applied, `backend` jsonb, `error` jsonb).
- `packages/shared/src/agent/protocol.ts` — `AGENT_ACTION_OPS` (additive only), `AgentAction`,
  `parseAgentResponse`, `AgentStoreSnapshot`, `renderStoreContext`, `AGENT_ACTION_REFERENCE`,
  `buildAgentSystemPrompt`.
- `packages/shared/src/agent/protocol.test.ts` — 14 tests.
- `apps/api/src/lib/agentRuntime.ts` — backend resolution + caller: `resolveAgentBackend`, `callAgent`,
  `publicBackend`, `hostedFallbackConfigured`, `endpointHost`. Truthful failure codes
  `UNREACHABLE | TIMEOUT | HTTP_ERROR | EMPTY_RESPONSE`; endpoint URLs never leave the server (host only).
- `apps/api/src/lib/storeActions.ts` — `applyStoreActions` (batch executor, working-project propagation for
  a just-created project, audit rows) + `readStoreSnapshot` (the agent's view of the store, read per turn).
- `apps/api/src/lib/storeActions.test.ts` — 7 tests against an in-memory Supabase stand-in.
- `apps/api/src/routes/chat.ts` — `listRooms`, `createRoom`, `patchRoom`, `listMessages`, `postMessage`,
  `getStore`.
- `apps/web/src/lib/chat.ts` — typed client + pure helpers (`mergeMessages`, `actionLabel`, `actionTone`,
  `backendLabel`, `formatClock`).
- `apps/web/src/lib/chat.test.ts` — 9 tests.
- `apps/web/src/app/chat/page.tsx` — the room: transcript, composer (Enter to send), rooms list + create
  form, live store panel, backend badge, per-message change chips, "how this works" honesty card.

Modified:
- `apps/api/src/index.ts` — imports + registers the 6 chat routes before the 404 handler.
- `packages/shared/src/index.ts` — re-exports `./agent/protocol`.
- `apps/web/src/components/TopNav.tsx` — added `{ href: "/chat", label: "Agent Chat" }`.
- `apps/web/src/app/page.tsx` — hero CTA "Chat with the agent", Agent Chat button on the preview card,
  `Agent Chat → store writes` status row.
- `docs/API_ENV.md` — new Agent Chat section (routes, response shape, failure codes, backend order, env
  vars) + migrations list now includes 004 and 005.
- `docs/ENV.md`, `README.md` — migration lists now include 004/005.

## 5. Tests/checks

Actually run, in this order, from the repo root:

| Command | Result |
| --- | --- |
| `bun test packages/shared/src/agent/protocol.test.ts` | 14 pass / 0 fail |
| `bun test apps/web/src/lib/chat.test.ts` | 9 pass / 0 fail |
| `bun test apps/api/src/lib/storeActions.test.ts` | 7 pass / 0 fail (1 real bug found + fixed: a project created in the same batch did not propagate to later actions) |
| `bun test` | **226 pass / 0 fail, 16 files** (baseline was 196/13 → +30 tests) |
| `npm run typecheck` (`bun --filter @ostra/web typecheck` + `bun --filter @ostra/api build`) | exit 0 for both |
| `bun run lint` | exit 0; only the 4 pre-existing warnings (`react-hooks/exhaustive-deps` ×3 in `episodes/[id]`, `projects/[id]`, `projects`; `no-page-custom-font` in `layout.tsx`). **No warning in any new file.** |
| `node scripts/apply-migration.mjs supabase/migrations/005_conversations.sql` | `CONNECTED OK` → `APPLIED OK` against **live Supabase** |
| `node scripts/verify-supabase.mjs` | `DONE - all checks passed` |
| Local API boot (`cd apps/api && PORT=4599 SCHEDULER_ENABLED=false node --import tsx src/index.ts`) + curl | `/health` 200; `/api/chat/rooms` **503** `Supabase not configured` (local has only `DATABASE_URL`, no `SUPABASE_URL`/service key — expected); `POST /api/chat/rooms` 503; `/api/chat/store` 503; `/api/chat/rooms/<uuid>/messages` 503; `/api/nope` 404. **Proves all 6 routes are mounted and the 404 handler is intact.** |
| Preview (Freebuff dev server, port 3000) | `GET /chat` → **200**, contains "Studio Agent Room", "Create a room to begin", "ASKING THE BACKEND…", "HOW THIS WORKS", "THE STORE", and the `Agent Chat` nav entry. `GET /` → 200 with the new CTA. No runtime error markers, no blank page. |

## 6. Integration status

- **Supabase (Postgres)** — **connected & verified for this change**: migration 005 applied to the live
  database; `verify-supabase.mjs` passes. The chat tables exist live.
- **Render API** — **configured but UNVERIFIED for this feature**: the code typechecks and its routes answer
  correctly when booted locally, but the deployed Render build predates the chat routes, so live
  `/api/chat/*` answers **404** until the operator redeploys. Render is external to this workspace and was
  not deployed or reconfigured.
- **Project Script AI (Kaggle kernel → Qwen → ngrok tunnel)** — **not attempted for chat**: no worker was
  ONLINE during this task, so the project-worker path was never exercised end-to-end. The code path is
  implemented against the notebook's real OpenAI-shaped endpoint (`{PUBLIC_URL}/v1/chat/completions`, the
  same route the notebook's own smoke-test cell calls), but that is *read from the repo*, not observed live.
- **Hosted fallback (OpenAI-compatible)** — **not attempted / not configured**: no `OPENAI_API_KEY` exists in
  the workspace or (as far as this workspace can tell) on Render. The code path exists and is typechecked.
- **Vercel web** — **unverified**: `/chat` renders in the local dev preview; the deployed Vercel build is only
  useful once Render serves the chat routes.

## 7. Known issues

- **The page is dead on the live site until Render redeploys.** Because the deployed API returns 404 for
  `/api/chat/*`, `/chat` shows the "TURN FAILED … HTTP 404" banner. This is the honest state, not a bug in
  the new code.
- **Happy path not observed end-to-end** — no worker was ONLINE and no hosted key exists, so no real model
  ever answered in this session. `applyStoreActions` was exercised against a fake client; `callAgent` was only
  typechecked (its failure branches were exercised through the 503 path).
- **A 1.7B model may not honour the JSON envelope.** That is handled honestly: prose is kept as the reply with
  `parse: "text_fallback"` and zero store writes, and the UI labels it ("prose reply (no JSON envelope)").
  Expect this to happen sometimes with Qwen3-1.7B.
- **Chat is not authenticated.** Like the rest of this API there is no end-user auth; anyone who can reach the
  API can chat. Registration on Render is also still open (`WORKER_REGISTRATION_TOKEN` unset).
- **`chat_rooms.project_id` is optional.** A room with no project can still ask the agent to create one; the
  page then binds the room to the new project automatically (implemented in `onSend`).
- **No streaming.** The turn returns when the model finishes (timeout 120s default). The UI shows an elapsed
  counter so a slow Kaggle answer is visible rather than looking hung.
- **Model switches are not enforced for chat** (same known gap as the rest of the app: a switched-off script
  model is only enforced where a runtime is started).

## 8. Decisions

1. **The project's own model is the primary backend** — the request said "the ai from the project", and the
   repo already knows how to find it (`workers.endpoint` registered by the notebook). No new vendor is
   required for the happy path, and no endpoint is hard-coded.
2. **The hosted fallback is optional and off by default.** Recommended provider for a fallback is OpenAI
   (OpenAI-compatible chat completions), wired through plain `fetch` — no new dependency was added to
   `apps/api/package.json`. It activates only if `OPENAI_API_KEY` is set.
3. **One JSON envelope instead of native tool-calling.** The project's runtime serves a small model behind a
   minimal FastAPI; native function-calling cannot be assumed. The envelope + tolerant parser degrades
   honestly instead of pretending a tool call happened.
4. **Additive-only allow-list, entities addressed by human handles.** No delete op exists, and no ids are
   round-tripped through the model — both reduce the blast radius of a small model's mistakes.
5. **The human message is persisted before the model is called.** A failed turn still shows what the director
   said; nothing is written to the transcript that the model did not say.
6. **Polling, not websockets.** Consistent with the existing dashboard (Runner/Agents poll); 3s transcript /
   6s store. Keeps the change small and works through the same Render API.
7. **DB access through the service role on the server only.** The browser never holds a key; `/chat` calls
   `NEXT_PUBLIC_API_URL` exactly like every other page.

## 9. Environment/configuration

- **Migration (already applied live):** `supabase/migrations/005_conversations.sql`. Re-running is safe.
- **No new required env var.** Optional ones (documented in `docs/API_ENV.md`, to be set **on Render** for the
  deployed API, and in the workspace `.env` for local runs):
  - `OPENAI_API_KEY` — enables the hosted fallback. **Not set anywhere.**
  - `OPENAI_CHAT_MODEL` (default `gpt-4o-mini`), `OPENAI_BASE_URL` (default `https://api.openai.com/v1`).
  - `AGENT_TIMEOUT_MS` (default `120000`, clamped 5s–300s), `AGENT_MAX_TOKENS` (default `900`, clamped 64–8192).
- Existing prerequisites unchanged: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` on Render (the chat routes
  reuse `requireSupabase`), plus `KAGGLE_API_TOKEN` / `KAGGLE_KERNEL_REF` for the worker itself.
- No secrets were added, read or printed in this task.

## 10. Next agent

**Redeploy the Render API and then exercise one real turn end-to-end.** Concretely:
1. Operator redeploys Render (Root Directory = repo root, `bun install`, build `bun --filter @ostra/api build`,
   start `bun --filter @ostra/api start` — see the deploy section of `docs/API_ENV.md`) so `/api/chat/*` stops
   returning 404; confirm `GET https://ostra-studio-1.onrender.com/api/chat/rooms` returns 200 (not 404).
2. Start the Script AI runtime from `/runtimes` (or Run Now) so a real `script` worker registers and
   heartbeats, then open `/chat`, create a room bound to a project, and send: *"Add two leads and episode one
   for a story about a calligrapher whose ink rewrites reality."* Verify the reply comes from
   `Qwen/Qwen3-1.7B · project runtime`, that the change chips appear, and that `/projects` shows the new rows.
3. If Qwen3-1.7B fails the JSON envelope often, the smallest useful improvement is a stronger few-shot example
   in `buildAgentSystemPrompt` (`packages/shared/src/agent/protocol.ts`) — the parser and executor need no change.

Prerequisite: a Render redeploy (this workspace cannot do it) and a worker that can actually stay ONLINE long
enough to answer (Kaggle keep-alive is bounded — see the previous handovers).

## 11. Do not redo

- Do not re-add a mock/canned agent, a placeholder assistant message, or a "simulated" success path: the 503/502
  contracts in `apps/api/src/routes/chat.ts` are deliberate.
- Do not add a delete operation to `AGENT_ACTION_OPS`; additive-only is a decision, not an oversight.
- Do not re-apply migration 005 (already live) and do not edit it — append a new migration instead.
- Do not replace `workerDisplayHealth`-based backend resolution with a hard-coded URL or a stored
  `KAGGLE_SCRIPT_URL` (that env var was deliberately removed from the architecture).
- Do not rewrite the existing Runner/Models/Agents pages to build this; `/chat` reuses the same conventions.

## 12. Verification

Unverified and must not be claimed as working:
- A real model answering a real chat turn (no worker was ONLINE, no hosted key configured).
- The live Render `/api/chat/*` routes (deployed build is older than this code; local boot only proved route
  mounting + the honest 503 when Supabase is unconfigured).
- The live Vercel `/chat` page against a redeployed Render API.
- Browser interaction on the deployed site (send, polling, auto-bind of a newly created project, store panel
  refresh). Only the server-rendered HTML of `/chat` and `/` on the Freebuff preview was inspected (both 200).
- Whether Qwen3-1.7B reliably emits the JSON envelope in practice.
