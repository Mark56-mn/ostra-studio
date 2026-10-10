// apps/web/src/lib/autoloop.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  AUTOLOOP_ERROR_BACKOFF_MS,
  AUTOLOOP_MAX_RATE_LIMIT_WAITS,
  AUTOLOOP_MAX_STEPS,
  AUTOLOOP_MAX_WAIT_MS,
  AUTOLOOP_TURN_PAUSE_MS,
  continuePrompt,
  decideNextTurn,
  isDoneSignal,
  toLoopTurn,
  type LoopBudget,
  type LoopDecision,
  type LoopTurn,
} from "./autoloop.js";
import type { SendResult } from "./chat.js";

const FRESH: LoopBudget = { step: 0, rateWaits: 0, errorRetries: 0 };

/** Narrowing helpers — the decision is a discriminated union, so read it as one. */
function stopReason(decision: LoopDecision): string | null {
  return decision.action === "stop" ? decision.reason : null;
}

function continueDelay(decision: LoopDecision): number | null {
  return decision.action === "continue" ? decision.delayMs : null;
}

function answered(content: string): LoopTurn {
  return { ok: true, content };
}

function refused(code: string, retryAfterSec?: number): LoopTurn {
  return { ok: false, code, error: "The Script AI (nvidia · MODEL) said no", retryAfterSec: retryAfterSec ?? null };
}

describe("continuePrompt", () => {
  it("tells the model to work alone, never ask, and how to end the session", () => {
    const prompt = continuePrompt(3);
    assert.match(prompt, /do not ask me anything/i);
    assert.match(prompt, new RegExp(`start your reply with exactly LOOP DONE`, "i"));
    assert.match(prompt, /step 3 of 10/);
  });

  it("carries the real step budget through", () => {
    assert.match(continuePrompt(1, 4), /step 1 of 4/);
  });
});

describe("isDoneSignal", () => {
  it("accepts the marker at the start of the reply", () => {
    assert.equal(isDoneSignal("LOOP DONE: the cast and EP 01 are written."), true);
    assert.equal(isDoneSignal("loop done"), true);
    assert.equal(isDoneSignal("Loop-Done — nothing left."), true);
  });

  it("sees through the markdown a small model wraps its first line in", () => {
    assert.equal(isDoneSignal("**LOOP DONE** the project is set up."), true);
    assert.equal(isDoneSignal("\n  - LOOP DONE"), true);
  });

  it("never ends a session on ordinary prose that merely mentions the marker", () => {
    assert.equal(isDoneSignal("I will say LOOP DONE when finished, but first let me create Kai."), false);
    assert.equal(isDoneSignal("Creating the two leads now."), false);
    assert.equal(isDoneSignal(""), false);
    assert.equal(isDoneSignal(null), false);
    assert.equal(isDoneSignal(undefined), false);
  });
});

describe("decideNextTurn — a working session", () => {
  it("keeps going after a real answer, spending one step and pausing briefly", () => {
    const { decision, budget } = decideNextTurn(answered("Created character Kai."), FRESH);
    assert.equal(continueDelay(decision), AUTOLOOP_TURN_PAUSE_MS);
    assert.deepEqual(budget, { step: 1, rateWaits: 0, errorRetries: 0 });
  });

  it("stops on the model's own signal and says exactly that", () => {
    const { decision, budget } = decideNextTurn(answered("LOOP DONE: all three locations exist."), {
      ...FRESH,
      step: 2,
    });
    assert.match(stopReason(decision) ?? "", /LOOP DONE/);
    assert.equal(budget.step, 3);
  });

  it("stops at the step cap instead of running forever", () => {
    const { decision, budget } = decideNextTurn(answered("one more scene"), {
      ...FRESH,
      step: AUTOLOOP_MAX_STEPS - 1,
    });
    assert.match(stopReason(decision) ?? "", new RegExp(`limit of ${AUTOLOOP_MAX_STEPS} steps`));
    assert.equal(budget.step, AUTOLOOP_MAX_STEPS);
  });

  it("clears the error streak when a turn finally succeeds", () => {
    const { budget } = decideNextTurn(answered("back on track"), { ...FRESH, errorRetries: 2, rateWaits: 1 });
    assert.equal(budget.errorRetries, 0);
    assert.equal(budget.rateWaits, 1);
  });
});

