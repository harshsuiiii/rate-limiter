import type { Decision } from '../core/types.js';

/**
 * Response headers per the IETF RateLimit header fields draft, plus the
 * widely supported `Retry-After` (RFC 9110) on denials. Values are seconds.
 */
export function rateLimitHeaders(decision: Decision): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(Math.ceil(decision.resetAfterMs / 1000)),
    'RateLimit-Policy': `${decision.limit};w=${Math.ceil(decision.windowMs / 1000)}`,
  };
  if (!decision.allowed) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
  }
  return headers;
}
