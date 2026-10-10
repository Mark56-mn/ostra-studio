// apps/web/src/lib/autoloop.ts
// AUTO-WORK — let the Script AI keep working on a task in a loop, with no human in the middle.
//
// This module owns the POLICY only: what the loop says next, and when it must stop. The chat page
// stays a thin renderer of real backend answers, so every rule here is unit-tested and the UI can
// never invent progress.
//
// Truth rules (CONSTRAINTS.md):
//  - Every continuation is a REAL user turn sent to the REAL backend. Nothing is simulated, and an
//    auto-work session is exactly as auditable as a manual one — each step is a transcript row.
//  - Only three things end the loop, and each one is shown to the operator with its real reason:
//      1. the model's own `LOOP DONE` signal,
//      2. the step cap,
//      3. a real failure (no backend, transport error, or a rate limit it may not sit out).
//  - The hosted NVIDIA free tier is metered and answers 429 with a real Retry-After. The loop waits
//    out a bounded number of those and then STOPS LOUDLY — it never hammers a metered account.

import type { SendResult } from "./chat";

/** How many automatic continuations one auto-work session may take before it stops and says so. */
export const AUTOLOOP_MAX_STEPS = 10;

/** How many free-tier 429s the loop may wait out in one session. */
export const AUTOLOOP_MAX_RATE_LIMIT_WAITS = 3;

/** How many consecutive non-rate-limit failures are retried before the loop gives up. */
export const AUTOLOOP_MAX_ERROR_RETRIES = 2;

/** The only signal by which the model itself can end a session. */
export const AUTOLOOP_DONE_MARKER = "LOOP DONE";

/** A 429 asking for longer than this is not waited out — the loop stops and reports the number. */
export const AUTOLOOP_MAX_WAIT_MS = 90_000;

/** Courtesy pause between two successful steps, so a free tier is not hammered back to back. */
export const AUTOLOOP_TURN_PAUSE_MS = 1200;

/** Backoff before retrying a turn that failed for a reason other than the rate limit. */
export const AUTOLOOP_ERROR_BACKOFF_MS = 5000;

// ── the instruction the loop sends in place of a human ───────────────────────

/**
 * The continuation turn. It is written for a small model: one job per sentence, no ambiguity about
 * asking permission (it must not), and an explicit, quotable way to end the session.
 */
export function continuePrompt(step: number, maxSteps: number = AUTOLOOP_MAX_STEPS): string {
  return [
    "Auto-work: continue on your own. Take the next concrete step of the task above, carry it out yourself — write the store changes it needs — then say what changed.",
    "Do not ask me anything and do not wait for confirmation. Keep going until the work is finished.",
    `If there is nothing left for you to do — the task is complete, or it is genuinely impossible right now — start your reply with exactly ${AUTOLOOP_DONE_MARKER}.`,
    `(Auto-work step ${step} of ${maxSteps}.)`,
  ].join("\n");
}

