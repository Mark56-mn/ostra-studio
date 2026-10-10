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
KAGGLE_KERNEL_REF=bettertrade/notebook7eae283a4a  # Script AI's notebook ref (owner/slug). REQUIRED to start Script.
KAGGLE_EXEC_DISABLED=false      # true => probe-only, no push

# Per-agent Kaggle notebooks. Each agent pushes ITS OWN notebook; there is NO fallback to
# KAGGLE_KERNEL_REF, because re-pushing the Script kernel as another agent is forbidden. A slot whose
# ref is unset is refused by name (409 not_autostartable) — never started with somebody else's kernel.
# Run scripts/kaggle-agent-notebook.ts --agent=<slot> --apply to create/refresh the notebook, then set
# its ref here. Owner/slug is preferred; the starter picks the configured token whose account owns it.
KAGGLE_KERNEL_REF_IMAGE=<owner>/ostra-image-agent        # Image AI (Run Now / scheduler)
KAGGLE_KERNEL_REF_VOICE=<owner>/ostra-voice-agent        # Voice AI
KAGGLE_KERNEL_REF_OVERSEER=<owner>/ostra-showrunner-agent  # Showrunner (overseer)
KAGGLE_API_TOKEN_IMAGE=...      # optional: slot-labelled token (same shape as KAGGLE_API_TOKEN_<name>)
KAGGLE_API_TOKEN_VOICE=...      #   Wins over the numbered/named list for that slot only.
KAGGLE_API_TOKEN_OVERSEER=...   #   <SLOT>_KAGGLE_API_TOKEN (e.g. IMAGE_KAGGLE_API_TOKEN) also works.

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

# --- Management Team (hosted, OpenAI-compatible) ---
# A planning agent the director talks to. It briefs Script/Image/Voice and the Showrunner through the
# real channel, writes the store, and — only with autonomy=full — asks the supervisor to start a
# runtime. Any OpenAI-compatible endpoint works; only base_url + bearer key are used (no SDK).
MANAGER_API_KEY=...                 # required for the slot to exist; OPENAI_API_KEY is the fallback
MANAGER_BASE_URL=https://lightning.ai/api/v1/   # any OpenAI-compatible base; OPENAI_BASE_URL fallback
MANAGER_CHAT_MODEL=openai/gpt-5.6-luna          # model id that endpoint expects
MANAGER_AUTONOMY=instruct           # off (default) | instruct | full — unknown values grant nothing
```

`MANAGER_API_KEY` is the only required one; the other two fall back to `OPENAI_*`, so an operator who
already has a hosted key needs no second key. Health is **not** derived from these variables: the slot
is reported `ONLINE` only after a real, tiny completion call succeeds (`probeHostedModel`, cached 60s),
`ERROR` with the real reason when that call fails, and `NOT_CONFIGURED — Set MANAGER_API_KEY …` when no
key exists. A key alone never makes it ONLINE.

`MANAGER_AUTONOMY` is the whole autonomy gate, and it is enforced server-side per requested target:
- `off` (default) — the model may talk, but any `start` it asks for is refused with that reason.
- `instruct` — it may brief every agent including the Showrunner, but not start runtimes.
- `full` — it may additionally request a start; each target is still checked against the real autostart
  path (`autostartRefusal`) and runs through the same `runNowByWorker` the Run Now button uses.

```bash
# --- NVIDIA NIM — hosted backup for every agent (optional) ---
# An OpenAI-compatible, free-tier endpoint (build.nvidia.com → Get API Key; keys look like nvapi-...).
# When set, it becomes the backup every agent slot answers from when its own runtime is not ONLINE, and
# it can be forced for all of them from /models (provider routing). The key is server-only: it becomes
# an Authorization header and is never returned to a client.
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1   # default; only an allowlisted NVIDIA host is accepted
NVIDIA_CHAT_MODEL=nvidia/nemotron-3-super-120b-a12b    # default; must be in the vetted catalog
NVIDIA_MODEL_SCRIPT=                                   # optional per-slot override (…_IMAGE/_VOICE/_OVERSEER/_MANAGER)
NVIDIA_THINKING=true                                   # request reasoning where the model documents a switch
NVIDIA_RATE_LIMIT_PER_MIN=20                           # local free-tier guard (1..600)
```

Model ids are restricted to the vetted catalog in `packages/shared/src/providers/nvidia.ts`.
Every entry there was verified **callable** on this key on 2026-10-08 with a real completion (a listed
model is not necessarily a model your key can call — see below):

| id | verified 2026-10-08 |
| --- | --- |
| `nvidia/nemotron-3-super-120b-a12b` | **the default**; ~1.1s, answers with `enable_thinking` and returns a reasoning channel |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | ~3.4s, same switch |
| `nvidia/nemotron-3-ultra-550b-a55b` | ~15s; one probe that day hit `503 Service temporarily overloaded` |
| `openai/gpt-oss-20b` | fastest lane, ~0.9s; returns reasoning without any template kwarg |
| `moonshotai/kimi-k3` | ~29s — callable but the slowest measured |

An id outside the catalog is refused with the allowed list rather than forwarded, and the key is only ever
sent to `integrate.api.nvidia.com` / `api.nvidia.com` even if `NVIDIA_BASE_URL` says something else.
Switching the routing mode to `nvidia` does **not** make it ONLINE: a real completion probe (cached 60s)
decides, and the result is reported verbatim.

**Retired / unavailable ids are permanent verdicts, not bad afternoons.**
- `meta/llama-3.3-70b-instruct` (this project's original default) was end-of-lifed on `2026-08-26`;
  NVIDIA answers `410 Gone` for it forever. It, plus `meta/llama-3.1-8b-instruct`,
  `qwen/qwen3-next-80b-a3b-instruct`, `deepseek-ai/deepseek-r1` and `qwen/qwen2.5-coder-32b-instruct`
  (all confirmed absent from the live `GET /v1/models` on 2026-10-08), live in `NVIDIA_RETIRED_MODELS`
  with a successor each — so a stale pin fails as `MODEL_RETIRED`, refused **before** any request is sent
  (no call, no rate-limit token), naming the id, its EOL date and the successor to pin.
- A NIM `404` (`Function … not found for account`) means the id is listed but **this key cannot call it**;
  that is `MODEL_UNAVAILABLE`, a different fact from a retirement and reported as such.
- Neither is ever reported as a retryable `HTTP_ERROR`, and neither is silently swapped for a model the
  operator did not choose. Re-pinning is one env var: `NVIDIA_CHAT_MODEL` (all slots) or
  `NVIDIA_MODEL_<SLOT>` (one agent).

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

### Management Team — `GET /api/agents/management` · `POST /api/agents/rooms/:id/manage`

A fifth role: a **hosted** planning model the director talks to. It is not a worker row and never
heartbeats, so it is absent from `/api/workers` and resolved by `resolveManagerBackend()`.

```
GET  /api/agents/management            → { autonomy, available, provider, model, endpointHost, detail,
                                          startable: [{ target, ok, error? }], timestamp }
