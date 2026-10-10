# Handover — Auto-work: a hands-off loop for the Agent Chat page

Date: 2026-10-09
Branch: `main` (working tree **not** committed — Freebuff's Changes panel owns Save/Share/commit)

## 1. Task

The user asked: *"I want all NVIDIA free AI to be able to continuously work in a loop once given a task without needing human intervention — there should be a button in the chat page close to the chat button where I can allow the AI to continuously work on a project."*

## 2. Result

Done for the requested scope. `/chat` now has an **Auto-work** toggle directly beside **Send**. When it is
ON, the page sends the AI a continuation turn after every answer, so one typed task becomes a chain of real
turns with nobody typing in between. The loop ends on a real, displayed reason and can always be stopped by
hand.

The loop is deliberately **client-side**: every step is an ordinary
`POST /api/chat/rooms/:id/messages` call, so each one is a transcript row and an audited store write. No
API, schema or migration change was needed, and nothing is simulated — the loop never writes an assistant
row itself and never declares success on the model's behalf.

Stop conditions (all shown verbatim on screen):
1. the model's own `LOOP DONE` reply (its own signal — the UI never infers completion),
2. the 10-step cap (`AUTOLOOP_MAX_STEPS`),
3. the metered free tier: a 429 is waited out via the backend's real `retry_after_sec` up to
   `AUTOLOOP_MAX_RATE_LIMIT_WAITS` times, and a 429 asking for more than `AUTOLOOP_MAX_WAIT_MS` (90s) stops
   immediately; other failures are retried `AUTOLOOP_MAX_ERROR_RETRIES` times with growing backoff;
   `NO_AGENT_BACKEND` stops at once,
4. the human pressing **Stop** or toggling the switch off (`CONSTRAINTS.md` 25 — human override),
5. the human switching to another room — the loop works the room it started in, and stops out loud rather
   than keep writing where nobody is looking.

The loop works with whichever backend answers the room — the Kaggle Script AI worker or the hosted NVIDIA
free backup — because it is built on the existing routing, not on a provider.

## 3. Repository state

`main`, working tree dirty with the five files below (plus this handover). Nothing committed or pushed.

## 4. Files changed

- `apps/web/src/lib/autoloop.ts` (new) — the whole POLICY as pure functions: `continuePrompt()`,
  `isDoneSignal()`, `decideNextTurn()`, `toLoopTurn()` + the budget constants. No timers, no network, no
  state, so it is unit-testable and the UI cannot invent progress.
- `apps/web/src/lib/autoloop.test.ts` (new) — 19 tests over the policy, including the free-tier 429
  behaviour and the "never end a session on prose that merely mentions the marker" case.
- `apps/web/src/app/chat/page.tsx` — extracted `performTurn()` from `onSend()` (one real turn, returns the
  backend's real `SendResult`), added the loop driver (`driveLoop`, `countdown`, `cancelAutoWork`,
  `onToggleAutoWork`), the **Auto-work ON/OFF** button next to **Send**, the step/waiting/ended status line
  under the composer, and a bullet in HOW THIS WORKS. A `projectIdRef` mirrors the bound project so a
  project created mid-loop keeps feeding the live store panel, and an `activeIdRef` stops the loop out loud
  if the operator switches rooms mid-session.
- `apps/web/src/lib/chat.ts` — `SendResult`'s failure arm now carries `retryAfterSec` (the backend's real
  `retry_after_sec` on 429). Backward-compatible: one extra nullable field.
- `README.md`, `docs/API_ENV.md` — documented the feature where `/chat` is described, including that it
  runs only while the page is open.

## 5. Tests/checks

Run in this workspace, on the final state of the code:

- `bun test` → **418 pass, 0 fail**, exit 0 (was 399 before; +19 new).
- `bun --filter @ostra/web typecheck` → exit 0. (First run caught a real error — `AUTOLOOP_TURN_PAUSE_MS`
  used but not imported — fixed and re-run green.)
