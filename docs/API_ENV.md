# API (Render) env — `apps/api`

Set these on Render (Environment tab). `SUPABASE_SERVICE_ROLE_KEY` is server-only — never set it as `NEXT_PUBLIC_*`.

```
# Supabase (required — migrations 001 + 002 + 003 + 004)
SUPABASE_URL=https://xxx.supabase.co
# aliases accepted:
SUPABASE_CONNECTION_STRING=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
# optional fallback:
SUPABASE_ANON_KEY=

# CORS — EXTRA origins allowed to call the API (comma-separated).
# https://ostra-studio-web.vercel.app, *.vercel.app previews and http(s)://localhost:* are ALWAYS allowed.
# `*` is never used (worker register/heartbeat are token-protected).
CORS_ORIGINS=https://ostra-studio-web.vercel.app

# --- Runtime Supervisor ---
SCHEDULER_ENABLED=true
SCHEDULER_TICK_MS=60000
CRON_SECRET=...                          # gates POST /api/runtime/tick
WORKER_REGISTRATION_TOKEN=...            # alias: WORKER_REGISTRATION_SECRET — gates POST /api/workers/register + /heartbeat
WORKER_REGISTRATION_SECRET=...           # alias for WORKER_REGISTRATION_TOKEN (either works)
WORKER_HEARTBEAT_TIMEOUT_SEC=90

# Kaggle Script AI — real execution via POST /api/v1/kernels/push (ApiSaveKernelRequest)
# NO KAGGLE_SCRIPT_URL: the supervisor pushes the kernel and waits for worker registration + heartbeat.
KAGGLE_API_TOKEN=...            # server-only, JSON {username,key} or username:key or KGAT_* Bearer, redacted
KAGGLE_API_TOKEN_1=...          # more Kaggle account tokens (each owns ONE account). Priority: plain name
KAGGLE_API_TOKEN_2=...          #   first, then _<n> in numeric order. Probed live before every push.
KAGGLE_API_TOKEN_<name>=...     #   A valid-but-empty account reports authenticated, owner unknown.
KAGGLE_KERNEL_REF=bettertrade/notebook7eae283a4a  # REQUIRED exact notebook ref (owner/slug)
KAGGLE_EXEC_DISABLED=false      # true => probe-only, no push

# Colab Image / Voice — real auto-start via POST https://colaboratory.googleapis.com/v1beta/runtimes
# When unset, starters truthfully return NOT_AUTOSTARTABLE/AUTH_FAILED — no fake start.
# provider_run_id is the real Operation name (operations/...); runtime creation != ONLINE until worker registers.
GOOGLE_CLOUD_PROJECT=...         # alias: COLAB_PROJECT_ID / GCP_PROJECT_ID / GOOGLE_PROJECT_ID — allowlisted GCP project
GOOGLE_OAUTH_TOKEN=...           # alias: COLAB_OAUTH_TOKEN / COLAB_ACCESS_TOKEN / GOOGLE_ACCESS_TOKEN — Bearer for scope https://www.googleapis.com/auth/colaboratory
COLAB_IMAGE_BOOTSTRAP_URL=...    # alias: COLAB_BOOTSTRAP_URL — mechanism that starts Image worker and makes it POST /api/workers/register
COLAB_VOICE_BOOTSTRAP_URL=...    # alias: COLAB_BOOTSTRAP_URL — same for Voice worker
COLAB_RUNTIME_SPEC=...           # optional spec id (validated via GET /v1beta/runtimespecs eligible)
COLAB_RUNTIME_ID=...             # optional runtimeId for POST ?runtimeId=…

# REMOVED: COLAB_IMAGE_URL / COLAB_VOICE_URL / KOKORO_VOICE_URL / KAGGLE_SCRIPT_URL
# are no longer read anywhere. Image/Voice state comes from the real Colab runtime + worker
# registration; Script state comes from the Kaggle push lifecycle. Stale values are ignored.

# YouTube OAuth (Phase 9)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=

# Orchestrator
AUTO_PUBLISH=false
PORT=3001
```

### Model switches — `GET /api/models` / `PATCH /api/models/:key`

Backed by the `model_controls` table (migration `004_model_controls.sql`). No new env vars.