POST /api/agents/rooms/:id/manage      → body { brief?: string (≤8000 chars), note?: string }
                                        → { turn, autonomy, messages, roster }
                                        503 { error: "NO_MANAGEMENT_BACKEND", reason, turn } when unconfigured
```

One `manage` call = one turn: the brief is stored first, then the model is called with the real channel
and the real store, and **only what it actually emitted** is persisted — peer `messages` (kind
`instruction` included), additive `actions`, and the `start` list. `turn.starts` reports the supervisor's
real answer per target (`requested`, `refused_autonomy`, `not_autostartable`, `skipped_*`, …); a refusal is
data, not a hidden error.

`POST /api/agents/rooms/:id/dispatch` now runs the management turn FIRST (`manager: false` opts out), so its
instructions are in the inbox of every agent the round calls next. An unconfigured management team is skipped
silently in the round and reported by `GET /api/agents/management` instead of adding a failing turn.

`rosterModels()` in `scripts/kaggle-model-benchmark.ts` skips hosted roles: the management team is never a
Kaggle GPU candidate.

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
another tab shows up without a reload. Each message with a thinking trace renders it in an **expanded**
**THINKING** block (word count in the summary) directly above the message it belongs to — the same
component is used by the production channel on `/studio`. See `AGENT_CONTRACTS.md` → "Conversation-thinking
exception" for why this is allowed and how it stays bounded.

**Auto-work** (the toggle beside **Send**) is the operator's grant to let the AI work without a human in
the middle. It is implemented in the browser (`apps/web/src/lib/autoloop.ts` holds the policy, the chat page
runs the driver) and uses no extra API: after each answer the page POSTs one more real
`/api/chat/rooms/:id/messages` turn — the instruction `continuePrompt()` builds — so every step is an
ordinary, audited transcript row and closing the tab loses no work. The loop always ends with a real
reason on screen, from exactly five causes: the model's own `LOOP DONE` reply, the 10-step cap, the
rate-limit/error budget (`AUTOLOOP_MAX_RATE_LIMIT_WAITS`, `AUTOLOOP_MAX_ERROR_RETRIES`, and a 429 that asks
for more than `AUTOLOOP_MAX_WAIT_MS` stops immediately — the backend's `retry_after_sec` is honoured, never
hammered), the human pressing **Stop** (`CONSTRAINTS.md` 25), or the human switching to another room (the
loop works the room it started in and will not write where nobody is looking). It runs only while the page
is open — there is no server-side queue and none is implied.

### Seasons — the season-first approval gate — `GET|POST /api/seasons` · `/api/seasons/:id/submit` · `/api/seasons/:id/decision`

```
GET   /api/seasons?projectId=      → { seasons: [...], gates: { [projectId]: ProductionGate }, timestamp }
POST  /api/seasons                 → body { project_id, package } → 201 { season, gate }  (400 SEASON_PACKAGE_INVALID + every problem)
GET   /api/seasons/:id             → { season, gate }
PATCH /api/seasons/:id             → body { package } → { season, gate }   (409 SEASON_LOCKED once approved)
POST  /api/seasons/:id/submit      → { season, gate }                      (409 SEASON_NOT_SUBMITTABLE)
POST  /api/seasons/:id/decision    → body { decision: approved|changes_requested|rejected, note?, decided_by? }
                                    → { season, gate }   (409 SEASON_NOT_DECIDABLE)
