import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RateLimiter } from '../core/rate-limiter.js';
import type { Decision } from '../core/types.js';
import { rateLimitHeaders } from './headers.js';

type Req = IncomingMessage & { ip?: string };
type Next = (error?: unknown) => void;

export interface MiddlewareOptions<R extends Req = Req> {
  /** Rule to enforce. */
  rule: string;
  /**
   * Identity to limit by. Defaults to `req.ip` (Express sets this, honouring
   * `trust proxy`) or the socket address. Return `undefined` to skip limiting.
   */
  key?: (req: R) => string | undefined;
  /** Units this request costs. Default 1. */
  cost?: (req: R) => number;
  /** Emit RateLimit-* headers on every response. Default true. */
  headers?: boolean;
  /** Custom response for denied requests. Default: 429 JSON. */
  onLimited?: (req: R, res: ServerResponse, decision: Decision) => void;
}

/**
 * Express / Connect compatible middleware (also usable with a bare `node:http`
 * handler). Store outages never surface as errors here: the limiter's fail
 * mode decides the outcome.
 */
export function rateLimit<R extends Req = Req>(limiter: RateLimiter, options: MiddlewareOptions<R>) {
  // Fail fast at wiring time rather than on the first request.
  limiter.getRule(options.rule);
  const keyOf = options.key ?? ((req: R) => req.ip ?? req.socket.remoteAddress);
  const emitHeaders = options.headers ?? true;

  return function rateLimitMiddleware(req: R, res: ServerResponse, next: Next): void {
    let key: string | undefined;
    let cost: number;
    try {
      key = keyOf(req);
      cost = options.cost ? options.cost(req) : 1;
    } catch (error) {
      next(error);
      return;
    }
    if (key === undefined || key === '') {
      next();
      return;
    }

    limiter.check(options.rule, key, cost).then(
      (decision) => {
        if (emitHeaders) {
          for (const [name, value] of Object.entries(rateLimitHeaders(decision))) res.setHeader(name, value);
        }
        if (decision.allowed) {
          next();
        } else if (options.onLimited) {
          options.onLimited(req, res, decision);
        } else {
          const retry = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
          if (!emitHeaders) res.setHeader('Retry-After', String(retry));
          res.statusCode = 429;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Too Many Requests', retryAfterSeconds: retry }));
        }
      },
      (error: unknown) => next(error),
    );
  };
}
