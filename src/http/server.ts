import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Registry } from 'prom-client';
import { InvalidRequestError, UnknownRuleError } from '../core/errors.js';
import type { RateLimiter } from '../core/rate-limiter.js';
import type { CheckRequest, Decision } from '../core/types.js';
import { rateLimitHeaders } from './headers.js';

export interface ServerOptions {
  limiter: RateLimiter;
  registry?: Registry;
  /** When set, /v1/* requires `Authorization: Bearer <token>`. */
  apiToken?: string;
  logger?: FastifyServerOptions['logger'];
}

const checkSchema = {
  type: 'object',
  required: ['rule', 'key'],
  additionalProperties: false,
  properties: {
    rule: { type: 'string', minLength: 1, maxLength: 64 },
    key: { type: 'string', minLength: 1, maxLength: 512 },
    cost: { type: 'integer', minimum: 0, maximum: 1_000_000, default: 1 },
  },
} as const;

/**
 * Rate-limit decision service ("limiter as a sidecar/service"):
 *   POST /v1/check         one rule
 *   POST /v1/check/batch   several rules, allowed only if all allow
 *   POST /v1/reset         clear a key (admin)
 *   GET  /v1/rules         configured rules
 *   GET  /healthz /readyz /metrics
 *
 * Checks return 200 with `allowed: false` for denials: a denial is a successful
 * answer, and callers decide how to surface it. RateLimit-* headers are set too.
 */
export function buildServer(options: ServerOptions): FastifyInstance {
  const { limiter, registry } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    // Hot path: per-request access logs at limiter QPS are noise; metrics cover it.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    return503OnClosing: true,
    // Reject unknown fields rather than silently dropping them, so client typos surface.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const expected = options.apiToken ? Buffer.from(`Bearer ${options.apiToken}`) : undefined;
  app.addHook('onRequest', async (req, reply) => {
    if (!expected || !req.url.startsWith('/v1/')) return;
    const given = Buffer.from(req.headers.authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof UnknownRuleError) return reply.code(404).send({ error: error.message });
    if (error instanceof InvalidRequestError) return reply.code(400).send({ error: error.message });
    const { statusCode, validation, message } = error as { statusCode?: number; validation?: unknown; message?: string };
    if (validation || (statusCode && statusCode < 500)) {
      return reply.code(statusCode ?? 400).send({ error: message });
    }
    req.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal Server Error' });
  });

  app.post<{ Body: Required<CheckRequest> }>('/v1/check', { schema: { body: checkSchema } }, async (req, reply) => {
    const { rule, key, cost } = req.body;
    const decision = await limiter.check(rule, key, cost);
    reply.headers(rateLimitHeaders(decision));
    return present(decision);
  });

  app.post<{ Body: { checks: Required<CheckRequest>[] } }>(
    '/v1/check/batch',
    {
      schema: {
        body: {
          type: 'object',
          required: ['checks'],
          additionalProperties: false,
          properties: { checks: { type: 'array', minItems: 1, maxItems: 16, items: checkSchema } },
        },
      },
    },
    async (req, reply) => {
      const result = await limiter.checkMany(req.body.checks);
      reply.headers(rateLimitHeaders(result.binding));
      return { allowed: result.allowed, binding: result.binding.rule, decisions: result.decisions.map(present) };
    },
  );

  app.post<{ Body: { rule: string; key: string } }>(
    '/v1/reset',
    {
      schema: {
        body: {
          type: 'object',
          required: ['rule', 'key'],
          additionalProperties: false,
          properties: { rule: checkSchema.properties.rule, key: checkSchema.properties.key },
        },
      },
    },
    async (req, reply) => {
      await limiter.reset(req.body.rule, req.body.key);
      req.log.info({ rule: req.body.rule }, 'rate limit key reset');
      return reply.code(204).send();
    },
  );

  app.get('/v1/rules', async () => ({
    rules: [...limiter.rules.values()].map(({ name, algorithm, limit, windowMs, burst }) => ({
      name,
      algorithm,
      limit,
      windowMs,
      ...(algorithm === 'token-bucket' ? { burst } : {}),
    })),
  }));

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Ready means the shared store answers. With failMode=local/open the service
  // still works when this fails, so orchestrators should alert on it rather
  // than pull every replica out of rotation at once.
  app.get('/readyz', async (_req, reply) => {
    try {
      await limiter.ping();
      return { status: 'ready', store: 'up', circuit: limiter.circuitState };
    } catch {
      return reply.code(503).send({ status: 'degraded', store: 'down', circuit: limiter.circuitState });
    }
  });

  if (registry) {
    app.get('/metrics', async (_req, reply) => {
      reply.type(registry.contentType);
      return registry.metrics();
    });
  }

  return app;
}

function present(d: Decision) {
  return {
    allowed: d.allowed,
    rule: d.rule,
    limit: d.limit,
    remaining: d.remaining,
    retryAfterMs: d.retryAfterMs,
    resetAfterMs: d.resetAfterMs,
    source: d.source,
  };
}
