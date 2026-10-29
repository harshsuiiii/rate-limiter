import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { rateLimit, type MiddlewareOptions } from '../src/http/middleware.js';
import { MemoryStore } from '../src/stores/memory-store.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function serve(options: Omit<MiddlewareOptions, 'rule'>): Promise<string> {
  const limiter = new RateLimiter({
    store: new MemoryStore({ sweepIntervalMs: 0 }),
    rules: [{ name: 'api', algorithm: 'sliding-log', limit: 2, windowMs: 60_000 }],
  });
  const mw = rateLimit(limiter, { rule: 'api', ...options });
  server = createServer((req, res) =>
    mw(req, res, (error) => {
      res.statusCode = error ? 500 : 200;
      res.end(error ? 'error' : 'ok');
    }),
  );
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('rateLimit middleware', () => {
  it('passes allowed requests with headers and answers 429 when limited', async () => {
    const url = await serve({});
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    await fetch(url);
    const limited = await fetch(url);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBe(60);
    expect(await limited.json()).toEqual({ error: 'Too Many Requests', retryAfterSeconds: 60 });
  });

  it('limits by a custom key and skips requests without one', async () => {
    const url = await serve({ key: (req) => req.headers['x-api-key'] as string | undefined });
    for (let i = 0; i < 2; i++) await fetch(url, { headers: { 'x-api-key': 'a' } });
    expect((await fetch(url, { headers: { 'x-api-key': 'a' } })).status).toBe(429);
    expect((await fetch(url, { headers: { 'x-api-key': 'b' } })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await fetch(url)).status).toBe(200);
  });

  it('supports per-request cost and custom limited responses', async () => {
    const url = await serve({
      cost: () => 2,
      onLimited: (_req, res) => {
        res.statusCode = 503;
        res.end('slow down');
      },
    });
    expect((await fetch(url)).status).toBe(200);
    const limited = await fetch(url);
    expect(limited.status).toBe(503);
    expect(await limited.text()).toBe('slow down');
  });

  it('forwards caller errors (e.g. an invalid cost) to next()', async () => {
    const url = await serve({ cost: () => 99 });
    expect((await fetch(url)).status).toBe(500);
  });
});
