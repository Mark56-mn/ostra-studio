# HANDOFF — 2026-09-30 — Agent Chat: show the model's thinking separately from its answer

## 1. Task

> "I need you to separate the ai thinking from it actually response I should be able to see it
> thinking/reasoning and also it's answer just like in this environment in freebuff"

Translation into this repository: in the Agent Chat room (`/chat`), the Script AI's reasoning must be
shown as its **own** thing, distinct from the reply the director reads — the way a coding agent shows a
collapsible "thinking" block above its answer. `CONSTRAINTS.md` still applies: the trace must be the
model's **real** output, never synthesised, and there must be no block at all when the model did not think.

## 2. Result

Implemented, typechecked, linted, unit-tested, and the DB column is applied. **Not** exercised end to end
against the live model (the Kaggle tunnel was OFFLINE throughout this session — see §6/§12).

Shipped:
- **Shared protocol** (`packages/shared/src/agent/protocol.ts`) — `splitReasoning()` (pure, tested) cuts
  Qwen3's inline ` thinking…</think>` out of `content` *before* the `{"reply","actions"}` envelope is
  parsed, so reasoning that contains braces can no longer be mistaken for the reply (that is a real bug
  fix, not just cosmetics). `combineReasoning()` merges the inline trace with a server-supplied channel.
  `AgentReply` gained `reasoning: string`. `parseAgentResponse(raw, explicitReasoning?)` returns it, and
  also accepts a `reasoning` / `reasoning_content` / `thinking` key **inside** the envelope (a server held
  to `response_format: json_object` can only express thinking there).
- **API runtime** (`apps/api/src/lib/agentRuntime.ts`) — new `readReasoning()` reads
  `choices[0].message.reasoning_content` / `.reasoning` / `.thinking`; `AgentChatResult` ok-branch gained
  `reasoning: string | null`. `null` when the server sent none. Nothing is invented.
- **Orchestration** (`apps/api/src/routes/chat.ts`) — one turn now passes both channels to the parser and
  stores the trace in the new column. When the model thought but produced no answer (ran out of tokens
  mid-thought) the assistant row says `(no final answer — the model's thinking is attached)` instead of
  presenting half a thought as the reply.
- **Migration `006_chat_reasoning.sql`** — `alter table chat_messages add column if not exists reasoning
  text` + a column comment. **Applied to live Supabase** via `node scripts/apply-migration.mjs` →
  `APPLIED OK` (the statement is a plain `ADD COLUMN IF NOT EXISTS`, so a successful run means the column
  exists).
- **Frontend** (`apps/web/src/lib/chat.ts`, `apps/web/src/app/chat/page.tsx`) — `ChatMessage.reasoning`,
  a tested `reasoningWords()` helper, and a collapsed `<details>` **THINKING** block rendered above the
  answer it belongs to (word count in the summary, monospace body, scrolls past 16rem). Renders only when
  a real trace exists.
- **Docs** — `docs/API_ENV.md` (reasoning flow + response field + migration 006), `README.md` (migration
  list), and `AGENT_CONTRACTS.md`, which now records this as an explicit, bounded exception to its
  "Do not expose private hidden chain-of-thought" rule (see §8).

## 3. Repository state

- Branch `main`. Base commit at the start of this task: `ca78efe` (= the previous handover for the Agent
  Chat room). Nothing was committed by this session — the 10 modified files + 1 new migration are
  uncommitted working-tree changes for the Changes panel / next commit.
- `bun test` → 238 pass / 0 fail. `npm run typecheck` → web `tsc --noEmit` exit 0, api `tsc --noEmit`
  exit 0. `bun run lint` → exit 0 (only the 3 pre-existing warnings in unrelated pages).
- The Freebuff preview is running; `/chat` compiles and serves 200 with these changes.

## 4. Files changed

Modified:
- `packages/shared/src/agent/protocol.ts` — `AGENT_REASONING_MAX_CHARS`, `ReasoningSplit`,
  `splitReasoning`, `combineReasoning`, `AgentReply.reasoning`, `parseAgentResponse(raw, explicit?)`
  (envelope-reasoning key), one added system-prompt rule (reason inside ` thinking…</think>`, JSON after).
- `packages/shared/src/agent/protocol.test.ts` — new `thinking is separated from the answer` describe
  block (7 cases) + a prompt assertion. Thinking tags are built with `String.fromCharCode(60/62)` on
  purpose: written literally they are indistinguishable from HTML and were silently dropped by the file
  writer, which made the first version of these tests vacuous.
- `apps/api/src/lib/agentRuntime.ts` — `AgentChatResult.reasoning`, `readReasoning()`, header truth-rules.
- `apps/api/src/routes/chat.ts` — `parseAgentResponse(call.content, call.reasoning)`, insert
  `reasoning: reply.reasoning || null`, honest empty-reply text.
