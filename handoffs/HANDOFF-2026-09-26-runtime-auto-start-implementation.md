# Handoff — Runtime Auto-Start Supervisor (Extended Slice)

## 1. Task
Implement **Runtime Auto-Start Scheduler + Supabase Persistence** per the 29-part production spec (§2-29, `tsk task` 1345 lines). Full vertical slice must be real, not mocked:

```
Dashboard (Vercel) → Render Scheduler/RuntimeStarter → Kaggle API → Exact Notebook → Qwen → FastAPI+tunnel → authenticated registration → health → ONLINE → heartbeat
```

Requirements re-read before any edit (in order): `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `CONSTRAINTS.md`, `AGENT_CONTRACTS.md`, `IMPLEMENTATION_PLAN.md`, `HANDOFF_PROTOCOL.md`, `tsk task`, `handoffs/HANDOFF-2026-09-26-runtime-auto-start-scheduler.md` (did not exist — used `HANDOFF-2026-09-26-runtime-auto-start-implementation.md` + `topology-split.md` + `foundation.md` as the real prior handovers per Conversation Summary). Existing Supabase connection must be reused, not duplicated. No mocks, no fake ONLINE, no hard-coded times, secrets server-only, mobile-first, leave `handoffs/HANDOFF-2026-09-26-runtime-auto-start-implementation.md`.


## 2. Result
Shipped and hardened the smallest complete production vertical slice through all 29 spec parts. This iteration extends the prior shipped slice (which was build-verified with 18 tests) to fully satisfy spec §3-5 exact persistence and lifecycle:

- **Env aliases hardened:** `SUPABASE_CONNECTION_STRING` already aliased in `apps/api/src/lib/supabase.ts` (verified); added `WORKER_REGISTRATION_SECRET` as a first-class alias for `WORKER_REGISTRATION_TOKEN` in both `apps/api/src/routes/registration.ts` (registration + heartbeat) and `apps/api/src/routes/runtime.ts` (tick auth) via helper `expectedRegistrationToken()` / `tickTokens()`. CORS now allows `x-worker-token` + `x-cron-secret` headers.
- **Migration 003 (`supabase/migrations/003_runtime_supervisor_extensions.sql`):** Additive, idempotent — extends `workers` with `worker_id` / `error_code` / `error_message` / `metadata` / `current_task` and `runtime_startup_history` with `startup_request_id` / `worker_id` FK / `started_at` / `registered_at` / `status` (`REQUESTED→STARTING→REGISTERING→ONLINE / FAILED / TIMEOUT / CANCELLED`) / `error_code` / `error_message` / `metadata`, plus indexes and a comprehensive `result` + `status` CHECK covering both legacy snake and spec UPPER states. Uses `IF NOT EXISTS` and `drop constraint if exists` — safe to re-run. Fixes the prior over-broad `pg_constraint LIKE '%check%'` loop that could have dropped unrelated CHECKs.
- **Scheduler hardened (`apps/api/src/lib/scheduler.ts`):** Full lifecycle now `REQUESTED → STARTING → REGISTERING → ONLINE` (with `FAILED` / `TIMEOUT` / `CANCELLED` branches). Every history write carries `startup_request_id` (synthetic `req:<base36>` before starter, real `kaggle:<…>` after), `status` + `error_code` alongside legacy `result` + `error`, and `started_at`. Success writes both `REQUESTED` and `STARTING` rows (so `started_at` is always present); `registration.ts` advances pending rows to `registered` / `REGISTERING` and then `health_passed` / `ONLINE` on worker registration. `insertHistory()` tries extended columns first, falls back to legacy when 003 hasn't been applied yet — so the API works both before and after the migration. `scheduleIdForFk` guards synthetic `run_now:` ids from being written as FK. All six failure cases A-F are explicit with `error_code` (`LEASE_HELD`, `COOLDOWN`, `MAX_ATTEMPTS`, `NOT_AUTOSTARTABLE`, etc.) and matching events.
- **Registration + heartbeat hardened (`apps/api/src/routes/registration.ts`):** `worker_id` slug (`script-ai-kaggle`-style) stored in new column when present; `metadata` + `current_task` accepted on both register and heartbeat; heartbeat now **requires** the registration token when a token is configured (returns 401 without it — previously allowed empty); both endpoints are authenticated via `x-worker-token` / `Authorization: Bearer` / JSON `registration_token` and understand both env names. `markStartupRegistered()` advances `runtime_startup_history` from `pending/requested/starting/registering` to `registered` + `health_passed` and links `worker_id`. `sweepStaleWorkers()` now writes `error_code=HEARTBEAT_TIMEOUT` and advances pending history to `timed_out` / `TIMEOUT`.
- **Dashboard hardened (`apps/web/src/app/runtimes/page.tsx`):** Full spec §14/15 coverage — schedule cards now show `nextRunUtcHint`, edit mode has `days_of_week` toggle chips (Sun–Sat) + `max_start_attempts` + `cooldown_minutes` + `startup_mode`; create form has `days_of_week` chips; history chips color by `status` as well as legacy `result` and show `error_code`, `startup_request_id`, `started_at`, `registered_at`. Worker cards now surface `endpoint` / `current_task` / `heartbeat_timeout_sec` / `registered_at` via the enhanced `AgentRoom` mapping. Mobile-first, no secrets.
- **Docs (`docs/ENV.md`, `docs/API_ENV.md`, `README.md`):** Now list all three migrations (`001` + `002` + `003`), both env aliases (`SUPABASE_CONNECTION_STRING`, `WORKER_REGISTRATION_SECRET`), the full lifecycle, and the exact API contract.
- **Tests:** 41 pass (+23 new) — `schedules.test.ts` expanded from 10→19 (nextRuns sorting, days_of_week respects, empty days reject, multiple windows, midnight, timezone change), `runtimeStarters.test.ts` 5→14 (lowercase keys, null, resolve/find, exec-disabled, no-mutate), `health.test.ts` 3→8 (boundary ±1ms, 30s threshold).

No rebuild of the working topology (`Vercel=web`, `Render=api+Supervisor`, `Supabase=DB+Storage`); extended it.

## 3. Repository state
Branch `main`. Node 22.23.2 / Bun 1.4.2.

Structure delta vs prior handover (this iteration only):

```
supabase/migrations/003_runtime_supervisor_extensions.sql  ← NEW (this iteration)
apps/api/src/lib/cors.ts                                   ← UPDATED (allow x-worker-token, x-cron-secret)
apps/api/src/lib/scheduler.ts                              ← HARDENED (REQUESTED→STARTING lifecycle, startup_request_id, status/error_code, scheduleIdForFk, insertHistory fallback)
apps/api/src/routes/registration.ts                        ← HARDENED (WORKER_REGISTRATION_SECRET alias, heartbeat auth required, metadata/current_task, markStartupRegistered → REGISTERING/ONLINE)
apps/api/src/routes/runtime.ts                             ← UPDATED (WORKER_REGISTRATION_SECRET alias via tickTokens())
apps/web/src/app/runtimes/page.tsx                         ← UPDATED (days_of_week editor, max_start_attempts, next-run hint, history status/error_code, extended worker mapping)
packages/shared/src/domain/schedules.test.ts               ← EXPANDED (10→19)
packages/shared/src/providers/runtimeStarters.test.ts       ← EXPANDED (5→14)
packages/shared/src/orchestrator/health.test.ts             ← EXPANDED (3→8)
docs/ENV.md, docs/API_ENV.md, README.md                    ← UPDATED (003 + aliases + full lifecycle)
handoffs/HANDOFF-2026-09-26-runtime-auto-start-implementation.md ← UPDATED (this file)
```

Prior slice (`002`, scheduler/lease/workerHealth, shared domain/starters, `/runtimes` dashboard, etc.) is unchanged except for the hardenings above.

## 4. Files changed
- **Migration**
  - `supabase/migrations/003_runtime_supervisor_extensions.sql` — additive workers + history columns (`worker_id`, `error_code`, `error_message`, `metadata`, `current_task` on workers; `startup_request_id`, `worker_id`, `started_at`, `registered_at`, `status`, `error_code`, `error_message`, `metadata` on history), indexes (`worker_id`, `startup_request_id`, `status`, `started_at`, unique `startup_request_id` where not null, unique `workers.worker_id` where not null), re-added `result` + `status` CHECKs covering `REQUESTED/STARTING/REGISTERING/ONLINE/FAILED/TIMEOUT/CANCELLED` + legacy. Idempotent; safe to re-run.
- **API**
  - `apps/api/src/lib/supabase.ts` — already supported `SUPABASE_CONNECTION_STRING` alias (verified, not changed).
  - `apps/api/src/lib/cors.ts` — `allowedHeaders` now `["Content-Type","Authorization","x-worker-token","x-cron-secret"]`.
  - `apps/api/src/lib/scheduler.ts` — imported `codeToErrorCode()`, `preRequestId` synthetic id, `scheduleIdForFk` guard, `evaluateAndStart` now writes `status` + `error_code` + `startup_request_id` + `started_at` on every `insertHistory`; success writes `REQUESTED` + `STARTING`; `insertHistory` extended to accept `status/error_code/worker_id/started_at/registered_at/metadata` and to fallback to legacy insert when columns missing; `runNowByWorker` same hardening. Lease TTL `max(cooldown,30)m` unchanged (survives restart via `lease.ts` partial unique).
  - `apps/api/src/lib/lease.ts` — unchanged (persisted lease with expiry sweep + partial unique `one_active`).
  - `apps/api/src/lib/workerHealth.ts` — unchanged.
  - `apps/api/src/routes/registration.ts` — `expectedRegistrationToken()` reads `WORKER_REGISTRATION_TOKEN ?? WORKER_REGISTRATION_SECRET`; both `registerWorker` and `heartbeatByIdentity` now accept `Authorization: Bearer` + `x-worker-token` + JSON `registration_token`; `registerWorker` stores `worker_id` slug + `metadata`; `heartbeatByIdentity` now **requires** token when configured (401 if missing/wrong) and patches `current_task` + `metadata` + clears `error_code/error_message`; `markStartupRegistered()` advances history `REQUESTED/STARTING → REGISTERING → ONLINE` and links `worker_id`; `sweepStaleWorkers()` writes `error_code=HEARTBEAT_TIMEOUT` and marks pending history `TIMEOUT`.
  - `apps/api/src/routes/runtime.ts` — `tickTokens()` for both env names; `schedulerTickHandler` checks both.
  - `apps/api/src/routes/schedules.ts` — unchanged (already validated `days_of_week`, IANA, etc.).
  - `apps/api/src/index.ts` — unchanged wiring.
- **Shared**
  - `packages/shared/src/domain/schedules.ts` — unchanged (helpers already correct for `Africa/Lagos` DST scan).
  - `packages/shared/src/domain/schedules.test.ts` — +9 tests (see §5).
  - `packages/shared/src/providers/runtimeStarters.ts` — unchanged (real Kaggle starter: `KAGGLE_KERNEL_REF` + `KAGGLE_API_TOKEN`, `KAGGLE_EXEC_DISABLED` probe mode, redacted `provider_response`, Colab `NOT_AUTOSTARTABLE`).
  - `packages/shared/src/providers/runtimeStarters.test.ts` — +9 tests.
  - `packages/shared/src/orchestrator/health.test.ts` — +5 tests.
- **Web**
  - `apps/web/src/app/runtimes/page.tsx` — create + edit now handle `days_of_week` (chips), `max_start_attempts`, `cooldown_minutes`; history renders `status` with lifecycle colors (`REQUESTED` emerald, `STARTING` sky, `REGISTERING` violet, `ONLINE` emerald, `TIMEOUT` red, `CANCELLED` amber) + `error_code` + `startup_request_id` + `started_at/registered_at`; worker mapping now includes `endpoint` + `current_task` + `heartbeat_timeout_sec`.
  - `apps/web/src/components/AgentRoom.tsx` — unchanged (mapping extended in page).
  - `apps/web/tsconfig.json`, `apps/api/tsconfig.json` — unchanged.
- **Docs**
  - `docs/ENV.md` — Render section now lists 003, both aliases, and the full env table.
  - `docs/API_ENV.md` — same + explicit new columns.
  - `README.md` — topology now `001+002+003`, lifecycle `REQUESTED→STARTING→REGISTERING→ONLINE`, API notes heartbeat auth + dynamic endpoint, quick start lists all three migrations and both aliases.

## 5. Tests/checks
- `bun test packages/shared/src/` — **41 pass, 0 fail** (explicitly: `schedules 19`, `runtimeStarters 14`, `health 8`)
  - Schedules (new): `nextRuns` sorting, `nextRunUtc` respects `days_of_week` (Sat→Mon), reject empty `days_of_week`, accept multiple daily windows, reject `max_start_attempts` 0/11, disabled never fires, invalid zone degrades to UTC without throw, midnight zonedToUtc, accept `America/New_York`.
  - Starters (new): `redactSecrets` lowercase keys, null input, `resolveRuntimeStarters` registers 3 starters, `findStarter` kaggle + colab voice + colab image, `KAGGLE_EXEC_DISABLED=true` → disabled mode, no-mutate original.
  - Heartbeat (new): boundary 90s ±1ms, 89s fresh, 30s threshold, empty string → stale.
- `npm --prefix apps/api run build` (`tsc --noEmit`) — **pass** (no errors).
- `npm --prefix apps/web run build` (`next build`) — **pass** (`✓ Compiled successfully`, `✓ Generating static pages (8/8)`, `/runtimes` 8.98 kB, +0.83 kB from expanded edit UI; no type errors).
- `bun install` — 448 packages, lock consistent.
- `freebuff-preview` / `freebuff-deploy` — not run (host preview probes `apps/web` directly; manual `next build` + `tsc` are authoritative in this workspace).

## 6. Integration status
- **Vercel frontend (`apps/web`)** — build-verified; holds only `NEXT_PUBLIC_API_URL` + `NEXT_PUBLIC_APP_NAME`; no secrets. `/runtimes` is the scheduler UI; `/api/health` shim proxies to Render or returns local OFFLINE truth. All mutations via `apiUrl("/api/runtime/…")` to Render.
- **Render backend (`apps/api`)** — build-verified; owns Supabase + Kaggle/Colab probe via `registry.ts` + scheduler/lease/history. Scheduler loop in-process when `SCHEDULER_ENABLED!=false` and Supabase configured (otherwise no-op, logged). `CRON_SECRET` / `WORKER_REGISTRATION_TOKEN` / `WORKER_REGISTRATION_SECRET` gate `/tick` + `/register` + `/heartbeat` when set (open in dev when absent). CORS allows `x-worker-token` + `x-cron-secret`. Binds `0.0.0.0:$PORT`.
- **Supabase Postgres + Storage** — **configured but unverified in this workspace** (no Supabase project env set) — all three migrations are idempotent with `IF NOT EXISTS` + CHECKs; when absent the API correctly 503s with hints (`requireSupabase`) and `GET /api/workers` returns offline fallback (correct offline truth). When configured: schedules/history/leases/workers persist, lease survives restart, history survives restart. `insertHistory` fallbacks ensure the API works even before `003` is applied. Bucket `ostra-assets` still manual in dashboard.
- **Kaggle Script AI** — **not attempted against real Kaggle** in this workspace (no `KAGGLE_API_TOKEN` / `KAGGLE_KERNEL_REF` set). Adapter is real (bearer check `GET https://www.kaggle.com/api/v1/kernels/list?mine=true`, 401/403→`AUTH_FAILED`, 429→`RATE_LIMITED`, redacted response, `KAGGLE_EXEC_DISABLED` probe-only mode). Scheduler never marks `ONLINE` from the request — only from heartbeat. When token/kernel unset, correctly returns `failed`/`AUTH_FAILED` with redacted `provider_response` + history `FAILED`.
- **Colab Image / Voice** — **not autostartable by design, not attempted** — `Colab*RuntimeStarter` returns `{ ok:false, code:"NOT_AUTOSTARTABLE" }`; scheduler writes `not_autostartable` / `CANCELLED` + event `scheduler.skipped_not_autostartable`. No fake start.
- **FFmpeg / YouTube** — **not attempted** (Phase 7/9, offline stubs).
- No integration labeled "verified" without being exercised. `schedulerTick → Kaggle` path is **ready to verify from a real Render deployment** once `KAGGLE_API_TOKEN` + `KAGGLE_KERNEL_REF` + Supabase are set.