- `bun --filter @ostra/web lint` → exit 0; only the three pre-existing warnings in `layout.tsx` and the two
  `projects` pages. No new warnings from the changed files.
- Preview runtime: `freebuff-preview status` → running, `GET /chat` **200**; logs show
  `✓ Compiled /chat in 2.9s (531 modules)`. The served HTML contains the Auto-work control and no module
  errors.

## 6. Integration status

- **Supabase / Render API** — configured and exercised earlier today (backend `/api/health` 200, Supabase
  ONLINE); the loop's transport is the pre-existing `POST /api/chat/rooms/:id/messages`, unchanged.
- **NVIDIA NIM free tier** — configured (key present), but **not exercised in this session**. The loop's
  429 handling is unit-tested against the backend's real response shape (`error: "RATE_LIMITED"`,
  `retry_after_sec`), which `apps/api/src/routes/chat.ts` produces; a live rate-limit was not triggered on
  purpose.
- **The loop end-to-end in a browser** — **not verified**: no browser session was driven from this
  workspace. Evidence is the compiled route, the served markup and the passing tests, not a watched session.

## 7. Known issues

- **The loop stops if the tab is closed.** That is the honest consequence of a client-side loop and also
  its safety: nothing runs unattended in your account after you leave. Everything the loop did is already
  persisted. A server-side loop would need a queue/worker on Render and a cancellation UI — deliberately
  not built (`CONSTRAINTS.md` 22).
- **`LOOP DONE` is a convention the model must honour.** A small model may never emit it, in which case the
  10-step cap ends the session. That failure mode is "stops too late", never "runs unbounded".
- A model that echoes its instruction could mention the marker in prose; only the marker *at the start* of
  a reply (markdown decorations stripped) counts, so a mention mid-sentence does not end the session.
- Rate-limit waits happen while the tab is open and the machine is awake; a backgrounded tab may throttle
  timers, stretching a wait but not breaking it.

## 8. Decisions

- **Policy is pure and separate from the driver.** `decideNextTurn(outcome, budget)` returns
  `{decision, budget}` and performs nothing, so the entire "when does it continue/stop" logic is testable
  without fake timers.
- **The continuation is a visible user row**, not a hidden system call — the transcript shows exactly what
  the loop asked for, keeping the session auditable (`CONSTRAINTS.md` 20).
- **The step cap, wait budget and error budget are constants, not settings.** They bound a metered free
  account; a mis-set env var must not be able to disable them (`rateLimit.ts` has the same philosophy).
- **`toLoopTurn` lives in the policy module** so the mapping from `SendResult` → loop turn is unit-tested
  without a network.

## 9. Environment/configuration

No new env vars. Nothing to set on Render or in the workspace. The loop uses the already-configured
`NEXT_PUBLIC_API_URL` through the existing `apiFetch`.

## 10. Next agent

One recommended task: **drive a real session in a browser** — open `/chat`, toggle Auto-work ON, send a
short task (e.g. "create a project with two characters"), and watch it loop: confirm each continuation is a
transcript row, the store panel follows, the step counter climbs, and **Stop** ends it with the reason
shown. Prerequisites: the preview running, and a backend that can answer (Kaggle worker ONLINE or
`NVIDIA_API_KEY` set).

## 11. Do not redo

- Do not rebuild the loop policy or re-add the toggle — it is in and tested.
- Do not add a backend endpoint for this unless the user explicitly wants the loop to survive a closed tab;
  that is a queue/worker project, not a patch.
- Do not re-run the earlier backend URL/CORS work from the previous handovers (backend reachable,
  `NEXT_PUBLIC_API_URL` baked into the bundle; the only open item there is the Render-side
  `CORS_ORIGINS` entry, which only the user can set).

## 12. Verification

Unverified and stated as such: a live browser session of the loop (see §10), and a live NVIDIA 429 being
waited out by the loop. Also unverified: production deploy behaviour — `freebuff-deploy env set` still
refuses until the first deploy is done, so the deploy will bake in the sandbox `NEXT_PUBLIC_API_URL`.
