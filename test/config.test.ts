import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig, parseDuration } from '../src/config.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { MemoryStore } from '../src/stores/memory-store.js';

const MINIMAL = `
rules:
  - name: api
    algorithm: token-bucket
    limit: 100
    window: 1m
    burst: 150
`;

describe('config', () => {
  it('parses durations', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('42')).toBe(42);
    expect(() => parseDuration('1 week')).toThrow(/Invalid duration/);
  });

  it('applies defaults', () => {
    const config = loadConfig({}, () => MINIMAL);
    expect(config.server).toMatchObject({ host: '0.0.0.0', port: 8080, logLevel: 'info' });
    expect(config.redis).toMatchObject({ url: 'redis://localhost:6379', keyPrefix: 'rl', clock: 'server' });
    expect(config.limiter).toMatchObject({ failMode: 'local', timeoutMs: 100, denyCache: true });
    expect(config.limiter.circuitBreaker).toEqual({ failureThreshold: 5, cooldownMs: 5_000 });
    expect(config.rules).toEqual([{ name: 'api', algorithm: 'token-bucket', limit: 100, windowMs: 60_000, burst: 150 }]);
  });

  it('lets environment variables override the file', () => {
    const config = loadConfig(
      {
        PORT: '9000',
        API_TOKEN: 'a-very-long-secret-token',
        REDIS_URL: 'redis://redis:6379',
        REDIS_CLUSTER_NODES: 'n1:7000, n2:7001',
        FAIL_MODE: 'closed',
        STORE_TIMEOUT_MS: '25',
      },
      () => MINIMAL,
    );
    expect(config.server.port).toBe(9000);
    expect(config.server.apiToken).toBe('a-very-long-secret-token');
    expect(config.redis.url).toBe('redis://redis:6379');
    expect(config.redis.clusterNodes).toEqual(['n1:7000', 'n2:7001']);
    expect(config.limiter.failMode).toBe('closed');
    expect(config.limiter.timeoutMs).toBe(25);
  });

  it('reports every problem with its path', () => {
    const run = () =>
      parseConfig({
        server: { port: 'abc', unknown: 1 },
        rules: [
          { name: 'a', algorithm: 'leaky', limit: 1, window: '1s' },
          { name: 'a', algorithm: 'fixed-window', limit: 1, window: '1s', burst: 3 },
          { name: 'b', algorithm: 'fixed-window', limit: 1, window: 'soon' },
        ],
      });
    expect(run).toThrow(ConfigError);
    const message = (() => {
      try {
        run();
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('server.port');
    expect(message).toContain('rules.0.algorithm');
    expect(message).toContain('rules.2.window');
    expect(message).toContain('Unrecognized key');
  });

  it('requires at least one rule and a readable file', () => {
    expect(() => parseConfig({ rules: [] })).toThrow(/at least one rule/);
    expect(() =>
      loadConfig({}, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/Cannot read config file/);
  });

  it('ships a valid example config', () => {
    const config = loadConfig({ CONFIG_FILE: 'config/rate-limiter.yaml' }, (p) => readFileSync(p, 'utf8'));
    const limiter = new RateLimiter({ store: new MemoryStore({ sweepIntervalMs: 0 }), rules: config.rules });
    expect([...limiter.rules.keys()]).toEqual(['api-per-ip', 'api-per-user', 'login-attempts', 'export-daily']);
  });
});
