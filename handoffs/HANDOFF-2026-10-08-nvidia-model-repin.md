# HANDOFF-2026-10-08 — NVIDIA retired-model re-pin + `MODEL_RETIRED`

## 1. Task

The Agent Chat room failed with:

```
HTTP_ERROR — The Script AI (nvidia · meta/llama-3.3-70b-instruct · integrate.api.nvidia.com)
HTTP 410: {"title":"Gone","status":410,"detail":"The model 'meta/llama-3.3-70b-instruct'
has reached its end of life on 2026-08-26T09:00:00Z and is no longer available."}
```

Fix the cause (the shipped default model id no longer exists at the provider) and stop the failure
class from being invisible the next time NVIDIA retires an id.

## 2. Result

Complete. Three things changed:

1. **The dead pin is gone.** `meta/llama-3.3-70b-instruct` was removed from the dispatch catalog and the
   default is now `nvidia/nemotron-3-super-120b-a12b`. The old default is remembered in
   `NVIDIA_RETIRED_MODELS` with its EOL date and a successor.
2. **The whole catalog was re-pinned from evidence, not memory.** On 2026-10-08 the live account's
   `GET /v1/models` returned 80 ids and every catalog candidate was probed with a **real completion**.
   Five of the six previously shipped ids are gone (`meta/llama-3.3-70b-instruct`,
   `meta/llama-3.1-8b-instruct`, `qwen/qwen3-next-80b-a3b-instruct`, `deepseek-ai/deepseek-r1`,
   `qwen/qwen2.5-coder-32b-instruct`); only `nvidia/nemotron-3-super-120b-a12b` survived. The catalog is
   now five ids, each verified callable that day, with the measured latency in its `note`.
3. **A retired / uncallable pin is now a permanent, named failure.** `MODEL_RETIRED` (a known-retired id is
   refused locally before any request, spending no call and no rate-limit token; an upstream `410 Gone` is
   reported with the id, the EOL date and the successor) and `MODEL_UNAVAILABLE` (a NIM `404 Function … not
   found for account`, i.e. listed but not callable by this key). Neither is a retryable `HTTP_ERROR`, and
   neither is silently swapped for a model the operator did not choose.

Verified live through the production code path, not just unit tests:

```
SHIPPED DEFAULT (no NVIDIA_CHAT_MODEL):
  backend: nvidia · nvidia/nemotron-3-super-120b-a12b · integrate.api.nvidia.com
  ok: true latencyMs: 555   content: "A story beat is a single, purposeful moment …"   reasoning chars: 92
RETIRED PIN (NVIDIA_CHAT_MODEL=meta/llama-3.3-70b-instruct):
  ok: false latencyMs: 0
  code: MODEL_RETIRED
  error: NVIDIA model "meta/llama-3.3-70b-instruct" is retired (end of life 2026-08-26) — pin a live id
         instead, e.g. NVIDIA_CHAT_MODEL=nvidia/nemotron-3-super-120b-a12b (or NVIDIA_MODEL_<SLOT> for one
         agent) and redeploy
```

`latencyMs: 0` is the proof the refusal is local: no request was sent.

## 3. Repository state

- Branch `main`, working tree containing the changes below. **Nothing was committed or pushed** — the
  user asked for the failure to be fixed, not for a delivery, and Freebuff's Changes panel owns commits.
- Model pins live in `packages/shared/src/providers/nvidia.ts` (catalog + retired list + default).
- Behaviour lives in `apps/api/src/lib/agentRuntime.ts` (`callAgent`).

## 4. Files changed

- `packages/shared/src/providers/nvidia.ts`
  - `NVIDIA_MODEL_CATALOG` re-pinned to five live-verified ids; every note now states what the 2026-10-08
    probe measured (latency, and that `enable_thinking` was accepted).
  - New `NVIDIA_RETIRED_MODELS` / `NvidiaRetiredModel` / `nvidiaRetiredModel()`: the dead ids, what was
    observed, and a successor each.
  - `NVIDIA_DEFAULT_MODEL` = `nvidia/nemotron-3-super-120b-a12b`.
- `packages/shared/src/lib/env.ts` — imports `NVIDIA_DEFAULT_MODEL` / `NVIDIA_DEFAULT_BASE_URL` from the
  catalog module instead of holding its own copies (the duplication is how a retired id became the
  default), so there is one source of truth for the shipped pin.
- `apps/api/src/lib/agentRuntime.ts`
  - `AgentCallFailureCode` grows `MODEL_RETIRED` and `MODEL_UNAVAILABLE`.
  - `retiredModelError()` / `permanentVerdict()` helpers; the retired check runs **before** the catalog
    lookup and before the rate-limit token, so a dead pin costs nothing.
  - The NVIDIA branch of `resolveAgentBackendFor` reports a retired pin as `available: false` with the
    re-pin in the status text, so `/models` shows the real problem rather than a green route that cannot
    answer.
