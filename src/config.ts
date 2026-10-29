import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ALGORITHMS } from './core/types.js';

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses `250ms`, `30s`, `1m`, `1h`, `1d`, or a bare number of milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/.exec(value);
  if (!match) throw new Error(`Invalid duration "${value}" (expected e.g. 500ms, 30s, 1m, 1h, 1d)`);
  return Number(match[1]) * UNITS[match[2] ?? 'ms']!;
}

const duration = z.union([z.number(), z.string()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
    return z.NEVER;
  }
}).pipe(z.number().int().positive());

const ruleSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'letters, digits, and _ . : - only (max 64)'),
    algorithm: z.enum(ALGORITHMS),
    limit: z.number().int().positive(),
    window: duration,
    burst: z.number().int().positive().optional(),
  })
  .strict()
  .transform(({ window, ...rest }) => ({ ...rest, windowMs: window }));

const configSchema = z
  .object({
    server: z
      .object({
        host: z.string().default('0.0.0.0'),
        port: z.coerce.number().int().min(0).max(65_535).default(8080),
        /** Bearer token required on /v1/* when set. */
        apiToken: z.string().min(16).optional(),
        logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
        /** Drain window for in-flight requests on SIGTERM. */
        shutdownTimeoutMs: z.coerce.number().int().positive().default(10_000),
      })
      .strict()
      .default({}),
    redis: z
      .object({
        url: z.string().default('redis://localhost:6379'),
        /** host:port seeds. When set, connects in Cluster mode and `url` is ignored. */
        clusterNodes: z.array(z.string()).optional(),
        keyPrefix: z.string().min(1).default('rl'),
        connectTimeoutMs: z.coerce.number().int().positive().default(2_000),
        clock: z.enum(['server', 'client']).default('server'),
      })
      .strict()
      .default({}),
    limiter: z
      .object({
        failMode: z.enum(['local', 'open', 'closed']).default('local'),
        timeoutMs: z.coerce.number().int().positive().default(100),
        denyCache: z.boolean().default(true),
        circuitBreaker: z
          .object({
            failureThreshold: z.number().int().positive().default(5),
            cooldownMs: duration.default(5_000),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    rules: z.array(ruleSchema).min(1, 'at least one rule is required'),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.rules.forEach((rule, i) => {
      if (seen.has(rule.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', i, 'name'], message: `duplicate rule "${rule.name}"` });
      }
      seen.add(rule.name);
      if (rule.burst !== undefined && rule.algorithm !== 'token-bucket') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', i, 'burst'], message: 'burst requires token-bucket' });
      }
    });
  });

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

/**
 * Loads config from the YAML/JSON file at `CONFIG_FILE` (default
 * `config/rate-limiter.yaml`), then applies environment overrides, which win.
 * Secrets (API token, Redis URL with password) should come from the environment.
 */
export function loadConfig(env: Env = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): Config {
  const path = env.CONFIG_FILE ?? 'config/rate-limiter.yaml';
  let raw: unknown;
  try {
    raw = parseYaml(read(path)) ?? {};
  } catch (error) {
    throw new ConfigError(`Cannot read config file "${path}": ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`Config file "${path}" must contain a mapping`);
  }
  return parseConfig(applyEnv(raw as Record<string, any>, env));
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  return result.data;
}

function applyEnv(raw: Record<string, any>, env: Env): Record<string, any> {
  const config = structuredClone(raw);
  const section = (name: string): Record<string, any> => (config[name] ??= {});
  const set = (name: string, key: string, value: unknown) => {
    if (value !== undefined && value !== '') section(name)[key] = value;
  };

  set('server', 'host', env.HOST);
  set('server', 'port', env.PORT);
  set('server', 'apiToken', env.API_TOKEN);
  set('server', 'logLevel', env.LOG_LEVEL);
  set('redis', 'url', env.REDIS_URL);
  set('redis', 'clusterNodes', env.REDIS_CLUSTER_NODES?.split(',').map((s) => s.trim()).filter(Boolean));
  set('redis', 'keyPrefix', env.REDIS_KEY_PREFIX);
  set('limiter', 'failMode', env.FAIL_MODE);
  set('limiter', 'timeoutMs', env.STORE_TIMEOUT_MS);
  return config;
}