- `apps/web/src/lib/chat.ts` — `ChatMessage.reasoning`, `reasoningWords()`.
- `apps/web/src/lib/chat.test.ts` — factory gains `reasoning: null`, 2 merge/helper cases, `reasoningWords`.
- `apps/web/src/app/chat/page.tsx` — collapsible THINKING block in `MessageRow`.
- `docs/API_ENV.md`, `README.md`, `AGENT_CONTRACTS.md` — as described in §2.

New:
- `supabase/migrations/006_chat_reasoning.sql`.

## 5. Tests/checks

Actually run, in this order, from the repo root:

| command | result |
| --- | --- |
| `bun test` | **238 pass, 0 fail** across 16 files |
| `npm run typecheck` | `@ostra/web typecheck` exit 0, `@ostra/api build` (tsc --noEmit) exit 0 |
| `bun run lint` | exit 0 — 3 pre-existing warnings (`episodes/[id]`, `layout.tsx`, `projects/*`), none in the files changed here |
| `node scripts/apply-migration.mjs supabase/migrations/006_chat_reasoning.sql` | `CONNECTED OK` → `APPLIED OK` → `DONE` |
| `node scripts/verify-supabase.mjs` | 16 tables, `missing: none` (it verifies tables, **not** columns) |
| `bun scripts/kaggle-sync-notebook.ts --dump --dump-full --from=0` | read the **live** notebook v13; cells 9–11 confirm the FastAPI shape (below) |
| `freebuff-preview status` | running, `/chat` compiled + `GET /chat 200` |

Evidence gathered to design this (all read-only, all real):
- The live Kaggle notebook (v13, `bettertrade/notebook7eae283a4a`) cell 9 is a FastAPI `/v1/chat/completions`
  that calls `tokenizer.apply_chat_template(...)` **without** `enable_thinking` and returns
  `choices[0].message.content` only — no reasoning field.
- `Qwen/Qwen3-1.7B` `tokenizer_config.json` (fetched from Hugging Face): the chat template emits the empty
  thinking block only when `enable_thinking is false`, so with the kwarg absent thinking is **on** by
  default; and tokens `151667`/`151668` (` thinking`/`</think>`) have `"special": false`, so they **survive**
  the worker's `skip_special_tokens=True` decode. That is why the inline split is the right primary path
  for this worker.

## 6. Integration status

- **Supabase (Postgres)** — *connected/verified*. Migration applied; the column statement is a plain
  `ADD COLUMN IF NOT EXISTS` reported as `APPLIED OK`. Column-level read-back is **not** possible from this
  workspace (direct DB queries from an ad-hoc command are blocked here; `verify-supabase.mjs` checks only
  table presence).
- **Kaggle Script AI worker (Qwen3-1.7B via ngrok)** — *unavailable right now*. The registered endpoint
  `https://oversleep-gift-bonfire.ngrok-free.dev` answered `ERR_NGROK_3200` (tunnel offline) for the whole
  session; the last successful registration was `2026-09-30T05:34Z`. So a real end-to-end turn could not be
  run. The worker code path is unchanged and requires **no notebook change** for this feature (thinking is
  already on by default).
- **Render API** — *not attempted*: external, operator-managed, not deployable from this workspace. The new
  reasoning parsing only takes effect after Render redeploys this commit.
- **Hosted OpenAI fallback** — *not attempted*: no `OPENAI_API_KEY` is configured. Code path added
  (separate `reasoning_content` field + envelope `reasoning` key) but never exercised against a live server.
- **Vercel (`/chat`)** — preview compiles and serves 200 locally; production deploy not attempted.

## 7. Known issues

1. **Nothing here is verified against the live model yet.** The mechanism is verified (unit tests + the
   real notebook/tokenizer inspection), the runtime behaviour is not. First real turn after Render
   redeploys + a worker comes ONLINE is the test.
2. **`AGENT_MAX_TOKENS=900` and the worker caps `max_new_tokens` at 1024.** A model that thinks for most of
   its budget is the failure mode: the JSON answer never arrives and the turn is stored as reasoning + "no
   final answer". The unterminated-` thinking` path handles it honestly, but the fix (a bigger cap in the
   notebook's FastAPI cell, which is **not** a managed cell) was deliberately not made — see §10.
3. **Last assistant message on screen does not stream.** Thinking appears when the turn completes (the
   transcript polls every 3s), not token-by-token. The room already shows an "is thinking… Ns" indicator
   while the request is in flight. Streaming would mean SSE/NDJSON through Express + a reader on the client
   — a much larger change, not attempted.
4. **Reasoning is stored but never sent back to the model.** Later turns replay only `content`. If that ever
   changes, revisit: raw chain-of-thought in the history would compound and inflate the token budget.
5. No `chat_messages.reasoning` index/backfill — intentional; `listMessages` uses `select("*")`.

## 8. Decisions

