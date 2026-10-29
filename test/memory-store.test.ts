import { describe, expect, it } from 'vitest';
import { normalizeRule } from '../src/core/rules.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { T0, storeContract } from './store-contract.js';

storeContract('MemoryStore', (now) => new MemoryStore({ now, sweepIntervalMs: 0 }));

describe('MemoryStore bounds', () => {
  const rule = normalizeRule({ name: 'r', algorithm: 'fixed-window', limit: 10, windowMs: 1_000 });

  it('evicts least-recently-used keys beyond maxKeys', async () => {
    const store = new MemoryStore({ maxKeys: 2, sweepIntervalMs: 0, now: () => T0 });
    await store.consume(rule, 'a', 1);
    await store.consume(rule, 'b', 1);
    await store.consume(rule, 'a', 1); // touch a
    await store.consume(rule, 'c', 1); // evicts b
    expect(store.size).toBe(2);
    expect((await store.consume(rule, 'a', 0)).remaining).toBe(8);
    expect((await store.consume(rule, 'b', 0)).remaining).toBe(10);
  });

  it('sweeps expired entries', async () => {
    let now = T0;
    const store = new MemoryStore({ sweepIntervalMs: 0, now: () => now });
    await store.consume(rule, 'a', 1);
    now += 1_000;
    store.sweep();
    expect(store.size).toBe(0);
  });
});
