import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeRule } from '../src/core/rules.js';
import type { RateLimitStore, Rule, RuleConfig } from '../src/core/types.js';

/** Aligned to every window size used below, so window boundaries are predictable. */
export const T0 = 1_700_000_000_000;

export type StoreFactory = (now: () => number) => RateLimitStore | Promise<RateLimitStore>;

/**
 * Behavioural contract every store must satisfy. Runs against MemoryStore and
 * RedisStore (with a client clock), which proves the Lua scripts and the
 * TypeScript reference implementations agree exactly.
 */
export function storeContract(name: string, factory: StoreFactory): void {
  describe(`${name}: store contract`, () => {
    let now: number;
    let store: RateLimitStore;
    let n = 0;
    const key = () => `client-${++n}`;
    const rule = (c: Omit<RuleConfig, 'name'> & { name?: string }): Rule =>
      normalizeRule({ name: c.name ?? `r-${c.algorithm}`, ...c });
    const at = (t: number) => {
      now = T0 + t;
    };

    beforeEach(async () => {
      now = T0;
      store = await factory(() => now);
    });

    describe.each(['token-bucket', 'sliding-window', 'sliding-log', 'fixed-window'] as const)('%s', (algorithm) => {
      it('admits exactly `limit` units then denies', async () => {
        const r = rule({ algorithm, limit: 5, windowMs: 60_000 });
        const k = key();
        for (let i = 4; i >= 0; i--) {
          expect(await store.consume(r, k, 1)).toMatchObject({ allowed: true, remaining: i, retryAfterMs: 0 });
        }
        const denied = await store.consume(r, k, 1);
        expect(denied.allowed).toBe(false);
        expect(denied.remaining).toBe(0);
        expect(denied.retryAfterMs).toBeGreaterThan(0);
      });

      it('isolates keys and rules', async () => {
        const a = rule({ algorithm, limit: 1, windowMs: 60_000, name: 'a' });
        const b = rule({ algorithm, limit: 1, windowMs: 60_000, name: 'b' });
        const k1 = key();
        const k2 = key();
        expect((await store.consume(a, k1, 1)).allowed).toBe(true);
        expect((await store.consume(a, k1, 1)).allowed).toBe(false);
        expect((await store.consume(a, k2, 1)).allowed).toBe(true);
        expect((await store.consume(b, k1, 1)).allowed).toBe(true);
      });

      it('cost 0 inspects without consuming', async () => {
        const r = rule({ algorithm, limit: 3, windowMs: 60_000 });
        const k = key();
        await store.consume(r, k, 1);
        expect(await store.consume(r, k, 0)).toMatchObject({ allowed: true, remaining: 2 });
        expect(await store.consume(r, k, 0)).toMatchObject({ allowed: true, remaining: 2 });
      });

      it('reset clears state', async () => {
        const r = rule({ algorithm, limit: 1, windowMs: 60_000 });
        const k = key();
        await store.consume(r, k, 1);
        expect((await store.consume(r, k, 1)).allowed).toBe(false);
        await store.reset(r, k);
        expect((await store.consume(r, k, 1)).allowed).toBe(true);
      });

      it('retryAfterMs is exact: denied 1ms before, admitted at', async () => {
        const r = rule({ algorithm, limit: 4, windowMs: 1_000 });
        const k = key();
        at(0);
        await store.consume(r, k, 2);
        at(50);
        await store.consume(r, k, 2);
        at(100);
        const denied = await store.consume(r, k, 1);
        expect(denied.allowed).toBe(false);
        at(100 + denied.retryAfterMs - 1);
        expect((await store.consume(r, k, 1)).allowed).toBe(false);
        at(100 + denied.retryAfterMs);
        expect((await store.consume(r, k, 1)).allowed).toBe(true);
      });
    });

    describe('token-bucket', () => {
      const r = () => rule({ algorithm: 'token-bucket', limit: 10, windowMs: 1_000 });

      it('refills continuously at limit/window', async () => {
        const k = key();
        await store.consume(r(), k, 10);
        expect(await store.consume(r(), k, 1)).toMatchObject({ allowed: false, retryAfterMs: 100, resetAfterMs: 1_000 });
        at(100);
        expect(await store.consume(r(), k, 1)).toMatchObject({ allowed: true, remaining: 0 });
        at(550);
        expect(await store.consume(r(), k, 1)).toMatchObject({ allowed: true, remaining: 3, resetAfterMs: 650 });
      });

      it('never exceeds capacity after long idle', async () => {
        const k = key();
        await store.consume(r(), k, 1);
        at(3_600_000);
        expect(await store.consume(r(), k, 1)).toMatchObject({ allowed: true, remaining: 9 });
      });

      it('supports bursts above the sustained rate', async () => {
        const burst = rule({ algorithm: 'token-bucket', limit: 10, windowMs: 1_000, burst: 25, name: 'burst' });
        const k = key();
        expect(await store.consume(burst, k, 25)).toMatchObject({ allowed: true, remaining: 0 });
        expect(await store.consume(burst, k, 1)).toMatchObject({ allowed: false, retryAfterMs: 100, resetAfterMs: 2_500 });
      });

      it('computes retry for weighted costs', async () => {
        const k = key();
        await store.consume(r(), k, 8);
        expect(await store.consume(r(), k, 5)).toMatchObject({ allowed: false, remaining: 2, retryAfterMs: 300 });
        expect(await store.consume(r(), k, 2)).toMatchObject({ allowed: true, remaining: 0 });
      });
    });

    describe('fixed-window', () => {
      it('resets at the aligned window boundary', async () => {
        const r = rule({ algorithm: 'fixed-window', limit: 3, windowMs: 1_000 });
        const k = key();
        at(500);
        await store.consume(r, k, 3);
        expect(await store.consume(r, k, 1)).toMatchObject({ allowed: false, retryAfterMs: 500, resetAfterMs: 500 });
        at(1_000);
        expect(await store.consume(r, k, 1)).toMatchObject({ allowed: true, remaining: 2, resetAfterMs: 1_000 });
      });
    });

    describe('sliding-window', () => {
      const r = () => rule({ algorithm: 'sliding-window', limit: 10, windowMs: 1_000 });

      it('carries a weighted share of the previous window', async () => {
        const k = key();
        await store.consume(r(), k, 6);
        at(1_500); // previous window weight 50% => 3 units still counted
        expect(await store.consume(r(), k, 7)).toMatchObject({ allowed: true, remaining: 0 });
        expect((await store.consume(r(), k, 1)).allowed).toBe(false);
      });

      it('forgets windows older than the previous one', async () => {
        const k = key();
        await store.consume(r(), k, 10);
        at(2_000);
        expect(await store.consume(r(), k, 10)).toMatchObject({ allowed: true, remaining: 0 });
      });

      it('predicts retry across the window boundary', async () => {
        const k = key();
        await store.consume(r(), k, 10);
        expect(await store.consume(r(), k, 1)).toMatchObject({ allowed: false, retryAfterMs: 1_100 });
        at(1_099);
        expect((await store.consume(r(), k, 1)).allowed).toBe(false);
        at(1_100);
        expect((await store.consume(r(), k, 1)).allowed).toBe(true);
      });
    });

    describe('sliding-log', () => {
      it('admits again exactly when the oldest entries age out', async () => {
        const r = rule({ algorithm: 'sliding-log', limit: 5, windowMs: 1_000 });
        const k = key();
        await store.consume(r, k, 3);
        at(100);
        await store.consume(r, k, 2);
        at(200);
        expect(await store.consume(r, k, 3)).toMatchObject({ allowed: false, retryAfterMs: 800, resetAfterMs: 900 });
        at(999);
        expect((await store.consume(r, k, 1)).allowed).toBe(false);
        at(1_000);
        expect(await store.consume(r, k, 3)).toMatchObject({ allowed: true, remaining: 0 });
      });
    });
  });
}