```

The **production gate** is enforced where it matters: `POST /api/tasks` with `worker_type` in
`image | voice | video | youtube` resolves the task's project (through the episode/scene when needed) and
refuses with **409 `SEASON_NOT_APPROVED`** + `season_status` + the reason, until a season for that project is
`approved`. `script` tasks are deliberately not gated — the story has to be written before it can be approved.
The decision logic is pure (`packages/shared/src/domain/seasons.ts`, 17 tests): only a human decision on a
`submitted` season can approve, and nothing in the codebase can approve a season by itself.

### Notifications — `GET /api/notifications` · `POST /api/notifications/:id/read`

In-app inbox, migration `010`. Raised by real state changes: a season submitted (`requires_action: true`),
a season decided, a task failed (once per task, via `dedupe_key`). `GET` returns `{ notifications, unread }`.

### Media generation — `GET /api/media/providers` · `POST /api/media/generate` · `POST /api/media/probe`

Server-side only: requires `NVIDIA_API_KEY`; the browser only ever sees `nvidia_key_configured: true|false`.

```
GET   /api/media/providers  → { providers: [{ key, model, capability, host, tier, media_type, limits, note }],
                                 nvidia_key_configured, availability, timestamp }
POST  /api/media/generate   → body { capability: text2image|image2video|tts, prompt, image_base64?, image_media_type?,
                                      resolution?, num_frames?, fps?, language?, voice?, project_id?, scene_id? }
                              → 200 { base64, media_type, model, provider, latency_ms, bytes }  (bytes are NOT stored in the DB)
                              → 429 + Retry-After (RATE_LIMITED) | 503 (NO_API_KEY) | 502 (NOT_AUTHORIZED | UPSTREAM_ERROR | BAD_OUTPUT)
POST  /api/media/probe      → body { capability } → { available, bytes, latency_ms, code, reason, checked_at }
```

Live-probed from this account's key on 2026-10-09: **TTS is available** (HTTP 200, real WAV);
**image and image-to-video are NOT enabled for this account** (HTTP 404 on every visual route, while the
same host returns proper 400s for malformed requests). The adapters stay wired so enabling a model on
build.nvidia.com works with no code change; until then the real 404 is reported, never a fabricated asset.

### Provider routing — `GET /api/routing` / `PATCH /api/routing`

Which model family answers each agent. Backed by the `provider_routing` table (migration
`009_provider_routing.sql`, one row). No required env vars — the vars above decide what is *possible*;
this route decides what is *used*.

```
GET   /api/routing   → { settings: { mode, slots, updatedAt, updatedBy }, read_reason,
                         nvidia: { configured, host, model, thinking, reason, health, catalog[] },
                         slots: [{ slot, mode, available, kind, provider, model, endpointHost, detail }] }

PATCH /api/routing   → { mode }                        # own | auto | nvidia
                       { slot, slotMode }              # per-agent override; slotMode=null inherits
                     → the same payload + { changed, actor }
```

`mode` values:
- `own` — only project runtimes may answer. Nothing ONLINE ⇒ the room says so (no hosted model is used).
- `auto` (default) — the project's own worker when it is genuinely ONLINE, otherwise the hosted backup
  (NVIDIA NIM first, then `OPENAI_*`).
- `nvidia` — every slot answers through NVIDIA NIM, even while a runtime is ONLINE.

The `slots` rows are produced by the same resolver the agents use (`resolveChannelBackend`), so the page
shows what will really happen, and each change is audited as `events.type='routing.changed'`.
Consequences: chat turns answered by the NVIDIA backup are rate-limited per minute and answer
`429 RATE_LIMITED` with a real `Retry-After` (see `apps/api/src/lib/rateLimit.ts`).

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
