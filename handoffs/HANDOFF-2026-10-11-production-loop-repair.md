# HANDOFF — 2026-10-11 — Production loop repair

## What was broken

Three related faults kept the AI Studio production loop from working honestly:

1. **Manager auto-mode never fell back to NVIDIA NIM.** `resolveChannelBackend` honored the
   routing-mode decision for production agents but the manager resolution ignored the `nvidia`
   routing mode when no dedicated manager worker was ONLINE, so the Management Team could not answer
   even when the operator had routed everything to NIM.
2. **`dispatchRound` delivered the director's brief to ONE agent only.** The brief was inserted as
   `to_agent: "script"`, so Image AI and Voice AI never saw the director's instruction. This was the
   recorded wait-stall: Image awaited specs announced only to Script AI, Voice awaited an excerpt
   that had only been announced to Script AI, and the Showrunner reported "agents answered but
   produced nothing" — all true, all caused by the routing gap.
3. **The round summary was prose-only.** The dispatch response reported a number of answers but left
   the director to infer per-stage outcomes from the channel; there was no structured, auditable
   verdict, and no way for the UI to say precisely which stage resolved nothing and why.

## What was changed

| # | File | Change |
|---|------|--------|
| 1 | `apps/api/src/lib/agentRuntime.ts` | Unified backend resolution keyed off routing mode: manager slot now goes through the same routing-mode branch as every other agent, so `nvidia` routing gives the manager the NVIDIA NIM backend (health-probe gated, honest status) and `auto` keeps the existing worker-first fallback chain. |
| 2 | `apps/api/src/routes/agents.ts` + `apps/api/src/lib/agentChannel.ts` | The director's brief in `dispatchRound` is persisted as `to_agent: "all"` (migration 011 allows it; `inboxFor` already delivers `all` to every role), so every agent receives the brief in its inbox before its turn is called. |
| 3 | `packages/shared/src/agent/agents.ts` | New pure rule `summarizeRound(turns): { stages, outcome, blockers }` with `StageOutcome = completed | blocked | failed | skipped_offline`. `completed` requires real output (reply, peer messages, or applied writes); `blocked` is the honest middle case (backend answered, nothing produced); `failed`/`skipped_offline` are never optimistic. Artifacts list only actually-applied (`ok`) store write refs. |
| 3b | `apps/api/src/lib/agentChannel.ts` | `runProductionRound` returns `summary: summarizeRound(turns)` computed from the one shared rule. |
| 3c | `apps/api/src/routes/agents.ts` | `POST /api/agents/rooms/:id/dispatch` now returns `summary` and persists ONE audited event row `production.round` (constraint 20) carrying the room, per-stage outcomes and real blockers in `payload`. |
| 3d | `apps/web/src/lib/agents.ts` + `apps/web/src/app/studio/page.tsx` | The Studio "Last round" card renders the structured verdict: `round completed / partial / blocked` banner plus the real blocker list, colored emerald/amber/red. |

## Truth-rules compliance

- No mock/fake success path was added; a stage that produced nothing is reported `blocked`, not
  "answered".
- The brief broadcast uses the existing `all` recipient — no new schema, no fabricated deliveries.
- The audit event is written from REAL turn results only; `summarizeRound` is pure and unit-tested
  against failed/offline/empty shapes.

## Verification actually run

- `bun test` → **484 pass / 0 fail** (includes 7 new `summarizeRound` cases: completed, backend
  shape, blocked-empty reason, failed+offline counts, artifact filtering of refused writes,
  peer-message-only completion).
- `bun run typecheck` → web typecheck + api build both exit 0.
- `bun --filter @ostra/web lint` → exit 0 (pre-existing hook-deps warnings in unrelated pages only).

NOT exercised live (no configured backends in this workspace): a real round against NVIDIA NIM or a
registered runtime. The routing fallback for the manager slot is verified by type + build +
conventions only, and the event-row insert is verified against migration 001's `events` schema
(`type`, `project_id`, `actor`, `payload`).

## Follow-ups (not done here)

- Consider feeding `summary.blockers` back into the next round's manager prompt so the Management
  Team is instructed with the previous round's real blockers instead of discovering them from the
  channel alone.
- An operator-visible history list of `production.round` events (currently audited but only surfaced
  per dispatch response).
- The direct-chat `manageRoom` path could reuse `summarizeRound` for single-turn verdicts.
