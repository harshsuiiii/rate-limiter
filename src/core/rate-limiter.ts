import { MemoryStore } from '../stores/memory-store.js';
import { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from './circuit-breaker.js';
import { InvalidRequestError, StoreTimeoutError, UnknownRuleError } from './errors.js';
import { normalizeRule } from './rules.js';
import type {
  CheckRequest,
  Decision,
  DecisionSource,
  MultiDecision,
  RateLimitStore,
  Rule,
  RuleConfig,
  StoreResult,
} from './types.js';

/**
 * What to do when the primary store errors, times out, or the breaker is open.
 * - `local`:  enforce limits per node with the fallback store (default). Degrades
 *             gracefully: limits stay bounded at roughly `nodes x limit`.
 * - `open`:   admit everything. Choose when availability beats protection.
 * - `closed`: reject everything. Choose when the limit guards something that
 *             must never be exceeded (e.g. a paid upstream quota).
 */
export type FailMode = 'local' | 'open' | 'closed';

export interface RateLimiterHooks {
  onDecision?(decision: Decision, latencyMs: number): void;
  onStoreError?(error: unknown, rule: string): void;
  onCircuitStateChange?(state: CircuitState): void;
}

export interface RateLimiterOptions {
  store: RateLimitStore;
  rules: RuleConfig[];
  failMode?: FailMode;
  /** Used when `failMode` is `local`. Defaults to a MemoryStore. */
  fallbackStore?: RateLimitStore;
  /** Deadline for a single store call. Default 100ms. */
  timeoutMs?: number;
  /** Pass `false` to disable. */
  circuitBreaker?: Omit<CircuitBreakerOptions, 'onStateChange' | 'now'> | false;
  /**
   * Remember denials locally until their retry time and answer repeat requests
   * without a store round-trip. Makes abusive clients nearly free to reject. Default true.
   */
  denyCache?: boolean | { maxKeys?: number };
  hooks?: RateLimiterHooks;
  now?: () => number;
}

const MAX_KEY_LENGTH = 512;
const MAX_COST = 1_000_000;

interface CachedDenial {
  until: number;
  cost: number;
  resetAt: number;
}

export class RateLimiter {
  readonly rules: ReadonlyMap<string, Rule>;
  readonly failMode: FailMode;
  private readonly store: RateLimitStore;
  private readonly fallback: RateLimitStore | undefined;
  private readonly ownsFallback: boolean;
  private readonly timeoutMs: number;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly denials: Map<string, CachedDenial> | undefined;
  private readonly denyCacheMax: number;
  private readonly hooks: RateLimiterHooks;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    const rules = new Map<string, Rule>();
    for (const config of options.rules) {
      const rule = normalizeRule(config);
      if (rules.has(rule.name)) throw new InvalidRequestError(`Duplicate rule name "${rule.name}"`);
      rules.set(rule.name, rule);
    }
    this.rules = rules;
    this.store = options.store;
    this.failMode = options.failMode ?? 'local';
    this.timeoutMs = options.timeoutMs ?? 100;
    this.hooks = options.hooks ?? {};
    this.now = options.now ?? Date.now;

    this.ownsFallback = this.failMode === 'local' && !options.fallbackStore;
    this.fallback =
      this.failMode === 'local' ? (options.fallbackStore ?? new MemoryStore({ now: this.now })) : undefined;

    this.breaker =
      options.circuitBreaker === false
        ? undefined
        : new CircuitBreaker({
            ...options.circuitBreaker,
            now: this.now,
            onStateChange: (s) => this.hooks.onCircuitStateChange?.(s),
          });

    const denyCache = options.denyCache ?? true;
    this.denials = denyCache ? new Map() : undefined;
    this.denyCacheMax = (typeof denyCache === 'object' && denyCache.maxKeys) || 100_000;
  }

  get circuitState(): CircuitState {
    return this.breaker?.state ?? 'closed';
  }

  getRule(name: string): Rule {
    const rule = this.rules.get(name);
    if (!rule) throw new UnknownRuleError(name);
    return rule;
  }

  /** Checks one rule. Throws only for caller errors (unknown rule, bad key/cost), never for store failures. */
  async check(ruleName: string, key: string, cost = 1): Promise<Decision> {
    const started = performance.now();
    const rule = this.getRule(ruleName);
    validate(rule, key, cost);

    const decision = await this.evaluate(rule, key, cost);
    this.hooks.onDecision?.(decision, performance.now() - started);
    return decision;
  }

  /**
   * Checks several rules concurrently (e.g. per-IP *and* per-user). The request
   * is allowed only if every rule allows it.
   *
   * Note: rules are independent keys, possibly on different cluster shards, so
   * this is not transactional. A rule that admits still consumes its quota even
   * if another rule denies. That is the standard trade-off; it errs on the side
   * of protection.
   */
  async checkMany(requests: CheckRequest[]): Promise<MultiDecision> {
    if (requests.length === 0) throw new InvalidRequestError('At least one check is required');
    // Validate everything up front so a bad entry doesn't consume quota from the good ones.
    for (const r of requests) validate(this.getRule(r.rule), r.key, r.cost ?? 1);

    const decisions = await Promise.all(requests.map((r) => this.check(r.rule, r.key, r.cost ?? 1)));
    const denied = decisions.find((d) => !d.allowed);
    const binding = denied ?? decisions.reduce((a, b) => (b.remaining / b.limit < a.remaining / a.limit ? b : a));
    return { allowed: !denied, decisions, binding };
  }

  /** Clears a key's state (e.g. an operator unblocking a customer). */
  async reset(ruleName: string, key: string): Promise<void> {
    const rule = this.getRule(ruleName);
    validate(rule, key, 0);
    this.denials?.delete(denialKey(rule, key));
    await Promise.all([this.store.reset(rule, key), this.fallback?.reset(rule, key)]);
  }

  /** Throws if the primary store is unreachable within the deadline. */
  async ping(): Promise<void> {
    await this.withTimeout(this.store.ping());
  }

  async close(): Promise<void> {
    await this.store.close();
    if (this.ownsFallback) await this.fallback?.close();
  }

  // -------------------------------------------------------------------------

  private async evaluate(rule: Rule, key: string, cost: number): Promise<Decision> {
    const cached = this.cachedDenial(rule, key, cost);
    if (cached) return cached;

    if (!this.breaker || this.breaker.allowRequest()) {
      try {
        const result = await this.withTimeout(this.store.consume(rule, key, cost));
        this.breaker?.success();
        this.rememberDenial(rule, key, cost, result);
        return this.decide(rule, key, result, 'store');
      } catch (error) {
        this.breaker?.failure();
        this.hooks.onStoreError?.(error, rule.name);
      }
    }
    return this.degrade(rule, key, cost);
  }

  private async degrade(rule: Rule, key: string, cost: number): Promise<Decision> {
    switch (this.failMode) {
      case 'open':
        return this.decide(
          rule,
          key,
          { allowed: true, remaining: rule.capacity, retryAfterMs: 0, resetAfterMs: 0 },
          'fail-open',
        );
      case 'closed': {
        const retryAfterMs = Math.max(this.breaker?.remainingCooldownMs ?? 0, 1_000);
        return this.decide(
          rule,
          key,
          { allowed: false, remaining: 0, retryAfterMs, resetAfterMs: retryAfterMs },
          'fail-closed',
        );
      }
      case 'local': {
        const result = await this.fallback!.consume(rule, key, cost);
        return this.decide(rule, key, result, 'fallback');
      }
    }
  }

  private decide(rule: Rule, key: string, result: StoreResult, source: DecisionSource): Decision {
    return { ...result, rule: rule.name, key, limit: rule.limit, windowMs: rule.windowMs, source };
  }

  private cachedDenial(rule: Rule, key: string, cost: number): Decision | undefined {
    if (!this.denials || cost === 0) return undefined;
    const id = denialKey(rule, key);
    const hit = this.denials.get(id);
    if (!hit) return undefined;
    const now = this.now();
    if (now >= hit.until) {
      this.denials.delete(id);
      return undefined;
    }
    // A cheaper request might fit sooner than the cached retry time, so only
    // short-circuit requests at least as expensive as the one that was denied.
    if (cost < hit.cost) return undefined;
    return this.decide(
      rule,
      key,
      {
        allowed: false,
        remaining: 0,
        retryAfterMs: hit.until - now,
        resetAfterMs: Math.max(hit.resetAt - now, hit.until - now),
      },
      'deny-cache',
    );
  }

  private rememberDenial(rule: Rule, key: string, cost: number, result: StoreResult): void {
    if (!this.denials || result.allowed || result.retryAfterMs <= 0) return;
    const now = this.now();
    const id = denialKey(rule, key);
    this.denials.delete(id);
    this.denials.set(id, { until: now + result.retryAfterMs, cost, resetAt: now + result.resetAfterMs });
    while (this.denials.size > this.denyCacheMax) {
      const oldest = this.denials.keys().next();
      if (oldest.done) break;
      this.denials.delete(oldest.value);
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreTimeoutError(this.timeoutMs)), this.timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

function validate(rule: Rule, key: string, cost: number): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new InvalidRequestError(`key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
  }
  if (!Number.isSafeInteger(cost) || cost < 0 || cost > MAX_COST) {
    throw new InvalidRequestError(`cost must be an integer between 0 and ${MAX_COST}`);
  }
  if (cost > rule.capacity) {
    throw new InvalidRequestError(
      `cost ${cost} exceeds the capacity (${rule.capacity}) of rule "${rule.name}" and could never be admitted`,
    );
  }
}

function denialKey(rule: Rule, key: string): string {
  return `${rule.name}\u0000${key}`;
}