/** Leading markdown a model may wrap its first line in, stripped before the marker is tested. */
const LEADING_DECORATION_RE = /^[\s>*_`#~\-(]+/;

/**
 * Did the model end the session itself? Only its OWN marker counts — the UI never declares the
 * work finished on the model's behalf.
 */
export function isDoneSignal(content: string | null | undefined): boolean {
  const text = (content ?? "").trim();
  if (!text) return false;
  const bare = text.replace(LEADING_DECORATION_RE, "");
  return /^loop[ _-]?done\b/i.test(bare);
}

// ── what the loop is deciding between ────────────────────────────────────────

/** One turn as the loop sees it — the backend's real answer, never a guess. */
export type LoopTurn =
  | { ok: true; content: string }
  | { ok: false; code: string; error: string; retryAfterSec?: number | null };

/** The running account of a session. `step` counts the continuations that actually succeeded. */
export type LoopBudget = {
  step: number;
  rateWaits: number;
  errorRetries: number;
};

export type LoopDecision =
  | { action: "continue"; delayMs: number }
  | { action: "stop"; reason: string };

export type LoopVerdict = { decision: LoopDecision; budget: LoopBudget };

/**
 * The single decision point of the whole feature: given the turn that just finished and the budget
 * so far, say what happens next — and what the operator will be told if it is over.
 *
 * Pure: no timers, no network, no state. The caller performs the wait and the next send.
 */
export function decideNextTurn(
  outcome: LoopTurn,
  budget: LoopBudget,
  maxSteps: number = AUTOLOOP_MAX_STEPS
): LoopVerdict {
  const stop = (reason: string, next: LoopBudget = budget): LoopVerdict => ({
    decision: { action: "stop", reason },
    budget: next,
  });

  // A completed turn always spends one step and clears the error streak.
  if (outcome.ok) {
    const after: LoopBudget = { step: budget.step + 1, rateWaits: budget.rateWaits, errorRetries: 0 };

    if (isDoneSignal(outcome.content)) {
      return stop(`the model reported the work finished (its own ${AUTOLOOP_DONE_MARKER} signal)`, after);
    }
    if (after.step >= maxSteps) {
      return stop(`reached the auto-work limit of ${maxSteps} steps — send another message to keep going`, after);
    }
    return { decision: { action: "continue", delayMs: AUTOLOOP_TURN_PAUSE_MS }, budget: after };
  }

  // The metered free tier refused. Wait out a bounded number of real Retry-Afters, then stop —
  // never burn an account, and never pretend the step happened.
  if (outcome.code === "RATE_LIMITED") {
    const waits = budget.rateWaits + 1;
    const retrySec = Math.max(1, Math.ceil(outcome.retryAfterSec ?? 60));
    const next: LoopBudget = { step: budget.step, rateWaits: waits, errorRetries: 0 };
    if (waits > AUTOLOOP_MAX_RATE_LIMIT_WAITS) {
      return stop(`the free NVIDIA tier rate-limited auto-work ${waits} times in a row (${outcome.error})`, next);
    }
    if (retrySec * 1000 > AUTOLOOP_MAX_WAIT_MS) {
      return stop(
        `the free NVIDIA tier asked to wait ${retrySec}s — longer than the ${AUTOLOOP_MAX_WAIT_MS / 1000}s this loop will hold a step for (${outcome.error})`,
        next
      );
    }
    return { decision: { action: "continue", delayMs: retrySec * 1000 }, budget: next };
  }

  // Nothing can answer at all: waiting cannot fix that, so the loop ends and the reason is the
  // backend's own (the chat page shows it verbatim, with the candidate list).
  if (outcome.code === "NO_AGENT_BACKEND") {
    return stop(`no AI backend is available, so the loop cannot continue (${outcome.error})`, {
      ...budget,
      errorRetries: 0,
    });
  }

  // Anything else is a real failure: retry a couple of times with backoff, then stop and say why.
  const retries = budget.errorRetries + 1;
  const next: LoopBudget = { step: budget.step, rateWaits: budget.rateWaits, errorRetries: retries };
  if (retries > AUTOLOOP_MAX_ERROR_RETRIES) {
    return stop(`the turn failed ${retries} times in a row — last error: ${outcome.error}`, next);
  }
  return { decision: { action: "continue", delayMs: AUTOLOOP_ERROR_BACKOFF_MS * retries }, budget: next };
}

/**
 * Map a real `sendMessage` result onto a loop turn. The failure shape carries the backend's honest
 * `retry_after_sec`, which is what lets a free-tier 429 be waited out instead of retried blindly.
 */
export function toLoopTurn(res: SendResult): LoopTurn {
  if (res.ok) return { ok: true, content: res.data.message.content };
  return { ok: false, code: res.code ?? "UNKNOWN", error: res.error, retryAfterSec: res.retryAfterSec };
}