- `packages/shared/src/providers/nvidia.test.ts` — uses catalog-derived `WITH_SWITCH` / `WITHOUT_SWITCH`
  entries instead of restating model ids; new test that no retired id is dispatchable and every successor
  is a live catalog id.
- `apps/api/src/lib/agentRuntime.nvidia.test.ts` — new tests: `410 Gone` → `MODEL_RETIRED` with the
  re-pin; NIM `404` → `MODEL_UNAVAILABLE`; a retired pin is refused with zero network calls; a retired pin
  does not consume a rate-limit token. The default-model assertion now imports `NVIDIA_DEFAULT_MODEL`.
- Docs updated to reality: `README.md` (status + the corrected "no live NVIDIA call has been exercised
  yet" claim — it now has been), `docs/API_ENV.md` (verified-callable table + retired/unavailable
  semantics), `docs/ENV.md`, `AGENT_CONTRACTS.md`, and the stale model ids in
  `handoffs/HANDOFF-2026-09-30-multi-agent-studio.md`.

## 5. Tests/checks

- `bun test` → **399 pass, 0 fail** (31 files). Was 394; +5 new tests.
- `bun test apps/api/src/lib/agentRuntime.nvidia.test.ts packages/shared/src/providers/nvidia.test.ts`
  → 25 pass, 0 fail.
- `bun run typecheck` (`@ostra/web` typecheck + `@ostra/api` build) → exit 0.
- `bun run lint` → exit 0 (only pre-existing warnings in untouched files).
- **Live checks against the real NIM account** (temporary scripts, deleted afterwards; the key was never
  printed):
  - `GET /v1/models` → 200, 80 ids. Confirmed live: the three Nemotron 3 lanes, `openai/gpt-oss-20b`,
    `moonshotai/kimi-k3`. Confirmed GONE: `meta/llama-3.3-70b-instruct`, `meta/llama-3.1-8b-instruct`,
    `qwen/qwen3-next-80b-a3b-instruct`, `deepseek-ai/deepseek-r1`, `qwen/qwen2.5-coder-32b-instruct`.
  - Real completions: `nvidia/nemotron-3-super-120b-a12b` 200/"pong"/reasoning 135 chars (~1.1s);
    `nvidia/nemotron-3.5-lightning-30b-a3b` 200/reasoning 555 (~3.4s); `nvidia/nemotron-3-ultra-550b-a55b`
    200/reasoning 127 on retry (~15s, one 503 first); `openai/gpt-oss-20b` 200 (~0.9s);
    `moonshotai/kimi-k3` 200 (~29s).
  - **A trap worth knowing:** seven ids that ARE listed live answered
    `404 {"detail":"Function …: Not found for account …"}` — `nvidia/nemotron-nano-3-30b-a3b`,
    `nvidia/llama-3.1-nemotron-70b-instruct`, `mistralai/codestral-22b-instruct-v0.1`,
    `mistralai/mistral-large-2-instruct`, `ibm/granite-34b-code-instruct`,
    `nvidia/nemotron-4-340b-instruct`, plus `bigcode/starcoder2-15b` (plain 404 page). Listed ≠ callable.
    That is why `MODEL_UNAVAILABLE` exists and why the catalog only keeps probed ids.
  - `z-ai/glm-5.3` and `z-ai/glm-5.3-flash` answered 200 but with `finish_reason: length` and **null
    content** — they spend a small budget on thinking and return an empty answer. Not catalogued;
    `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` was `503 ResourceExhausted` (worker limit 16/16) each
    time it was tried, so it is not catalogued either.

## 6. Integration status

- **NVIDIA NIM — connected and verified.** Real `GET /v1/models` plus real completions on 2026-10-08 with
  the workspace key, and one completion driven through this repo's own `callAgent`/`nvidiaBackend` path
  (555ms, content + 92-char reasoning).
- **Supabase — not touched this turn** (no migration, no query). `provider_routing` remains as applied in
  the previous session.
- Kaggle / Colab / YouTube — not attempted, not affected.
- `/api/routing` and the `/models` page were **not** exercised against a live backend this turn: they are
  covered by unit tests and the resolver they call. The routing payload shape did not change, so the
  existing page keeps working; only the catalog contents it renders are new.

## 7. Known issues

- `nvidia/nemotron-3-ultra-550b-a55b` is live and callable but was `503 Service temporarily overloaded`
  once and took ~15s the next time; `moonshotai/kimi-k3` took ~29s. Both are catalogued with those real
  numbers in their notes — usable, not recommended as a default.
- Catalog entries deliberately do NOT re-verify themselves at runtime. Verification is a dated,
  human-run probe (`note` field); the live state is otherwise only visible through the real probe on
  `/models`. There is no scheduled job that diffs the pins against `GET /v1/models` — that is the audit
  this incident argues for and it is still missing.
