import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/core/circuit-breaker.js';
import { InvalidRequestError, InvalidRuleError, StoreTimeoutError, UnknownRuleError } from '../src/core/errors.js';
import { RateLimiter, type RateLimiterOptions } from '../src/core/rate-limiter.js';
import type { RateLimitStore, Rule, RuleConfig, StoreResult } from '../src/core/types.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { T0 } from './store-contract.js';

/** A store whose health the test controls. Healthy behaviour delegates to a MemoryStore. */
class ControlledStore implements RateLimitStore {
  mode: 'ok' | 'fail' | 'hang' = 'ok';
  calls = 0;
  constructor(private readonly inner: MemoryStore) {}

  consume(rule: Rule, key: string, cost: number): Promise<StoreResult> {
    this.calls++;
    if (this.mode === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
    if (this.mode === 'hang') return new Promise(() => {});
    return this.inner.consume(rule, key, cost);
  }
  reset(rule: Rule, key: string) {
    return this.inner.reset(rule, key);
  }
  async ping() {
    if (this.mode !== 'ok') throw new Error('down');
  }
  close() {
    return this.inner.close();
  }
}

const RULES: RuleConfig[] = [
  { name: 'per-ip', algorithm: 'fixed-window', limit: 2, windowMs: 1_000 },
  { name: 'per-user', algorithm: 'token-bucket', limit: 10, windowMs: 1_000 },
];

function setup(options: Partial<RateLimiterOptions> = {}) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const store = new ControlledStore(new MemoryStore({ now, sweepIntervalMs: 0 }));
  const limiter = new RateLimiter({
    store,
    rules: RULES,
    now,
    fallbackStore: new MemoryStore({ now, sweepIntervalMs: 0 }),
    ...options,
  });
  return { clock, store, limiter };
}

