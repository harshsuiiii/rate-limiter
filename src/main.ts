import type { FastifyBaseLogger } from 'fastify';
import { ConfigError, loadConfig } from './config.js';
import { RateLimiter } from './core/rate-limiter.js';
import { buildServer } from './http/server.js';
import { createMetrics } from './observability/metrics.js';
import { createRedisClient } from './redis.js';
import { RedisStore } from './stores/redis-store.js';

async function main(): Promise<void> {
  const config = loadConfig();

  let log: FastifyBaseLogger | undefined;
  let lastRedisError = 0;
  const redis = createRedisClient(config.redis, (error) => {
    // ioredis emits on every reconnect attempt; keep logs readable during an outage.
    const now = Date.now();
    if (now - lastRedisError < 10_000) return;
    lastRedisError = now;
    log?.warn({ err: error }, 'redis connection error');
  });

  const metrics = createMetrics();
  const limiter = new RateLimiter({
    store: new RedisStore(redis, { keyPrefix: config.redis.keyPrefix, clock: config.redis.clock }),
    rules: config.rules,
    failMode: config.limiter.failMode,
    timeoutMs: config.limiter.timeoutMs,
    denyCache: config.limiter.denyCache,
    circuitBreaker: config.limiter.circuitBreaker,
    hooks: {
      ...metrics.hooks,
      onCircuitStateChange(state) {
        metrics.hooks.onCircuitStateChange?.(state);
        log?.warn({ circuit: state }, 'redis circuit breaker state changed');
      },
    },
  });

  const app = buildServer({
    limiter,
    registry: metrics.registry,
    apiToken: config.server.apiToken,
    logger: { level: config.server.logLevel, redact: ['req.headers.authorization'] },
  });
  log = app.log;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      app.log.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, config.server.shutdownTimeoutMs);
    force.unref();
    try {
      await app.close(); // stop accepting, drain in-flight requests
      await limiter.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled rejection'));

  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(
    {
      rules: [...limiter.rules.keys()],
      failMode: limiter.failMode,
      redis: config.redis.clusterNodes?.length ? 'cluster' : 'standalone',
      auth: Boolean(config.server.apiToken),
    },
    'rate limiter ready',
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('fatal startup error', error);
  }
  process.exit(1);
});