describe("decideNextTurn — the metered free NVIDIA tier", () => {
  it("waits out a real Retry-After instead of hammering the account", () => {
    const { decision, budget } = decideNextTurn(refused("RATE_LIMITED", 42), FRESH);
    assert.equal(continueDelay(decision), 42_000);
    assert.equal(budget.rateWaits, 1);
    assert.equal(budget.step, 0, "a refused turn is not a completed step");
  });

  it("assumes a 60s Retry-After when the backend sent none", () => {
    const { decision } = decideNextTurn(refused("RATE_LIMITED"), FRESH);
    assert.equal(continueDelay(decision), 60_000);
  });

  it("stops when the tier asks for longer than this loop will hold a step", () => {
    const tooLong = AUTOLOOP_MAX_WAIT_MS / 1000 + 1;
    const { decision } = decideNextTurn(refused("RATE_LIMITED", tooLong), { ...FRESH, rateWaits: 1 });
    assert.match(stopReason(decision) ?? "", new RegExp(`${tooLong}s`));
  });

  it("stops once the wait budget is spent, naming the real refusal", () => {
    const { decision, budget } = decideNextTurn(refused("RATE_LIMITED", 30), {
      ...FRESH,
      rateWaits: AUTOLOOP_MAX_RATE_LIMIT_WAITS,
    });
    assert.match(
      stopReason(decision) ?? "",
      new RegExp(`rate-limited auto-work ${AUTOLOOP_MAX_RATE_LIMIT_WAITS + 1} times in a row`)
    );
    assert.equal(budget.rateWaits, AUTOLOOP_MAX_RATE_LIMIT_WAITS + 1);
  });
});

describe("decideNextTurn — real failures", () => {
  it("never retries when there is no backend at all", () => {
    const { decision } = decideNextTurn(refused("NO_AGENT_BACKEND"), FRESH);
    assert.match(stopReason(decision) ?? "", /no AI backend is available/);
  });

  it("retries an ordinary failure a bounded number of times, with growing backoff", () => {
    const first = decideNextTurn(refused("BAD_GATEWAY"), FRESH);
    assert.equal(continueDelay(first.decision), AUTOLOOP_ERROR_BACKOFF_MS);
    assert.equal(first.budget.errorRetries, 1);

    const second = decideNextTurn(refused("BAD_GATEWAY"), first.budget);
    assert.equal(continueDelay(second.decision), AUTOLOOP_ERROR_BACKOFF_MS * 2);

    const third = decideNextTurn(refused("BAD_GATEWAY"), second.budget);
    assert.match(stopReason(third.decision) ?? "", /failed 3 times in a row/);
    assert.match(stopReason(third.decision) ?? "", /said no/);
  });

  it("treats an unknown failure code as an ordinary failure, not as permission to loop on", () => {
    const { decision } = decideNextTurn(refused("SOMETHING_ELSE"), FRESH);
    assert.notEqual(continueDelay(decision), null);
  });
});

describe("toLoopTurn", () => {
  it("reads the backend's honest Retry-After out of a failed send", () => {
    const failed: SendResult = {
      ok: false,
      error: "The Script AI (nvidia · MODEL) is rate limited",
      code: "RATE_LIMITED",
      retryAfterSec: 17,
      userMessage: null,
      agent: null,
    };
    const turn = toLoopTurn(failed);
    assert.equal(turn.ok, false);
    assert.equal(!turn.ok && turn.retryAfterSec, 17);
    assert.equal(!turn.ok && turn.code, "RATE_LIMITED");
  });

  it("passes the model's real reply through untouched", () => {
    const ok: SendResult = {
      ok: true,
      data: {
        message: { id: "m2", content: "Created the two leads.", reasoning: null } as never,
      } as never,
    };
    assert.deepEqual(toLoopTurn(ok), { ok: true, content: "Created the two leads." });
  });

  it("survives a failure with no code at all (a network error, say)", () => {
    const turn = toLoopTurn({ ok: false, error: "Failed to fetch", code: null, retryAfterSec: null, userMessage: null, agent: null });
    assert.equal(!turn.ok && turn.code, "UNKNOWN");
  });
});