describe('RateLimiter', () => {
  it('returns authoritative decisions from the store', async () => {
    const { limiter } = setup();
    expect(await limiter.check('per-ip', '1.2.3.4')).toMatchObject({
      allowed: true,
      remaining: 1,
      limit: 2,
      windowMs: 1_000,
      rule: 'per-ip',
      key: '1.2.3.4',
      source: 'store',
    });
  });

  describe('validation', () => {
    it('rejects unknown rules, bad keys and impossible costs', async () => {
      const { limiter } = setup();
      await expect(limiter.check('nope', 'k')).rejects.toBeInstanceOf(UnknownRuleError);
      await expect(limiter.check('per-ip', '')).rejects.toBeInstanceOf(InvalidRequestError);
      await expect(limiter.check('per-ip', 'x'.repeat(513))).rejects.toBeInstanceOf(InvalidRequestError);
      await expect(limiter.check('per-ip', 'k', -1)).rejects.toBeInstanceOf(InvalidRequestError);
      await expect(limiter.check('per-ip', 'k', 1.5)).rejects.toBeInstanceOf(InvalidRequestError);
      await expect(limiter.check('per-ip', 'k', 3)).rejects.toThrow(/exceeds the capacity/);
    });

    it('rejects invalid rule definitions at construction', () => {
      const store = new MemoryStore({ sweepIntervalMs: 0 });
      const make = (rules: RuleConfig[]) => () => new RateLimiter({ store, rules });
      expect(make([{ name: 'bad name', algorithm: 'fixed-window', limit: 1, windowMs: 1 }])).toThrow(InvalidRuleError);
      expect(make([{ name: 'a', algorithm: 'fixed-window', limit: 0, windowMs: 1 }])).toThrow(InvalidRuleError);
      expect(make([{ name: 'a', algorithm: 'fixed-window', limit: 1, windowMs: 1, burst: 2 }])).toThrow(/burst/);
      expect(make([{ name: 'a', algorithm: 'token-bucket', limit: 2 ** 40, windowMs: 2 ** 20 }])).toThrow(/2\^53/);
      expect(make([RULES[0]!, RULES[0]!])).toThrow(/Duplicate/);
    });
  });

  describe('when the store fails', () => {
    it('failMode=local enforces per-node limits with the fallback store', async () => {
      const { limiter, store } = setup({ failMode: 'local' });
      store.mode = 'fail';
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await limiter.check('per-ip', 'k'));
      expect(results.map((d) => [d.allowed, d.source])).toEqual([
        [true, 'fallback'],
        [true, 'fallback'],
        [false, 'fallback'],
      ]);
    });

    it('failMode=open admits', async () => {
      const { limiter, store } = setup({ failMode: 'open' });
      store.mode = 'fail';
      expect(await limiter.check('per-ip', 'k')).toMatchObject({ allowed: true, source: 'fail-open' });
    });

    it('failMode=closed rejects with a retry hint', async () => {
      const { limiter, store } = setup({ failMode: 'closed' });
      store.mode = 'fail';
      const d = await limiter.check('per-ip', 'k');
      expect(d).toMatchObject({ allowed: false, source: 'fail-closed' });
      expect(d.retryAfterMs).toBeGreaterThanOrEqual(1_000);
    });

    it('bounds latency with a deadline and reports the timeout', async () => {
      const onStoreError = vi.fn();
      const { limiter, store } = setup({ timeoutMs: 20, hooks: { onStoreError } });
      store.mode = 'hang';
      const started = performance.now();
      expect(await limiter.check('per-ip', 'k')).toMatchObject({ allowed: true, source: 'fallback' });
      expect(performance.now() - started).toBeLessThan(500);
      expect(onStoreError).toHaveBeenCalledWith(expect.any(StoreTimeoutError), 'per-ip');
    });

    it('trips the circuit breaker, stops calling the store, then recovers via a probe', async () => {
      const onCircuitStateChange = vi.fn();
      const { limiter, store, clock } = setup({
        circuitBreaker: { failureThreshold: 3, cooldownMs: 5_000 },
        hooks: { onCircuitStateChange },
        denyCache: false,
      });
      store.mode = 'fail';
      for (let i = 0; i < 10; i++) await limiter.check('per-user', 'k');
      expect(store.calls).toBe(3);
      expect(limiter.circuitState).toBe('open');

      store.mode = 'ok';
      clock.now += 5_000;
      expect(await limiter.check('per-user', 'k')).toMatchObject({ source: 'store' });
      expect(limiter.circuitState).toBe('closed');
      expect(onCircuitStateChange.mock.calls.map((c) => c[0])).toEqual(['open', 'half-open', 'closed']);
    });

    it('never throws store errors to the caller', async () => {
      const { limiter, store } = setup({ failMode: 'local' });
      store.mode = 'fail';
      await expect(limiter.checkMany([{ rule: 'per-ip', key: 'a' }, { rule: 'per-user', key: 'b' }])).resolves.toBeDefined();
    });
  });

  describe('deny cache', () => {
    it('answers repeat offenders locally until their retry time', async () => {
      const { limiter, store, clock } = setup();
      await limiter.check('per-ip', 'k');
      await limiter.check('per-ip', 'k');
      expect(await limiter.check('per-ip', 'k')).toMatchObject({ allowed: false, source: 'store', retryAfterMs: 1_000 });
      expect(store.calls).toBe(3);

      clock.now += 400;
      expect(await limiter.check('per-ip', 'k')).toMatchObject({ allowed: false, source: 'deny-cache', retryAfterMs: 600 });
      expect(store.calls).toBe(3);

      clock.now += 600;
      expect(await limiter.check('per-ip', 'k')).toMatchObject({ allowed: true, source: 'store' });
    });

    it('lets cheaper requests and inspections through to the store', async () => {
      const { limiter, store } = setup();
      await limiter.check('per-user', 'k', 9);
      expect(await limiter.check('per-user', 'k', 5)).toMatchObject({ allowed: false, source: 'store' });
      expect(await limiter.check('per-user', 'k', 1)).toMatchObject({ allowed: true, source: 'store' });
      await limiter.check('per-user', 'k', 0);
      expect(store.calls).toBe(4);
    });

    it('is cleared by reset', async () => {
      const { limiter } = setup();
      for (let i = 0; i < 3; i++) await limiter.check('per-ip', 'k');
      await limiter.reset('per-ip', 'k');
      expect(await limiter.check('per-ip', 'k')).toMatchObject({ allowed: true, source: 'store' });
    });
  });

  describe('checkMany', () => {
    it('allows only when every rule allows, and reports the binding rule', async () => {
      const { limiter } = setup();
      const checks = [
        { rule: 'per-ip', key: 'ip' },
        { rule: 'per-user', key: 'u' },
      ];
      const first = await limiter.checkMany(checks);
      expect(first.allowed).toBe(true);
      expect(first.binding.rule).toBe('per-ip'); // 1/2 left beats 9/10
      await limiter.checkMany(checks);
      const third = await limiter.checkMany(checks);
      expect(third.allowed).toBe(false);
      expect(third.binding).toMatchObject({ rule: 'per-ip', allowed: false });
    });

    it('validates every request before consuming any quota', async () => {
      const { limiter, store } = setup();
      await expect(
        limiter.checkMany([{ rule: 'per-ip', key: 'ip' }, { rule: 'missing', key: 'u' }]),
      ).rejects.toBeInstanceOf(UnknownRuleError);
      expect(store.calls).toBe(0);
    });
  });

  it('reports every decision to hooks', async () => {
    const onDecision = vi.fn();
    const { limiter } = setup({ hooks: { onDecision } });
    await limiter.check('per-ip', 'k');
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ rule: 'per-ip', allowed: true }), expect.any(Number));
  });
});

describe('CircuitBreaker', () => {
  it('lets exactly one probe through when half-open and reopens on probe failure', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => now });
    breaker.failure();
    expect(breaker.allowRequest()).toBe(true);
    breaker.failure();
    expect(breaker.state).toBe('open');
    expect(breaker.allowRequest()).toBe(false);
    expect(breaker.remainingCooldownMs).toBe(100);

    now = 100;
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.state).toBe('half-open');
    expect(breaker.allowRequest()).toBe(false); // probe already in flight
    breaker.failure();
    expect(breaker.state).toBe('open');

    now = 200;
    expect(breaker.allowRequest()).toBe(true);
    breaker.success();
    expect(breaker.state).toBe('closed');
  });

  it('resets the failure count on success', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.failure();
    breaker.success();
    breaker.failure();
    expect(breaker.state).toBe('closed');
  });
});