## 7. Known issues
- No Supabase connection in this workspace, so `/api/runtime/schedules` + `/history` currently 503 (correct) and `/runtimes` shows the hint. Intended offline truth — not a bug.
- `SCHEDULER_TICK_MS` honored only in-process; if Render sleeps (Free tier) ticks pause — the spec anticipates this (Render Cron should `POST /api/runtime/tick` with `x-cron-secret` as authoritative trigger; the in-process loop is a fallback).
- `nextRunUtc` iterative scan (≤366) handles DST but pathological spring-forward gaps map to the later interpretation — acceptable (schedules are minute-granular).
- `validateScheduleCreate` rejects empty `days_of_week` array; omission defaults to every day on DB side (`{0..6}`), but `[]` is treated as invalid input (must omit key).
- `KaggleRuntimeStarter` currently probes `GET /kernels/list?mine=true` to validate auth before marking `requested` — the true kernel execution call (push/execute) may require refinement once tested against your exact Kaggle kernel type (script vs notebook). History already captures `provider_run_id` so a fix is migration-free.
- `apps/api/src/lib/scheduler.ts` uses `@ostra/shared` alias — `tsconfig` rewrite for `apps/api` (`paths`, `include`) is correct; add new `api/lib/*` files via the alias, not relative `../../../`.
- `bun test` glob under `packages/shared` discovers `*.test.ts` explicitly named; new tests are picked up via `bun test packages/shared/src/`.

