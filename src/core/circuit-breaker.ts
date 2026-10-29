export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. Default 5. */
  failureThreshold?: number;
  /** How long to stay open before letting a probe through. Default 5000ms. */
  cooldownMs?: number;
  now?: () => number;
  onStateChange?: (state: CircuitState) => void;
}

/**
 * Classic three-state breaker. While open, callers skip the store entirely,
 * which bounds the latency a dead Redis adds to every request to ~0 and gives
 * it room to recover. After the cooldown, exactly one probe is let through.
 */
export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange: ((state: CircuitState) => void) | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  get state(): CircuitState {
    return this.current;
  }

  /** ms until the next probe is allowed; 0 unless open. */
  get remainingCooldownMs(): number {
    return this.current === 'open' ? Math.max(0, this.openedAt + this.cooldownMs - this.now()) : 0;
  }

  /** Whether a call should be attempted. Must be followed by `success()` or `failure()` when true. */
  allowRequest(): boolean {
    if (this.current === 'closed') return true;
    if (this.current === 'open') {
      if (this.now() < this.openedAt + this.cooldownMs) return false;
      this.transition('half-open');
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.probeInFlight = false;
    if (this.current !== 'closed') this.transition('closed');
  }

  failure(): void {
    this.probeInFlight = false;
    this.failures++;
    if (this.current === 'half-open' || (this.current === 'closed' && this.failures >= this.threshold)) {
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  private transition(state: CircuitState): void {
    this.current = state;
    this.onStateChange?.(state);
  }
}
