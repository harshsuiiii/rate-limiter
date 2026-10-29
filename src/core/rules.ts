import { InvalidRuleError } from './errors.js';
import { ALGORITHMS, type Rule, type RuleConfig } from './types.js';

const RULE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

function assertPositiveInt(value: unknown, field: string, rule: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidRuleError(`Rule "${rule}": ${field} must be a positive integer, got ${String(value)}`);
  }
}

/**
 * Validates a rule and applies defaults.
 *
 * All algorithms use integer arithmetic scaled by `windowMs` so that the Lua
 * (Redis) and TypeScript (memory) implementations agree exactly. That requires
 * `capacity * windowMs` to stay within the 2^53 range doubles represent exactly.
 */
export function normalizeRule(config: RuleConfig): Rule {
  const name = config.name;
  if (typeof name !== 'string' || !RULE_NAME.test(name)) {
    throw new InvalidRuleError(`Rule name must match ${RULE_NAME}, got "${String(name)}"`);
  }
  if (!ALGORITHMS.includes(config.algorithm)) {
    throw new InvalidRuleError(
      `Rule "${name}": algorithm must be one of ${ALGORITHMS.join(', ')}, got "${String(config.algorithm)}"`,
    );
  }
  assertPositiveInt(config.limit, 'limit', name);
  assertPositiveInt(config.windowMs, 'windowMs', name);

  let burst = config.limit;
  if (config.burst !== undefined) {
    if (config.algorithm !== 'token-bucket') {
      throw new InvalidRuleError(`Rule "${name}": burst is only supported by the token-bucket algorithm`);
    }
    assertPositiveInt(config.burst, 'burst', name);
    burst = config.burst;
  }

  const capacity = config.algorithm === 'token-bucket' ? burst : config.limit;
  if (capacity * config.windowMs > Number.MAX_SAFE_INTEGER || config.limit * config.windowMs > Number.MAX_SAFE_INTEGER) {
    throw new InvalidRuleError(`Rule "${name}": limit/burst * windowMs exceeds 2^53; use a coarser window`);
  }

  return Object.freeze({
    name,
    algorithm: config.algorithm,
    limit: config.limit,
    windowMs: config.windowMs,
    burst,
    capacity,
  });
}