- **Split thinking *before* parsing the envelope**, in one pure function, rather than teaching the JSON
  scanner to skip ` thinking`. This fixes a latent bug (braces inside reasoning could hijack the brace-slice
  in `jsonCandidates`) and keeps the parser's "never fabricate" contract intact.
- **No notebook change.** The live FastAPI cell needs no edit: thinking mode is already the Qwen3 default
  when `enable_thinking` is absent, and the tags survive decoding. Avoided touching a cell that
  `kaggle-sync-notebook.ts` does not manage.
- **`reasoning` is `null`, not `""`, at rest**, and the UI keys off presence. A missing trace renders no
  block — we never show an empty "thinking" box or a fake one.
- **An unterminated ` thinking` is kept as reasoning with an empty reply** (visible, honest) rather than
  presenting half a thought as the answer or silently dropping it.
- **`AGENT_CONTRACTS.md` documents the exception.** Its "Do not expose private hidden chain-of-thought"
  rule (and the master blueprint §13 "Reasoning Visibility Constraint") genuinely conflicts with this
  request. The director asked for it explicitly, so it is implemented — but bounded and recorded: real
  model output only, collapsed by default, persisted for audit, not replayed back into context, and the
  rule still stands for worker/task messages.
- Docs updated rather than left stale (`CONSTRAINTS.md` #30).

## 9. Environment/configuration

- **No new environment variables.** `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_CHAT_MODEL` /
  `AGENT_TIMEOUT_MS` / `AGENT_MAX_TOKENS` are unchanged and still optional.
- **Migration required on every environment:** `supabase/migrations/006_chat_reasoning.sql`
  (`node scripts/apply-migration.mjs supabase/migrations/006_chat_reasoning.sql`). Applied to the live
  Supabase already. Additive + idempotent; never edit an applied migration.
- Order matters for a fresh DB: 001 → 002 → 003 → 004 → 005 → 006.
- Both halves must ship together: an old frontend against the new API simply ignores `reasoning`; an old
  API against the new frontend renders no block (the field is absent → `reasoningWords(undefined)` = 0).

## 10. Next agent

**One task: verify a real thinking trace end to end, then decide the token budget.**
Prerequisites: Render redeployed with this change, and the Script AI worker ONLINE (`/runtimes` → Run Now,
or `bun run verify:kaggle --push`, then wait for register + heartbeat).
1. In `/chat`, send a message that needs reasoning (e.g. "add a rival for the lead and explain your
   choice"), and confirm the assistant message shows a collapsed **THINKING** block with real reasoning
   above a real answer.
2. Read the row back (`select reasoning from chat_messages where role='assistant' order by created_at desc
   limit 1`) and confirm it matches what the block showed.
3. If the turn lands as reasoning + "(no final answer …)", the budget is the problem — that is the signal to
   raise the notebook's `min(request.max_tokens, 1024)` cap and/or lower `AGENT_MAX_TOKENS`, and to add a
   managed cell for the FastAPI server in `scripts/kaggle-sync-notebook.ts`.

## 11. Do not redo

- Do not re-implement the thinking/answer split — `splitReasoning` / `combineReasoning` /
  `parseAgentResponse` in `packages/shared/src/agent/protocol.ts` are done and tested (238 tests green).
- Do not add a `reasoning` column or a new migration for it — `006_chat_reasoning.sql` exists and is applied.
- Do not change the notebook's FastAPI cell just to "enable thinking" — it is already enabled by default
  (verified against the live notebook + the Qwen3 tokenizer config); only the token cap is worth revisiting.
- Do not re-add the Agent Chat room, the `/chat` page, `/api/chat/*`, `005_conversations.sql`, or the
  `TopNav` entry — all shipped in `8867db1` + `ca78efe`.
- Do not rewrite the room to stream unless a live turn proves the completed-turn display is unacceptable.

## 12. Verification

**Verified:** the splitter's behaviour (238 unit tests including 8 new reasoning cases), the full
typecheck, lint, the preview serving `/chat` 200, the live notebook's FastAPI shape, and the Qwen3-1.7B
tokenizer facts the design rests on.

**Unverified / must be proven by the next agent:**
- That a real Kaggle worker turn actually produces a non-empty `reasoning` value (the tunnel was offline
  for this entire session; the endpoint returned `ERR_NGROK_3200`).
- That the collapsed block renders the real trace correctly in the browser against live data.
- The hosted-fallback reasoning path (`reasoning_content` field, envelope `reasoning` key) — no
  `OPENAI_API_KEY` is configured, so it has never run against a live server.
- That `chat_messages.reasoning` exists as a column — inferred from `APPLIED OK` for a plain
  `ADD COLUMN IF NOT EXISTS`, not read back (ad-hoc DB reads are blocked in this workspace).
- That the Render API and Vercel production builds include these changes — neither was deployed from here.
