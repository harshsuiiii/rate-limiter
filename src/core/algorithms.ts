import type { Algorithm, Rule, StoreResult } from './types.js';

/*
 * Reference implementations of each algorithm, used by MemoryStore.
 *
 * Every function here has a line-for-line twin in `stores/lua.ts`. Both use
 * only integer arithmetic (quantities are scaled by `windowMs` where a rate is
 * involved), so the two implementations produce identical results and the same
 * contract test suite runs against both. Change them together.
 *
 * Convention: an algorithm returns `next === undefined` when nothing needs to be
 * written. Denials never write (except sliding-log pruning), which keeps write
 * load flat when a client is hammering a limit.
 */

export interface Outcome<S> {
  result: StoreResult;
  next: S | undefined;
  /** How long `next` remains meaningful; after this it is equivalent to no state. */
  ttlMs: number;
}

// ---------------------------------------------------------------------------
// Token bucket. 1 token == windowMs units; refill is `limit` units per ms.

export interface TokenBucketState {
  units: number;
  ts: number;
}

export function tokenBucket(
  state: TokenBucketState | undefined,
  rule: Rule,
  cost: number,
  now: number,
): Outcome<TokenBucketState> {
  const W = rule.windowMs;
  const rate = rule.limit;
  const cap = rule.burst * W;
  const need = cost * W;

  let units = cap;
  if (state) {
    // Never move time backwards (only possible with client clocks and skew).
    if (now < state.ts) now = state.ts;
    units = Math.min(cap, state.units + (now - state.ts) * rate);
  }

  let allowed = false;
  let retryAfterMs = 0;
  let next: TokenBucketState | undefined;
  if (units >= need) {
    allowed = true;
    if (cost > 0) {
      units -= need;
      next = { units, ts: now };
    }
  } else {
    retryAfterMs = Math.ceil((need - units) / rate);
  }
  const resetAfterMs = Math.ceil((cap - units) / rate);
  return {
    result: { allowed, remaining: Math.floor(units / W), retryAfterMs, resetAfterMs },
    next,
    ttlMs: Math.max(resetAfterMs, 1),
  };
}

// ---------------------------------------------------------------------------
// Sliding window counter: estimate = prev * (W - elapsed) / W + curr.
// Compared in units scaled by W to stay integral.

export interface SlidingWindowState {
  ws: number; // start of the current window
  c: number; // units admitted in the current window
  p: number; // units admitted in the previous window
}

export function slidingWindow(
  state: SlidingWindowState | undefined,
  rule: Rule,
  cost: number,
  now: number,
): Outcome<SlidingWindowState> {
  const W = rule.windowMs;
  const limit = rule.limit;
  const start = now - (now % W);

  let ws = start;
  let c = 0;
  let p = 0;
  if (state) {
    ws = state.ws;
    c = state.c;
    p = state.p;
    if (start > ws) {
      p = start - ws === W ? c : 0;
      c = 0;
      ws = start;
    }
  }
  const elapsed = now - ws;
  const est = p * (W - elapsed) + c * W;

  let allowed = false;
  let retryAfterMs = 0;
  let remaining: number;
  let next: SlidingWindowState | undefined;
  if (est + cost * W <= limit * W) {
    allowed = true;
    remaining = Math.floor((limit * W - est - cost * W) / W);
    if (cost > 0) {
      c += cost;
      next = { ws, c, p };
    }
  } else {
    remaining = Math.max(0, Math.floor((limit * W - est) / W));
    if (c + cost <= limit) {
      // Admissible later in this window once the previous window's weight decays.
      const x = W - Math.floor(((limit - c - cost) * W) / p);
      retryAfterMs = Math.max(1, x - elapsed);
    } else {
      // Not before the next window, where today's count becomes the decaying `p`.
      const y = W - Math.floor(((limit - cost) * W) / c);
      retryAfterMs = W - elapsed + y;
    }
  }
  let resetAfterMs = 0;
  if (c > 0) resetAfterMs = ws + 2 * W - now;
  else if (p > 0) resetAfterMs = ws + W - now;
  return {
    result: { allowed, remaining, retryAfterMs, resetAfterMs },
    next,
    ttlMs: ws + 2 * W - now,
  };
}

// ---------------------------------------------------------------------------
// Fixed window counter, aligned to multiples of windowMs.

export interface FixedWindowState {
  ws: number;
  c: number;
}

export function fixedWindow(
  state: FixedWindowState | undefined,
  rule: Rule,
  cost: number,
  now: number,
): Outcome<FixedWindowState> {
  const W = rule.windowMs;
  const start = now - (now % W);
  let ws = start;
  let c = 0;
  if (state && state.ws >= start) {
    ws = state.ws;
    c = state.c;
  }

  let allowed = false;
  let retryAfterMs = 0;
  let next: FixedWindowState | undefined;
  if (c + cost <= rule.limit) {
    allowed = true;
    if (cost > 0) {
      c += cost;
      next = { ws, c };
    }
  } else {
    retryAfterMs = ws + W - now;
  }
  return {
    result: {
      allowed,
      remaining: Math.max(0, rule.limit - c),
      retryAfterMs,
      resetAfterMs: c > 0 ? ws + W - now : 0,
    },
    next,
    ttlMs: ws + W - now,
  };
}

// ---------------------------------------------------------------------------
// Sliding log: one timestamp per admitted unit; an entry at t is live while now < t + W.
// Mutates `state.entries` in place (it is owned by the store) to avoid O(limit) copies.

export interface SlidingLogState {
  entries: number[]; // ascending
}

export function slidingLog(
  state: SlidingLogState | undefined,
  rule: Rule,
  cost: number,
  now: number,
): Outcome<SlidingLogState> {
  const W = rule.windowMs;
  const entries = state?.entries ?? [];
  let expired = 0;
  while (expired < entries.length && entries[expired]! <= now - W) expired++;
  if (expired > 0) entries.splice(0, expired);

  const count = entries.length;
  let allowed = false;
  let retryAfterMs = 0;
  let remaining: number;
  if (count + cost <= rule.limit) {
    allowed = true;
    for (let i = 0; i < cost; i++) entries.push(now);
    // Wall clocks can step backwards (NTP); keep the log ordered like a Redis ZSET would.
    if (count > 0 && cost > 0 && now < entries[count - 1]!) entries.sort((a, b) => a - b);
    remaining = rule.limit - count - cost;
  } else {
    // Wait until enough of the oldest entries have aged out to fit `cost`.
    retryAfterMs = entries[count + cost - rule.limit - 1]! + W - now;
    remaining = Math.max(0, rule.limit - count);
  }
  const newest = entries[entries.length - 1];
  return {
    result: { allowed, remaining, retryAfterMs, resetAfterMs: newest === undefined ? 0 : newest + W - now },
    next: (allowed && cost > 0) || expired > 0 ? { entries } : undefined,
    ttlMs: W,
  };
}

// ---------------------------------------------------------------------------

type AlgorithmFn = (state: any, rule: Rule, cost: number, now: number) => Outcome<unknown>;

export const algorithms: Record<Algorithm, AlgorithmFn> = {
  'token-bucket': tokenBucket,
  'sliding-window': slidingWindow,
  'fixed-window': fixedWindow,
  'sliding-log': slidingLog,
};
