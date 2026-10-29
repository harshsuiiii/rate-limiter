import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { RateLimiterHooks } from '../core/rate-limiter.js';

const CIRCUIT_STATE_VALUE = { closed: 0, 'half-open': 1, open: 2 } as const;

export interface Metrics {
  registry: Registry;
  hooks: RateLimiterHooks;
}

/**
 * Prometheus instrumentation. Labels are bounded (rule, outcome, source) —
 * never the limited key, which would explode cardinality.
 */
export function createMetrics(options: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });

  const decisions = new Counter({
    name: 'ratelimit_decisions_total',
    help: 'Rate limit decisions by rule, outcome and the component that produced them.',
    labelNames: ['rule', 'outcome', 'source'] as const,
    registers: [registry],
  });
  const latency = new Histogram({
    name: 'ratelimit_decision_duration_seconds',
    help: 'Time to produce a decision, including store round-trip.',
    labelNames: ['source'] as const,
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
    registers: [registry],
  });
  const storeErrors = new Counter({
    name: 'ratelimit_store_errors_total',
    help: 'Primary store failures (errors and timeouts).',
    labelNames: ['rule', 'error'] as const,
    registers: [registry],
  });
  const circuit = new Gauge({
    name: 'ratelimit_circuit_state',
    help: 'Primary store circuit breaker: 0=closed, 1=half-open, 2=open.',
    registers: [registry],
  });
  circuit.set(0);

  return {
    registry,
    hooks: {
      onDecision(decision, latencyMs) {
        decisions.inc({ rule: decision.rule, outcome: decision.allowed ? 'allowed' : 'denied', source: decision.source });
        latency.observe({ source: decision.source }, latencyMs / 1000);
      },
      onStoreError(error, rule) {
        storeErrors.inc({ rule, error: error instanceof Error ? error.name : 'unknown' });
      },
      onCircuitStateChange(state) {
        circuit.set(CIRCUIT_STATE_VALUE[state]);
      },
    },
  };
}
