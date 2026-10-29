import type { Cluster, Redis } from 'ioredis';
import type { Algorithm, RateLimitStore, Rule, StoreResult } from '../core/types.js';
import { FIXED_WINDOW, SLIDING_LOG, SLIDING_WINDOW, TOKEN_BUCKET } from './lua.js';

type ScriptReply = [number, number, number, number];
type ScriptFn = (...args: Array<string | number>) => Promise<ScriptReply>;

const COMMANDS: Record<Algorithm, { name: string; lua: string; suffixes: string[] }> = {
  'token-bucket': { name: 'rlTokenBucket', lua: TOKEN_BUCKET, suffixes: ['tb'] },
  'sliding-window': { name: 'rlSlidingWindow', lua: SLIDING_WINDOW, suffixes: ['sw'] },
  'fixed-window': { name: 'rlFixedWindow', lua: FIXED_WINDOW, suffixes: ['fw'] },
  'sliding-log': { name: 'rlSlidingLog', lua: SLIDING_LOG, suffixes: ['sl', 'sl:seq'] },
};

export interface RedisStoreOptions {
  /** Prefix for every key this store writes. Default `rl`. */
  keyPrefix?: string;
  /**
   * Which clock defines "now".
   * - `server` (default): Redis `TIME`, so skew between application nodes cannot affect limits.
   * - `client`: the provided `now()` function; only for tests or single-writer setups.
   */
  clock?: 'server' | 'client';
  now?: () => number;
}

/**
 * Redis-backed store. Works with a standalone `Redis` client or a `Cluster`.
 *
 * Every key for a (rule, key) pair shares the hash tag `{rule:key}`, so
 * multi-key scripts are cluster-safe and load spreads evenly across slots.
 * Scripts are registered with `defineCommand`, which uses EVALSHA and falls
 * back to EVAL transparently after a failover or SCRIPT FLUSH.
 */
export class RedisStore implements RateLimitStore {
  private readonly prefix: string;
  private readonly clientClock: (() => number) | undefined;
  private readonly fns: Record<Algorithm, ScriptFn>;

  constructor(
    private readonly client: Redis | Cluster,
    options: RedisStoreOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? 'rl';
    this.clientClock = options.clock === 'client' ? (options.now ?? Date.now) : undefined;

    const fns = {} as Record<Algorithm, ScriptFn>;
    for (const [algorithm, cmd] of Object.entries(COMMANDS) as Array<[Algorithm, (typeof COMMANDS)[Algorithm]]>) {
      if (!(cmd.name in client)) {
        client.defineCommand(cmd.name, { numberOfKeys: cmd.suffixes.length, lua: cmd.lua });
      }
      const fn = (client as unknown as Record<string, ScriptFn>)[cmd.name]!;
      fns[algorithm] = fn.bind(client);
    }
    this.fns = fns;
  }

  /** Redis keys used for a (rule, key) pair. Exposed for operational tooling and tests. */
  keysFor(rule: Rule, key: string): string[] {
    const base = `${this.prefix}:{${rule.name}:${key}}`;
    return COMMANDS[rule.algorithm].suffixes.map((s) => `${base}:${s}`);
  }

  async consume(rule: Rule, key: string, cost: number): Promise<StoreResult> {
    const now = this.clientClock ? this.clientClock() : -1;
    const reply = await this.fns[rule.algorithm](
      ...this.keysFor(rule, key),
      now,
      rule.limit,
      rule.windowMs,
      rule.burst,
      cost,
    );
    return {
      allowed: reply[0] === 1,
      remaining: reply[1],
      retryAfterMs: reply[2],
      resetAfterMs: reply[3],
    };
  }

  async reset(rule: Rule, key: string): Promise<void> {
    // Keys share a hash tag, so a multi-key DEL is valid on Cluster too.
    await this.client.del(...this.keysFor(rule, key));
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // QUIT needs a live connection; during an outage just drop the socket.
      this.client.disconnect();
    }
  }
}
