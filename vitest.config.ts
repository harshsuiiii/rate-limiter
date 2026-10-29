import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Redis-backed suites share one server; keep files sequential so FLUSH-style
    // cleanup in one file can't interfere with another.
    fileParallelism: false,
  },
});