```
GET   /api/models            → { models: [{ key, providerId, modelRef, label, provider, runtime,
                                            enabled, dispatch, health, liveModel, note, updatedAt, updatedBy }],
                                 counts: { total, enabled, disabled, ready }, source: "supabase", timestamp }
PATCH /api/models/:key       → body { enabled: boolean, note?: string }  → { model, changed, actor }
```

- Catalog keys live in `packages/shared/src/providers/models.ts`: `script-qwen3-4b`, `image-qwen3-4b`,
  `voice-qwen3-4b`, `overseer-qwen3-4b`, `video-ffmpeg`, `youtube-youtube-api`. Unknown key → `404` + `known`;
  non-boolean `enabled` → `400`; Supabase unreadable → `503` + `reason` (never a list that assumes "all on").
- Switches stored under the retired keys (`script-qwen3-1-7b`, `image-colab-image`, `voice-kokoro-82m`)
  still count for the entry that replaced them (`LEGACY_MODEL_KEYS`); a current key always wins.
- `provider` / `runtime` / `liveModel` come from the live worker row when one exists, so a slot reports
  the runtime and model its worker actually registered with — never the planned one.
- Only `script` has `autostart: true`. `POST /api/runtime/run-now` refuses the other slots with
  `409 not_autostartable` and the real reason, so a click can never re-push the Script AI kernel as
  another agent.
- `dispatch` is derived, not stored: `READY` = switch ON **and** `health.status === "ONLINE"`.
  The switch never changes `health` — switching a model off cannot make it look ONLINE, and switching it
  on cannot make it look usable.
- Enforced in `apps/api/src/lib/scheduler.ts` (`schedulerTick` + `runNowByWorker`, the only paths that
  start an external runtime): a switched-off model returns `skipped_disabled` and records
  `runtime_startup_history.result = 'skipped_disabled'` / `error_code = MODEL_DISABLED`.
- Fail-open: if `model_controls` does not exist yet the supervisor logs the read error and allows the run.

### Agent Chat — `GET|POST /api/chat/rooms` · `/api/chat/rooms/:id/messages` · `/api/chat/store`

Backed by the `chat_rooms` + `chat_messages` tables (migration `005_conversations.sql`). A room is the
transcript between the human director and the Script AI; the AI can also write to the store.

```
GET   /api/chat/rooms                 → { rooms: [{ id, project_id, title, created_at, updated_at }], timestamp }
POST  /api/chat/rooms                 → body { project_id?: uuid|null, title?: string } → 201 { room }
PATCH /api/chat/rooms/:id             → body { project_id?: uuid|null, title?: string } → { room }
GET   /api/chat/rooms/:id/messages    → { room, messages: [...], agent: <AgentStatus>, timestamp }
POST  /api/chat/rooms/:id/messages    → body { content: string, note?: string } (≤ 8000 chars)
GET   /api/chat/store?projectId=      → { projects: [{id,slug,title}], snapshot }
```

### AI Studio — `GET /api/agents/roster` · `/api/agents/rooms*` · `POST /api/agents/rooms/:id/dispatch`

Backed by migration `007` (`chat_rooms.kind='studio'` + the `agent_messages` table). This is the
**agent-to-agent** channel: Script AI, Image AI and Voice AI coordinate on a project, and the Showrunner
(`overseer`) reports the real status to the director. The orchestrator mediates every message — nothing
is a hidden model-to-model conversation.

```
GET   /api/agents/roster                  → { roster: [{ kind, label, workerType, specialty, accent,
                                                  available, provider, model, endpointHost, detail, candidates }] }
GET   /api/agents/rooms                   → { rooms: [{ id, project_id, title, kind, … }] }
POST  /api/agents/rooms                   → body { project_id?: uuid|null, title?: string } → 201 { room }
PATCH /api/agents/rooms/:id               → body { project_id?: uuid|null, title?: string } → { room }
GET   /api/agents/rooms/:id/messages      → { room, messages: <agent_messages[]>, roster, timestamp }
POST  /api/agents/rooms/:id/dispatch      → body { brief?: string (≤8000 chars), note?: string, overseer?: bool }
                                          → { turns: <AgentTurnResult[]>, changed, failedWrites, messages, roster }
```