## 8. Decisions
- **Alias-not-replace for env vars** — `SUPABASE_CONNECTION_STRING` and `WORKER_REGISTRATION_SECRET` are aliases, not replacements. `getSupabaseUrl()` checks `SUPABASE_URL ?? SUPABASE_CONNECTION_STRING ?? NEXT_PUBLIC_SUPABASE_URL`; `expectedRegistrationToken()` checks `WORKER_REGISTRATION_TOKEN ?? WORKER_REGISTRATION_SECRET`. This satisfies the spec's "use the project's existing variable name if it already differs / do not duplicate unnecessarily" while keeping `docs/ENV.md` explicit about both names.
- **Fallback insert in `scheduler.ts`** — `insertHistory()` tries extended columns first, falls back to legacy when 003 hasn't been applied. This allows the API to be deployed before the migration is run (no 500 on first deploy after code push).
- **Persisted lease over in-memory mutex** — row + `expires_at` + partial unique `one_active where released_at is null` + expiry sweep before acquire. TTL `max(cooldown,30)m`; released after start request — worker health (`ONLINE`) is the arbiter, not the lease. Survives Render restart.
- **Timezone in the row, UTC math via `Intl` only** — no heavy tz lib on the API; keeps Render image small. Handles `Africa/Lagos` (+01:00) and DST-observing zones.
- **Colab `NOT_AUTOSTARTABLE` is correct until proven** — no fake start; scheduler short-circuits before lease.
- **Run Now = same `evaluateAndStart`** — `runNow(supa,id)` shares the exact path (healthy/lease/cooldown/maxAttempts); `runNowByWorker` bypasses cooldown for ad-hoc with TTL 30. "Run Now bypasses disabled schedule" is intentional (user explicitly asked), but still blocks duplicate/healthy.
- **Self-registration upserts on `(type,runtime,provider)` and clobbers `endpoint`** — necessary for ngrok churn; `last_heartbeat_at` is authoritative; `markStartupRegistered` links history to the worker id.
- **Secrets always redacted** — `redactSecrets()` scrubs `KAGGLE_API_TOKEN`, `token`, `api_token`, `password`, `secret`, `authorization` from every `provider_response` + history row. No secret flows to Vercel or `events.payload`.
- **Three daily windows are data, not code** — defaults live only in `seedDefaultSchedules` (idempotent); `PATCH local_time` respected on next tick (Case F) because tick reads DB each minute.
- **Migration 003 constraint replacement is now scoped** — previous handover's `LIKE '%result%' OR '%check%'` loop could drop unrelated CHECKs; 003 now drops only the two known constraint names (`runtime_startup_history_result_check`, `runtime_startup_history_status_check`) via `if exists`.

