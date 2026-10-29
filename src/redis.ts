import { Cluster, Redis, type RedisOptions } from 'ioredis';
import type { Config } from './config.js';

/**
 * Redis client tuned for a latency-critical, fail-fast workload:
 * - no offline queue: while disconnected, commands fail immediately and the
 *   limiter's fail mode takes over instead of requests piling up;
 * - one retry per command, capped reconnect backoff;
 * - auto-pipelining: concurrent checks share round-trips, a large throughput win.
 */
export function createRedisClient(config: Config['redis'], onError: (error: Error) => void): Redis | Cluster {
  const common: RedisOptions = {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: config.connectTimeoutMs,
    retryStrategy: (attempt) => Math.min(50 * 2 ** attempt, 2_000),
  };

  const client = config.clusterNodes?.length
    ? new Cluster(
        config.clusterNodes.map((node) => {
          const [host, port] = node.split(':');
          return { host: host!, port: Number(port ?? 6379) };
        }),
        {
          enableOfflineQueue: false,
          enableAutoPipelining: true,
          redisOptions: common,
          clusterRetryStrategy: (attempt) => Math.min(100 * 2 ** attempt, 2_000),
        },
      )
    : new Redis(config.url, { ...common, enableAutoPipelining: true });

  client.on('error', onError);
  return client;
}
