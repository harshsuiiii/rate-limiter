export const ALGORITHMS = ['token-bucket', 'sliding-window', 'sliding-log', 'fixed-window'] as const;

/**
 * - `token-bucket`:   smooth refill of `limit` tokens per `windowMs`, bursts up to `burst`. O(1) memory.
 * - `sliding-window`: weighted two-window counter (Cloudflare-style). O(1) memory, ~exact.
 * - `sliding-log`:    exact rolling window; stores one entry per admitted unit. O(limit) memory.
 * - `fixed-window`:   counter per aligned window. O(1) memory; allows 2x bursts at boundaries.
 */
export type Algorithm = (typeof ALGORITHMS)[number];

export interface RuleConfig {
  /** Unique rule identifier, e.g. `api-per-ip`. */
  name: string;
  algorithm: Algorithm;
  /** Units admitted per window (for token-bucket: units refilled per window). */
  limit: number;
  windowMs: number;
  /** token-bucket only: bucket capacity, i.e. the largest burst. Defaults to `limit`. */
  burst?: number;
}

/** A validated rule with all defaults applied. */
export interface Rule extends Required<RuleConfig> {
  /** The largest cost a single request may ask for under this rule. */
  readonly capacity: number;
}

/** Result of one atomic consume operation against a store. */
export interface StoreResult {
  allowed: boolean;
  /** Whole units still available after this request. */
  remaining: number;
  /** ms until a request of the same cost could succeed; 0 when allowed. */
  retryAfterMs: number;
  /** ms until the quota is fully replenished. */
  resetAfterMs: number;
}

export type DecisionSource =
  | 'store' // authoritative answer from the primary (shared) store
  | 'fallback' // primary unavailable; answered by the per-node fallback store
  | 'deny-cache' // short-circuited by a cached denial, primary not contacted
  | 'fail-open' // primary unavailable; admitted by policy
  | 'fail-closed'; // primary unavailable; rejected by policy

export interface Decision extends StoreResult {
  rule: string;
  key: string;
  limit: number;
  windowMs: number;
  source: DecisionSource;
}

export interface CheckRequest {
  rule: string;
  key: string;
  /** Units to consume. 0 inspects the current state without consuming. Default 1. */
  cost?: number;
}

export interface MultiDecision {
  allowed: boolean;
  decisions: Decision[];
  /** The decision a client should surface: the first denial, else the one with the least headroom. */
  binding: Decision;
}

export interface RateLimitStore {
  /** Atomically evaluate and (if admitted) consume `cost` units for `key` under `rule`. */
  consume(rule: Rule, key: string, cost: number): Promise<StoreResult>;
  /** Drop all state for `key` under `rule`. */
  reset(rule: Rule, key: string): Promise<void>;
  /** Throws if the store is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