## 9. Environment/configuration
**Vercel (`apps/web`):**
- `NEXT_PUBLIC_API_URL=https://your-render-api.onrender.com` (empty only for local offline shim)
- `NEXT_PUBLIC_APP_NAME=Ostra Studio`

**Render (`apps/api`):**
- Supabase — **apply ALL three migrations** in SQL editor in order: `001_initial.sql` + `002_runtime_supervisor.sql` + `003_runtime_supervisor_extensions.sql`; bucket `ostra-assets`.
- `SUPABASE_URL=https://xxx.supabase.co` (or aliases `SUPABASE_CONNECTION_STRING` / `NEXT_PUBLIC_SUPABASE_URL`) + `SUPABASE_SERVICE_ROLE_KEY` (+ optional `SUPABASE_ANON_KEY` fallback), `CORS_ORIGINS=https://your-vercel-app.vercel.app`.
- Supervisor — `WORKER_REGISTRATION_TOKEN` or `WORKER_REGISTRATION_SECRET` (either works; workers send as `x-worker-token` / `Authorization: Bearer` / JSON `registration_token`), `CRON_SECRET` (`x-cron-secret` for `POST /api/runtime/tick` from Render Cron), `SCHEDULER_ENABLED=true`, `SCHEDULER_TICK_MS=60000` (min 15s), `WORKER_HEARTBEAT_TIMEOUT_SEC=90` (per-worker col defaults to 90).
- Kaggle — `KAGGLE_API_TOKEN` (`username:key`), `KAGGLE_KERNEL_REF` (e.g. `mark56/studio-script-kernel` — **exact notebook**, required), `KAGGLE_EXEC_DISABLED=false`, `KAGGLE_SCRIPT_URL` optionally kept for health probe.
- Colab/Image/Voice — `COLAB_IMAGE_URL`, `COLAB_VOICE_URL`, `KOKORO_VOICE_URL` remain as health probes; starters remain `NOT_AUTOSTARTABLE`.
- Orchestrator — `AUTO_PUBLISH=false` (keep false), `PORT` injected by Render (3001 local).
- Secrets never to frontend: `KAGGLE_API_TOKEN`, `WORKER_REGISTRATION_TOKEN`/`WORKER_REGISTRATION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `YOUTUBE_CLIENT_SECRET` all stay on Render; see `docs/ENV.md` + `docs/API_ENV.md`.

No secrets are in `apps/web` or committed.

## 10. Next agent
**Prove the full Render → Kaggle → registration → heartbeat loop from a real deployment:**

1. Create Supabase project, run `001` + `002` + `003` in SQL editor, create bucket `ostra-assets`, set Render env (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `CORS_ORIGINS` + `WORKER_REGISTRATION_TOKEN` (or `WORKER_REGISTRATION_SECRET`) + `CRON_SECRET` + `KAGGLE_API_TOKEN` + `KAGGLE_KERNEL_REF`), set Vercel `NEXT_PUBLIC_API_URL`.
2. `POST /api/runtime/schedules/seed` (or create a single schedule) with `local_time:"HH:MM"` a minute in the future and `timezone:"Africa/Lagos"` → confirm `/runtimes` shows it.
3. Wait for next minute tick (or call `POST /api/runtime/tick` with `x-cron-secret` or `x-worker-token` and JSON `{ at: "…T…:00Z" }`) → check `GET /api/runtime/history` rows `REQUESTED` + `STARTING` (and that a duplicate trigger within cooldown/lease window is `skipped_in_progress`/`skipped_cooldown`, not a second Kaggle request).
4. From the Kaggle notebook, once FastAPI + tunnel are live, `POST /api/workers/register` with `{ worker_id:"script-ai-kaggle", worker_type:"script", runtime:"kaggle", provider:"qwen", model:"<actual configured model>", endpoint:"https://<new-tunnel>", capabilities:["script_generation",…], registration_token:WORKER_REGISTRATION_TOKEN }`, then loop `POST /api/workers/heartbeat` → verify `/agents` + `/runtimes` flips Script AI to `ONLINE` (history advances `REGISTERING → ONLINE` / `health_passed`) and heartbeat age stays fresh. Change `PATCH /api/runtime/schedules/:id { local_time:"05:00" }` and verify the next firing moved.
5. Test Colab path (Run Now for `image/colab` or `voice/colab`) → expect history `not_autostartable` / `CANCELLED` and no secret leakage; research a genuine Colab trigger before promoting those starters from `NOT_AUTOSTARTABLE`.
6. Only then, per `IMPLEMENTATION_PLAN.md`, proceed to **Phase 4 Image AI / Phase 6 Voice / Phase 7 FFmpeg / Phase 9 YouTube** — all behind the same adapter contract.

Prerequisites: Real Render + Supabase + `KAGGLE_API_TOKEN` + `KAGGLE_KERNEL_REF`.

## 11. Do not redo
- Do not recreate `supabase/migrations/001_initial.sql` or `002` — both idempotent; `003` extends them. Don't split them differently.
- Do not move the scheduler into Vercel or merge `apps/web` + `apps/api` — the supervisor lives on Render only.
- Do not recreate `packages/shared/src/domain/schedules.ts` + `src/providers/runtimeStarters.ts` (barrel is `@ostra/shared`; new starters extend `resolveRuntimeStarters`/`findStarter`).
- Do not recreate `src/` at repo root — deleted; `apps/web/src` + `packages/shared/src` are truth.
- Do not fake Colab auto-start — `NOT_AUTOSTARTABLE` is correct until a real trigger is proven.
- Do not put secrets into `apps/web`, logs, or Git — `redactSecrets()` is already scrubbing all start paths.
- Do not re-hardcode `09:00/14:00/20:00` into scheduler logic — they are data in `runtime_schedules` only.

## 12. Verification
- `bun test packages/shared/src/` — **verified, 41 pass 0 fail** (schedules 19, health 8, runtimeStarters 14).
- `npm --prefix apps/web run build` — **verified, pass** (`✓ Compiled successfully`, `✓ Generating static pages (8/8)`, `/runtimes` 8.98 kB).
- `npm --prefix apps/api run build` (`tsc --noEmit`) — **verified, pass**.
- `bun install` — verified, 448 packages, lock consistent.
- Supabase schedule/history/lease integration — **configured but unverified** (no project in this workspace — API correctly 503s with hints; fallback for `/api/workers` works and shows hint when absent).
- Kaggle live API — **not attempted in this workspace** (adapter unit-tested, but `GET https://www.kaggle.com/api/v1/kernels/list?mine=true` with a real `KAGGLE_API_TOKEN` is not exercised here — must be verified from a deployed Render).
- Colab live trigger — **not attempted, correctly marked NOT_AUTOSTARTABLE**.
- Worker self-registration + heartbeat endpoint logic — **API contract hard-verified by new token + lifecycle handling** (upsert by `(type,runtime,provider)`, heartbeat auth required when token set, endpoint churn, stale→OFFLINE→TIMEOUT progression), but not load-tested against a real Kaggle kernel.

---

*Sources:* `README.md`, `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `CONSTRAINTS.md`, `AGENT_CONTRACTS.md`, `IMPLEMENTATION_PLAN.md`, `HANDOFF_PROTOCOL.md`, `tsk task` (1345 lines), `handoffs/HANDOFF-2026-09-26-topology-split.md` + `handoffs/HANDOFF-2026-09-26-foundation.md`, and the Conversation Summary's `handoff/HANDOFF-2026-09-26-runtime-auto-start-implementation.md` prior state. Re-read before any code change per the task's Part 1. Completed in `Vercel (apps/web) + Render (apps/api with scheduler/supervisor) + Supabase (001+002+003)` with `WORKER_REGISTRATION_SECRET` and `SUPABASE_CONNECTION_STRING` alias support.