`POST .../dispatch` persists the director's `brief` first (to `director → script`, kind `brief`), then
runs each production agent **once, in order** (`script → image → voice`), then the Showrunner. Each agent
is called only when its worker is genuinely ONLINE; an offline agent's turn is reported as `ok:false`
with its real reason, and its inbox stays `sent` (never marked delivered to a model that was not asked).
An agent's envelope is `{"reply": …, "messages": [{"to":"image","kind":"request","content":…}], "actions": […]}`
— `reply` goes to the director, `messages` go to peers. Store writes use the same additive allow-list as
Agent Chat (audited in `events` as `agent.store_change`, actor `agent:<role>`). The Showrunner uses a
dedicated `overseer` worker when one is ONLINE, else the Script AI worker; the roster `detail` always
says which one answered.

`POST …/messages` is one turn: the human message is stored **first**, then the model is called with the live
store snapshot in its system prompt, then the requested store writes are applied, then the assistant row is
written with what actually changed. Response:

```jsonc
{
  "user_message": { "id": "…", "role": "user", "content": "…" },
  "message": { "id": "…", "role": "assistant", "content": "…",
               "reasoning": "…",   // the model's thinking for this turn, or null when it did not think
               "actions": [ { "op": "create_character", "ok": true, "entity": "character",
                              "ref": "character:Kai", "id": "…", "summary": "Created character \"Kai\"" } ],
               "backend": { "kind": "project_worker", "provider": "kaggle", "model": "Qwen/Qwen3-1.7B",
                            "endpointHost": "…ngrok.app", "latencyMs": 4200, "parse": "json" } },
  "applied": [ … ], "store": { "changed": 1, "failed": 0 },
  "backend": { … }, "agent": { … }, "rejected": [ "delete_scene" ]
}
```

Failure codes are truthful and never accompanied by an invented answer:
- `503 { error: "NO_AGENT_BACKEND", reason, user_message, agent }` — no worker ONLINE and no hosted key.
  The human message is still saved; no assistant row is written.
- `502 { error: "UNREACHABLE"|"TIMEOUT"|"HTTP_ERROR"|"EMPTY_RESPONSE", reason, user_message, backend, agent }`
  — the backend was chosen but the call failed. Again: no assistant row, no placeholder text.
- `503 { error: "Supabase not configured", reason, hint }` — as everywhere else in this API.

Which real model answers (`apps/api/src/lib/agentRuntime.ts`):
1. **Project worker (preferred, no key needed)** — the `script` worker that `workerDisplayHealth` reports
   ONLINE (fresh heartbeat) and that registered an `endpoint`. Called at `{endpoint}/v1/chat/completions`
   (OpenAI-shaped, what the Kaggle notebook serves) with the `ngrok-skip-browser-warning` header.
2. **Hosted fallback (optional)** — `POST {OPENAI_BASE_URL}/chat/completions` with `OPENAI_API_KEY`, used
   only when no project worker is ONLINE. `OPENAI_BASE_URL` also lets any OpenAI-compatible server stand in.
3. **Nothing** — reported honestly as above.

Agent behaviour (`packages/shared/src/agent/protocol.ts`): the model must answer with one JSON object
`{ "reply": "…", "actions": [ … ] }`. `parseAgentResponse` tolerates fenced JSON, `action`/`arguments`
aliases and flattened arguments, falls back to treating the whole answer as prose (`parse: "text_fallback"`),
and reports any op outside the allow-list in `rejected`. The allow-list is **additive only** — there is no
delete op, so chat can never destroy a row or an artifact. Store writes go through the same column
allow-lists as the REST routes (`apps/api/src/lib/storeActions.ts`) and each success inserts an
`events` row of type `agent.store_change`.

**Thinking is separated from the answer.** The Qwen3 worker thinks by default, and its thinking arrives
inline in `choices[0].message.content` as ` thinking…</think>` before the JSON envelope; other
OpenAI-compatible servers instead return a `reasoning_content` / `reasoning` / `thinking` field (read in
`apps/api/src/lib/agentRuntime.ts`, returned as `AgentChatResult.reasoning`). `splitReasoning` in
`packages/shared/src/agent/protocol.ts` cuts the thinking off **before** the envelope is looked for — so
reasoning that contains braces can never be mistaken for the JSON reply — and `parseAgentResponse` returns
it as `AgentReply.reasoning` alongside `reply`/`actions`. It is stored in `chat_messages.reasoning`
(migration `006_chat_reasoning.sql`) and shown in the room as a collapsed **THINKING** block above the
answer. When the model answers without thinking, `reasoning` is `null`/empty and no block is rendered — a
thinking trace is never invented. An unterminated ` thinking` (the model ran out of tokens mid-thought) is
kept as reasoning with an empty reply, and the assistant row says so instead of presenting half a thought
as the answer. Note: thinking is not fed back into the next turn's history — only the answers are.

