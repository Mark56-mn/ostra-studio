// apps/api/src/lib/rateLimit.ts
// A tiny in-memory sliding-window limiter for the HOSTED model calls (NVIDIA NIM / OPENAI_*).
//
// Why it exists: those keys are metered accounts. A stuck agent loop, a polling bug or an operator
// double-clicking "Run" could burn the day's free credits in seconds and leave every agent answering
// "HTTP 429" with no explanation. Refusing locally with a real retry hint is honest and cheap.
//
// Scope: per process (Render runs one instance). A refusal reports the real remaining budget and the
// exact retry-after, never a fabricated success. Pure timing inputs make it unit-testable.

export type RateLimitVerdict = {
  allowed: boolean;
  /** Calls left inside the current window (0 when refused). */
  remaining: number;
  /** Seconds until the oldest call in the window falls out — the honest retry-after. */
  retryAfterSec: number;
};

const hits = new Map<string, number[]>();

/** Drop timestamps outside the window so the map cannot grow without bound. */
function prune(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < timestamps.length && timestamps[i]! <= cutoff) i += 1;
  return i === 0 ? timestamps : timestamps.slice(i);
}

/**
 * Take one token for `key`. Returns whether the call may proceed. Never throws.
 * `limit` is clamped to >= 1 so a mis-set env var cannot disable the guard entirely.
 */
export function takeToken(key: string, limit: number, windowMs: number, nowMs: number = Date.now()): RateLimitVerdict {
  const capped = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000;
  const kept = prune(hits.get(key) ?? [], window, nowMs);
  if (kept.length >= capped) {
    hits.set(key, kept);
    const oldest = kept[0] ?? nowMs;
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((oldest + window - nowMs) / 1000)) };
  }
  kept.push(nowMs);
  hits.set(key, kept);
  return { allowed: true, remaining: Math.max(0, capped - kept.length), retryAfterSec: 0 };
}

/** Clear every bucket. Used by tests, and after an operator changes the hosted key. */
export function resetRateLimits(): void {
  hits.clear();
}
