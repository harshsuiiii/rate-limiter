import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeRule } from '../src/core/rules.js';
import { ALGORITHMS } from '../src/core/types.js';
import { RedisStore } from '../src/stores/redis-store.js';
import { storeContract } from './store-contract.js';

/*
 * Integration tests against a real Redis (default redis://localhost:6379,
 * override with REDIS_URL; `npm run redis:up` starts one in Docker).
 * Skipped when Redis is unreachable so the unit suite still runs anywhere.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 500, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await redisAvailable();
if (!available) console.warn(`[redis tests] skipped: no Redis at ${REDIS_URL}`);

const clients: Redis[] = [];
function client(): Redis {
  const c = new Redis(REDIS_URL, { enableAutoPipelining: true });
  clients.push(c);
  return c;
}
afterAll(async () => {
  await Promise.all(clients.map((c) => c.quit()));
});

describe.runIf(available)('RedisStore (live Redis)', () => {
  storeContract('RedisStore', (now) =>
    new RedisStore(client(), { keyPrefix: `test:${randomUUID()}`, clock: 'client', now }),
  );

  it.each(ALGORITHMS)(
    '%s: is exact under concurrent load from many nodes',
    async (algorithm) => {
      // 8 independent connections stand in for 8 application nodes racing on one key.
      const prefix = `test:${randomUUID()}`;
      const nodes = Array.from({ length: 8 }, () => new RedisStore(client(), { keyPrefix: prefix }));
      const rule = normalizeRule({ name: 'race', algorithm, limit: 100, windowMs: 3_600_000 });

      const results = await Promise.all(
        Array.from({ length: 600 }, (_, i) => nodes[i % nodes.length]!.consume(rule, 'hot-key', 1)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(100);
    },
  );

  it('uses the Redis server clock by default', async () => {
    const store = new RedisStore(client(), { keyPrefix: `test:${randomUUID()}` });
    const rule = normalizeRule({ name: 'srv', algorithm: 'token-bucket', limit: 10, windowMs: 60_000 });
    expect(await store.consume(rule, 'k', 4)).toMatchObject({ allowed: true, remaining: 6 });
    const next = await store.consume(rule, 'k', 7);
    expect(next.allowed).toBe(false);
    // ~1 token is missing at 6s/token; allow for the ms elapsed between calls.
    expect(next.retryAfterMs).toBeGreaterThan(5_000);
    expect(next.retryAfterMs).toBeLessThanOrEqual(6_000);
  });

  it('keeps all keys for a (rule, key) pair in one cluster hash slot, with TTLs', async () => {
    const redis = client();
    const store = new RedisStore(redis, { keyPrefix: `test:${randomUUID()}` });
    const rule = normalizeRule({ name: 'log', algorithm: 'sliding-log', limit: 3, windowMs: 10_000 });
    const keys = store.keysFor(rule, 'user:42');
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toContain('{log:user:42}');

    await store.consume(rule, 'user:42', 2);
    for (const k of keys) {
      const ttl = await redis.pttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10_000);
    }
    await store.reset(rule, 'user:42');
    expect(await redis.exists(...keys)).toBe(0);
  });

  it('recovers when Redis loses its script cache (failover / SCRIPT FLUSH)', async () => {
    const redis = client();
    const store = new RedisStore(redis, { keyPrefix: `test:${randomUUID()}` });
    const rule = normalizeRule({ name: 'flush', algorithm: 'fixed-window', limit: 5, windowMs: 60_000 });
    await store.consume(rule, 'k', 1);
    await redis.script('FLUSH');
    expect(await store.consume(rule, 'k', 1)).toMatchObject({ allowed: true, remaining: 3 });
  });
});
