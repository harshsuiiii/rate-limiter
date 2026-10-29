export class RateLimiterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The caller referenced a rule that is not configured. */
export class UnknownRuleError extends RateLimiterError {
  constructor(readonly rule: string) {
    super(`Unknown rate limit rule "${rule}"`);
  }
}

/** The caller supplied an invalid key or cost. */
export class InvalidRequestError extends RateLimiterError {}

/** A rule definition is invalid. Raised at startup, never on the request path. */
export class InvalidRuleError extends RateLimiterError {}

/** A store call exceeded its deadline. */
export class StoreTimeoutError extends RateLimiterError {
  constructor(readonly timeoutMs: number) {
    super(`Rate limit store did not respond within ${timeoutMs}ms`);
  }
}