Extra env vars (all optional — the room works with the project's own worker alone):

```bash
# Hosted fallback used ONLY when no Script AI worker is ONLINE. Add on Render to enable it.
OPENAI_API_KEY=
OPENAI_CHAT_MODEL=gpt-4o-mini          # default
OPENAI_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible server
# Turn budget (clamped): 5s..300s, 64..8192 tokens
AGENT_TIMEOUT_MS=120000
AGENT_MAX_TOKENS=900
```

The dashboard page is `/chat` (nav: **Agent Chat**): transcript + composer on the left, rooms and the live
store panel on the right. The transcript polls every 3s and the store panel every 6s, so a change made in
another tab shows up without a reload. Each assistant message with a thinking trace renders it in a
collapsible **THINKING** block (word count in the summary) directly above the answer it belongs to.

### Kaggle auto-start (real, not probe-only) — `KaggleRuntimeStarter`

`GET /api/v1/kernels/list?pageSize=1` (auth gate) → `GET /api/v1/kernels/pull?user_name={owner}&kernel_slug={slug}` (kernel source + `metadata.currentVersionNumber`) → `POST /api/v1/kernels/push` via `ApiSaveKernelRequest{ slug, newTitle, text, language, kernelType, isPrivate, enableInternet, enableGpu/Tpu, … }` → `ApiSaveKernelResponse{ versionNumber, url, ref }` → `provider_run_id = ref@vN` (`bettertrade/notebook7eae283a4a@vN`). A bare `notebook7eae283a4a` is resolved via `resolveKaggleKernelRef()` → `GET /api/v1/kernels/list?group=profile&search=`; a ref with a slash bypasses that search. `/api/v1/kernels/list` rejects `mine=true` (HTTP 400) and `GET /api/v1/kernels/{owner}/{slug}` returns the HTML site page (404), so neither is used any more. `KGAT_*` tokens authenticate as `Bearer`. The push reply's `ref` is the **site form** `"/code/owner/slug"` (verified live), so `canonicalizeKernelRef()` normalizes it back to `owner/slug` before building `provider_run_id = owner/slug@vN` (the raw value is kept as `provider_response.providerRef`). If the kernel source cannot be read the starter fails with the real HTTP status and never calls push. Read-only credential check: `bun run verify:kaggle --kernel-ref=bettertrade/notebook7eae283a4a`. A push only *requests* a run: ONLINE additionally requires the notebook's bootstrap cell (`scripts/kaggle-worker-bootstrap.py`) to register and heartbeat — keep the live notebook in sync with `bun run sync:notebook --apply`.

### Other agents on Kaggle — `scripts/kaggle-agent-notebook.ts`

Image AI, Voice AI and the Showrunner now have their own Kaggle notebooks, generated entirely from repo
sources: `bun scripts/kaggle-agent-notebook.ts --agent=image --agent=voice --agent=overseer` (dry run) and
`… --apply` to create/update the private kernels `bettertrade/ostra-{image,voice,overseer}-agent`. Each
notebook composes the install cell, a FastAPI OpenAI-compatible chat server on `:8000` (the exact contract
`agentRuntime.ts` calls), a readiness gate, the ngrok tunnel and `scripts/kaggle-agent-bootstrap.py` with
**that agent's identity substituted** (`OSTRA_AGENT = "image"`), so it registers as worker type
`image` / `voice` / `overseer` and heartbeats. Nothing is faked: if the model fails to load, the server
is down, the tunnel check records the real failure and the agent never comes ONLINE. The notebooks are
created from the repo, so re-running the script refreshes them.

**Multiple Kaggle accounts.** Every token owns exactly one account; the script reads
`KAGGLE_API_TOKEN` then numbered/named tokens (`KAGGLE_API_TOKEN_1`, `_2`, …) via `kaggleApiTokens()`,
probes the real account with an authenticated list call (kernels → datasets → models), and REFUSES to
push when the probed owner does not match the target `--owner`/`--kernel-ref`. Flags: `--list` (all
accounts, or `--list --token=<n>`), `--token=<n>` to pin ONE agent to one account, `--agent=all` to map
agent #i → token #(i+1) (wrapping when there are more agents than tokens). A valid token whose account
owns nothing (fresh account) reports authenticated with no owner; pushing there requires an explicit
`--owner=<account>`, and Kaggle rejects a wrong account with a real 403. Never guesses an owner from a
token's shape.

Kaggle secrets each agent needs (Kaggle → Add-ons → Secrets; **not** the Render/Vercel env):
`NGROK_AUTHTOKEN_IMAGE` / `NGROK_AUTHTOKEN_VOICE` / `NGROK_AUTHTOKEN_OVERSEER` (each from a different
ngrok account, since a free ngrok plan allows one simultaneous tunnel), falling back to a shared
`NGROK_AUTHTOKEN`; plus `WORKER_REGISTRATION_TOKEN` only if Render sets it. The Showrunner's kernel is
`bettertrade/ostra-showrunner-agent` (the `overseer` slug is presented as Showrunner so its Kaggle title
is unique). Verified 2026-09-30: all three notebooks boot the model, serve `/health` and register; they
register reachable only once an ngrok token is present.

### Colab auto-start (real API, truthful when not allowlisted) — `ColabImageRuntimeStarter` / `ColabVoiceRuntimeStarter`

Both `autostartable=true` so the scheduler can attempt; missing `GOOGLE_CLOUD_PROJECT`→`NOT_AUTOSTARTABLE`, missing `GOOGLE_OAUTH_TOKEN`→`AUTH_FAILED`, missing bootstrap→`NOT_AUTOSTARTABLE` (notebook URL is not an execution method), spec `eligible=false`→`NOT_AUTOSTARTABLE`, `GET /v1beta/runtimespecs` allowlist check. On success, `POST /v1beta/runtimes` → `Operation{ name: operations/... }` → real `provider_run_id`.

Supabase migrations (run once, idempotent, in order):
- `supabase/migrations/001_initial.sql`
- `supabase/migrations/002_runtime_supervisor.sql`
- `supabase/migrations/003_runtime_supervisor_extensions.sql`
- `supabase/migrations/004_model_controls.sql`
- `supabase/migrations/005_conversations.sql` (Agent Chat rooms + messages)
- `supabase/migrations/006_chat_reasoning.sql` (adds `chat_messages.reasoning` — the model's thinking)
- `supabase/migrations/007_agent_channel.sql` (adds `chat_rooms.kind` + the `agent_messages` channel table)
- `supabase/migrations/008_overseer_worker_type.sql` (widens `workers_type_check` to allow `overseer`)

Storage bucket: `ostra-assets`

## Render build & start (deploy config)

Render hosts `apps/api` from this Bun workspace. Known-good service settings:

- **Root Directory:** repository root (the workspace root), **not** `apps/api` — `@ostra/shared`
  is a sibling workspace package resolved via the API's tsconfig `paths` (`../../packages/shared/src/index.ts`).
- **Runtime:** Node **≥ 20.6** (`node --import tsx` requires Node 20.6+; Node 24 is verified). Declared in
  `engines.node` on the root and `apps/api` `package.json`.
- **Build Command:** `bun install && bun --filter @ostra/api build` (`build` = `tsc --noEmit`, a typecheck — it emits no files).
- **Start Command:** `bun --filter @ostra/api start` (equivalently, from `apps/api`: `node --import tsx src/index.ts`).
- `PORT` is injected by Render; the app binds `0.0.0.0:$PORT` (local default `3001`).
- The workspace root also exposes `bun start` → `bun --filter @ostra/api start`, so a package-manager
  default start command (`npm start` / `yarn start` / `bun start`) resolves to the API rather than failing.

### Deploy-failure checklist

- **Only `bun.lock` ships** (no `package-lock.json`/`yarn.lock`). Use `bun install`; `npm ci` fails outright.
- **`tsx` is a devDependency.** Never install with `--omit=dev`/`--production`, or `node --import tsx`
  cannot resolve the loader and the service exits at start.
- **Never resolve TypeScript globally** (`npx tsc` / `bunx tsc` without a local install). The current
  `typescript@latest` is **7.x**, which **removed `baseUrl`** and fails the build with
  `error TS5102: Option 'baseUrl' has been removed`. The tsconfigs no longer set `baseUrl` (redundant
  since TS 4.1 — `paths` resolve relative to the config file), so any TS ≥ 4.1 works.
- A build that typechecks green locally but fails on Render almost always means an **unpinned tool**
  (global TS) or an **install that dropped devDependencies** — not a source error.
- **Exit 127 at the START step, after `Build successful 🎉`, with
  `bash: line 1: Yarn: command not found`** (observed 2026-09-30) — the service's **Start Command** is
  unset or wrong, so Render fell back to a Yarn default it cannot run (the repo ships only `bun.lock`).
  Fix: set **Start Command** to `bun --filter @ostra/api start` in the Render dashboard. Render is
  operator-managed and there is **no `render.yaml`** in this repo, so this cannot be fixed in source; a
  failed start also means the previous deploy keeps serving, i.e. the change is not live yet.

## Health contract

`GET /health` and `GET /api/health` return the identical envelope; `GET /api/providers` returns the same
object so the dashboard has one parser:

```jsonc
{
  "ok": false,                // true only when Supabase is ONLINE and no provider is in ERROR
  "status": "DEGRADED",       // ONLINE | DEGRADED | ERROR  (the backend itself)
  "app": "ostra-api",
  "host": "render",
  "autoPublish": false,
  "supabase": { "ok": true, "status": "ONLINE", "provider": "supabase", "latencyMs": 41, "reason": "connected via SUPABASE_URL", "checkedAt": "…" },
  "providers": {
    "script":  { "id": "script",  "provider": "kaggle",       "runtime": "kaggle", "health": { "ok": false, "status": "NOT_CONFIGURED", "reason": "Set KAGGLE_API_TOKEN and KAGGLE_KERNEL_REF on Render", "checkedAt": "…" } },
    "image":   { "id": "image",   "provider": "colab-image",  "runtime": "colab",  "health": { … } },
    "voice":   { "id": "voice",   "provider": "kokoro-82m",   "runtime": "colab",  "health": { … } },
    "video":   { "id": "video",   "provider": "ffmpeg",       "runtime": "local",  "health": { … } },
    "youtube": { "id": "youtube", "provider": "youtube-api",  "runtime": "api",    "health": { … } },
    "storage": { "id": "storage", "provider": "supabase-storage", "runtime": "supabase", "health": { … } }
  },
  "timestamp": "2026-09-28T04:20:00.000Z",
  "at": "2026-09-28T04:20:00.000Z"   // deprecated alias of timestamp
}
```

Derivation (see `packages/shared/src/providers/health.ts`):
fresh worker heartbeat → `ONLINE`; in-flight startup (< 20 min) with no worker → `STARTING`; existing but
stale/failed worker → `OFFLINE`/`ERROR`; missing credentials → `NOT_CONFIGURED`; failed/timed-out last attempt
→ `ERROR`; configured and idle → `OFFLINE`. Provider checks are bounded and isolated — one dead provider never
suppresses the rest.

`GET /api/workers` returns `{ workers: [...], source: "supabase", timestamp }` where each row carries a
derived `health` (`workerDisplayHealth`) so the dashboard cannot show a stale row as ONLINE. When Supabase is
not configured it returns `503` with `error` + `reason` (never a fake offline worker list).

New tables (002+003):
- `runtime_schedules` — persisted schedules (local_time + timezone + days_of_week + startup_mode + cooldown + max_attempts)
- `runtime_startup_leases` — persisted startup lease/lock (survives Render restart; partial unique one_active)
- `runtime_startup_history` — auditable history with full lifecycle: startup_request_id, worker_id, provider_run_id, started_at/registered_at/completed_at, status (REQUESTED→STARTING→REGISTERING→ONLINE / FAILED / TIMEOUT / CANCELLED), error_code/error_message, metadata
- `workers` extended with endpoint, registered_at, last_seen_at, heartbeat_timeout_sec, worker_id, error_code, error_message, metadata, current_task
