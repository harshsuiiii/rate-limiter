import { algorithms } from '../core/algorithms.js';
import type { RateLimitStore, Rule, StoreResult } from '../core/types.js';

interface Entry {
  state: unknown;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  /** Upper bound on tracked keys; least-recently-used keys are evicted beyond it. Default 100k. */
  maxKeys?: number;
  /** Interval for sweeping expired entries. 0 disables the timer. Default 30s. */
  sweepIntervalMs?: number;
  now?: () => number;
}

/**
 * In-process store. Limits are per process, not global, so use it for tests,
 * single-instance deployments, or as the degraded-mode fallback when Redis is
 * unavailable. Operations are synchronous, hence trivially atomic.
 */
export class MemoryStore implements RateLimitStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxKeys = options.maxKeys ?? 100_000;
    this.now = options.now ?? Date.now;
    const interval = options.sweepIntervalMs ?? 30_000;
    if (interval > 0) {
      this.timer = setInterval(() => this.sweep(), interval);
      this.timer.unref();
    }
  }

  get size(): number {
    return this.entries.size;
  }

  async consume(rule: Rule, key: string, cost: number): Promise<StoreResult> {
    const now = this.now();
    const id = this.id(rule, key);
    const entry = this.entries.get(id);
    const state = entry && entry.expiresAt > now ? entry.state : undefined;

    const outcome = algorithms[rule.algorithm](state, rule, cost, now);
    if (outcome.next !== undefined) {
      // Delete-then-set moves the key to the end of the Map's insertion order (LRU).
      this.entries.delete(id);
      this.entries.set(id, { state: outcome.next, expiresAt: now + outcome.ttlMs });
      this.evictOverflow();
    } else if (entry && state === undefined) {
      this.entries.delete(id);
    }
    return outcome.result;
  }

  async reset(rule: Rule, key: string): Promise<void> {
    this.entries.delete(this.id(rule, key));
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.entries.clear();
  }

  sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }

  private id(rule: Rule, key: string): string {
    return `${rule.name}:${rule.algorithm}\u0000${key}`;
  }
}