- `HTTP_ERROR` still covers `5xx`/capacity answers (`503 ResourceExhausted`). Those really are transient,
  so they are not special-cased; the upstream body is included in the message.
- No code-specific lane is catalogued: every candidate code model was either absent or not callable by
  this account on 2026-10-08.

## 8. Decisions

- **A retired id must be removed from the dispatch allowlist, never kept "just in case".** A dead pin
  passes every config check, answers nothing, and spends a retry slot plus a slice of the caller's
  deadline on every request forever. It is recorded in `NVIDIA_RETIRED_MODELS` instead, so the failure is
  named.
- **Retired and not-entitled are different facts, so they are different codes.** `410` → `MODEL_RETIRED`
  (with the EOL date we actually saw); NIM `404` → `MODEL_UNAVAILABLE` ("listed is not callable"). Calling
  the second one a retirement would be a false statement.
- **Refuse locally before the network.** A retired pin costs zero calls and zero rate-limit tokens, which
  also means the 60s probe cache cannot be spent re-probing an id that can never work.
- **The catalog is an evidence list.** Entries carry the measured latency and the verification date; ids
  that were only *listed* were rejected. Being conservative here was vindicated: the three Qwen/DeepSeek
  ids the catalog used to ship were all gone.
- **One source of truth for the pin.** `env.ts` imports `NVIDIA_DEFAULT_MODEL` from the catalog module;
  tests import it too. Restating the string is exactly how a retired id became the default.
- No hard-coded successor is applied at runtime: the operator gets the instruction and re-pins. Silently
  answering from a model they did not choose would violate `CONSTRAINTS.md` #4/#24.

## 9. Environment/configuration

- No new env vars. No migration.
- `NVIDIA_API_KEY` and `NVIDIA_BASE_URL` are present in this workspace's `.env` (values never read or
  printed). `NVIDIA_CHAT_MODEL` and `NVIDIA_MODEL_<SLOT>` are **not** set here, so the code default is what
  ran — which is why the code default was the bug.
- **Render action if those vars were set to any retired id** (`meta/llama-3.3-70b-instruct`,
  `meta/llama-3.1-8b-instruct`, `qwen/qwen3-next-80b-a3b-instruct`, `deepseek-ai/deepseek-r1`,
  `qwen/qwen2.5-coder-32b-instruct`): set `NVIDIA_CHAT_MODEL=nvidia/nemotron-3-super-120b-a12b` (or
  another catalog id) and redeploy, or just unset it to take the new default. After that a redeploy of
  `main` is needed for the code fix itself.
- Optional: `NVIDIA_THINKING=false` removes the ~1s thinking overhead on the default lane; the switch is
  sent as `chat_template_kwargs: { enable_thinking: true }` and was verified accepted.

## 10. Next agent

**Add the missing catalog audit.** A Supabase-scheduled/`CRON` job that, once a day, calls
`GET {NVIDIA_BASE_URL}/models` with the configured key, diffs the result against `NVIDIA_MODEL_CATALOG`
and `NVIDIA_RETIRED_MODELS`, and writes one `events` row per discrepancy (`nvidia.catalog.drift`), so a
retired pin is a calendar entry instead of a two-week silence. Two rules from this incident that must be
kept: an **empty** live list means the provider was unreachable, so the verdict is `unknown` and nothing is
flagged dead; and "listed" must be reported separately from "callable" (the `404 Function … not found for
account` class), because they are different problems with the same symptom.

Prerequisite: nothing beyond the existing `NVIDIA_API_KEY` and the `events` table.

## 11. Do not redo

- Do not re-add any id from `NVIDIA_RETIRED_MODELS` to the catalog without a live completion against the
  current key.
- Do not restate a model id in a test or in `env.ts`; import `NVIDIA_DEFAULT_MODEL` / the catalog.
- Do not "fix" `MODEL_RETIRED` by silently falling through to another model or another provider.
- Do not map `410` or the NIM `404` back to `HTTP_ERROR`.
- The 2026-10-08 probe results in `docs/API_ENV.md` and in the catalog notes are measurements, not
  policy — do not reword them into guarantees.

## 12. Verification

- **Verified:** the shipped default answers a real completion through the repo's own call path (555ms,
  content + reasoning); a retired pin returns `MODEL_RETIRED` with zero network calls; `410` and NIM `404`
  map to `MODEL_RETIRED` / `MODEL_UNAVAILABLE`; no retired id is dispatchable and every successor is a
  live catalog id; `bun test` 399 pass / 0 fail; `bun run typecheck` exit 0; `bun run lint` exit 0.
- **Not verified:** `/api/routing` and the `/models` page against a running backend (no live API server in
  this workspace); the `503` capacity path only as observed, not as a designed behaviour; the other four
  catalog entries were verified with the small probe prompt, not with an agent-length prompt; and no
  Render/production env was inspected, so it is unknown whether a retired id is pinned there — see
  section 9.
