import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { buildServer } from '../src/http/server.js';
import { createMetrics } from '../src/observability/metrics.js';
import { MemoryStore } from '../src/stores/memory-store.js';

const TOKEN = 'test-token-0123456789';

function setup(apiToken?: string) {
  const metrics = createMetrics({ defaultMetrics: false });
  const limiter = new RateLimiter({
    store: new MemoryStore({ sweepIntervalMs: 0 }),
    rules: [
      { name: 'api', algorithm: 'fixed-window', limit: 2, windowMs: 60_000 },
      { name: 'burst', algorithm: 'token-bucket', limit: 10, windowMs: 1_000, burst: 20 },
    ],
    hooks: metrics.hooks,
  });
  return buildServer({ limiter, registry: metrics.registry, apiToken });
}

let app: ReturnType<typeof setup>;
afterEach(async () => {
  await app?.close();
});

const check = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/check', payload: body as object, headers });

describe('HTTP service', () => {
  it('POST /v1/check returns decisions and RateLimit headers', async () => {
    app = setup();
    const ok = await check({ rule: 'api', key: 'user-1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ allowed: true, remaining: 1, limit: 2, source: 'store' });
    expect(ok.headers['ratelimit-limit']).toBe('2');
    expect(ok.headers['ratelimit-remaining']).toBe('1');
    expect(ok.headers['ratelimit-policy']).toBe('2;w=60');

    await check({ rule: 'api', key: 'user-1' });
    const denied = await check({ rule: 'api', key: 'user-1' });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ allowed: false, remaining: 0 });
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('honours cost', async () => {
    app = setup();
    expect((await check({ rule: 'burst', key: 'k', cost: 15 })).json()).toMatchObject({ allowed: true, remaining: 5 });
  });

  it.each([
    [{ key: 'k' }, 400],
    [{ rule: 'api', key: '' }, 400],
    [{ rule: 'api', key: 'k', cost: -1 }, 400],
    [{ rule: 'api', key: 'k', extra: true }, 400],
    [{ rule: 'api', key: 'k', cost: 3 }, 400],
    [{ rule: 'missing', key: 'k' }, 404],
  ])('rejects invalid request %j with %i', async (body, status) => {
    app = setup();
    const res = await check(body);
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toEqual(expect.any(String));
  });

  it('POST /v1/check/batch combines rules', async () => {
    app = setup();
    const batch = () =>
      app.inject({
        method: 'POST',
        url: '/v1/check/batch',
        payload: { checks: [{ rule: 'api', key: 'ip' }, { rule: 'burst', key: 'user' }] },
      });
    await batch();
    await batch();
    const res = await batch();
    expect(res.json()).toMatchObject({ allowed: false, binding: 'api' });
    expect(res.json().decisions).toHaveLength(2);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('POST /v1/reset unblocks a key', async () => {
    app = setup();
    for (let i = 0; i < 3; i++) await check({ rule: 'api', key: 'k' });
    const reset = await app.inject({ method: 'POST', url: '/v1/reset', payload: { rule: 'api', key: 'k' } });
    expect(reset.statusCode).toBe(204);
    expect((await check({ rule: 'api', key: 'k' })).json().allowed).toBe(true);
  });

  it('GET /v1/rules lists configuration', async () => {
    app = setup();
    const res = await app.inject({ method: 'GET', url: '/v1/rules' });
    expect(res.json().rules).toEqual([
      { name: 'api', algorithm: 'fixed-window', limit: 2, windowMs: 60_000 },
      { name: 'burst', algorithm: 'token-bucket', limit: 10, windowMs: 1_000, burst: 20 },
    ]);
  });

  it('requires the bearer token on /v1/* when configured, but not on probes', async () => {
    app = setup(TOKEN);
    expect((await check({ rule: 'api', key: 'k' })).statusCode).toBe(401);
    expect((await check({ rule: 'api', key: 'k' }, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await check({ rule: 'api', key: 'k' }, { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('exposes health, readiness and metrics', async () => {
    app = setup();
    await check({ rule: 'api', key: 'k' });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).json()).toMatchObject({ status: 'ready' });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('ratelimit_decisions_total{rule="api",outcome="allowed",source="store"} 1');
    expect(metrics.body).toContain('ratelimit_circuit_state 0');
  });
});
