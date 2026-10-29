# Distributed Rate Limiter

A production-grade distributed rate limiter for Node.js, backed by Redis. You can use it two ways:

- **As a service:** a stateless HTTP decision service (`POST /v1/check`). Run N replicas behind a load balancer, call it from any language.
- **As a library:** `RateLimiter` plus Express/Connect middleware, embedded in your Node services and sharing the same Redis.

```
        clients
           │
   ┌───────┴────────┐
   ▼                ▼
┌────────┐      ┌────────┐     stateless replicas: scale horizontally
│ node A │ ...  │ node N │     deny cache · circuit breaker · deadline · fallback
└───┬────┘      └───┬────┘
    │  EVALSHA (atomic Lua, auto-pipelined)
    ▼                ▼
┌─────────────────────────┐
│ Redis / Redis Cluster   │    single source of truth, server clock (TIME)
└─────────────────────────┘
```

## Why it is correct across nodes

- **Atomic:** each check is one Lua script, executed atomically on the Redis primary that owns the key. There are no read-modify-write races, whatever the number of app nodes. In the test suite, 8 independent connections race 600 requests at a limit of 100, and exactly 100 are admitted for every algorithm.
- **No clock skew:** by default scripts read `now` from Redis `TIME`, so drift between app servers cannot change limits.
- **Cluster-safe:** all keys for a `(rule, key)` pair share a hash tag (`rl:{rule:key}:…`), so multi-key scripts stay on one slot. Load still spreads across shards by key.
- **Exact parity:** the Lua scripts and the TypeScript reference implementations use only integer arithmetic (rates are scaled by `windowMs`), so they agree bit for bit. One contract test suite runs against both.

## Algorithms

| Algorithm | Memory per key | Accuracy | Use when |
|---|---|---|---|
| `token-bucket` | O(1) | exact | General API limiting. Smooth refill of `limit` per `window`, with bursts up to `burst`. |
| `sliding-window` | O(1) | ~exact (weighted two-window estimate) | Large quotas (e.g. 5000/h) where you want a rolling window without per-request storage. |
| `sliding-log` | O(limit) | exact | Small, strict limits (login attempts, OTP sends). |
| `fixed-window` | O(1) | allows up to 2× at window edges | Cheap coarse quotas aligned to the clock (daily export cap). |

Every decision returns `remaining`, an exact `retryAfterMs` (the request is denied 1 ms before it and admitted at it, which tests verify for every algorithm) and `resetAfterMs` (time until the quota is fully restored). A request with `cost: 0` checks the current state without consuming anything.

## Failure handling

Redis being slow or down must never take your API down with it.

| Mechanism | Behaviour |
|---|---|
| **Deadline** (`timeoutMs`, default 100 ms) | Every store call is bounded, and a slow Redis counts as a failure. |
| **Circuit breaker** | After `failureThreshold` consecutive failures, calls skip Redis entirely for `cooldownMs`, then a single probe tests recovery. |
| **Fail mode** | `local` (default): per-node in-memory limits, so protection degrades to about `nodes × limit` instead of disappearing. `open`: admit everything. `closed`: reject everything, for limits that guard hard upstream quotas. |
| **Fail-fast client** | No ioredis offline queue, at most 1 retry, capped reconnect backoff. Requests never pile up behind a dead connection. |
| **Deny cache** | Each node remembers a denial until its `retryAfter` and answers repeat offenders without a Redis round-trip. This is safe because a denial stays true until that time. Only requests at least as expensive as the denied one are short-circuited. |

`decision.source` tells you which path answered: `store`, `deny-cache`, `fallback`, `fail-open` or `fail-closed`.

## Quick start

```bash
npm install
npm run redis:up          # Redis 7 in Docker on :6379
npm test                  # 107 tests; Redis integration tests run when Redis is reachable
npm run dev               # service on :8080 using config/rate-limiter.yaml
```

Two replicas sharing one Redis:

```bash
docker compose up --build   # limiter-a on :8081, limiter-b on :8082
```

## HTTP API

```http
POST /v1/check
{"rule": "api-per-ip", "key": "203.0.113.7", "cost": 1}

200 OK
RateLimit-Limit: 100
RateLimit-Remaining: 119
RateLimit-Reset: 1
RateLimit-Policy: 100;w=60
{"allowed":true,"rule":"api-per-ip","limit":100,"remaining":119,"retryAfterMs":0,"resetAfterMs":600,"source":"store"}
```

A denial is still `200` with `"allowed": false` and a `Retry-After` header. The caller chooses how to surface it.

| Endpoint | Purpose |
|---|---|
| `POST /v1/check` | Check one rule. `cost` defaults to 1; `0` only inspects. |
| `POST /v1/check/batch` | `{"checks":[...]}` (up to 16 checks). Allowed only if every rule allows. `binding` names the rule to report. |
| `POST /v1/reset` | `{"rule","key"}` clears a key (operator unblock). |
| `GET /v1/rules` | Lists the configured rules. |
| `GET /healthz` | Liveness. |
| `GET /readyz` | `503` when Redis is unreachable. In `local`/`open` mode the service still answers, so alert on this rather than removing every replica at once. |
| `GET /metrics` | Prometheus. |

Errors: `400` for invalid input (including unknown fields and a cost above the rule's capacity), `401` for a bad token, `404` for an unknown rule. When `API_TOKEN` is set, `/v1/*` requires `Authorization: Bearer <token>`. The token is compared in constant time.

## Library usage

```ts
import { Redis } from 'ioredis';
import express from 'express';
import { RateLimiter, RedisStore, rateLimit } from 'distributed-rate-limiter';

const limiter = new RateLimiter({
  store: new RedisStore(new Redis(process.env.REDIS_URL!, { enableAutoPipelining: true, enableOfflineQueue: false })),
  rules: [
    { name: 'api', algorithm: 'token-bucket', limit: 100, windowMs: 60_000, burst: 120 },
    { name: 'login', algorithm: 'sliding-log', limit: 5, windowMs: 15 * 60_000 },
  ],
  failMode: 'local',
});

const app = express();
app.set('trust proxy', 1); // so req.ip is the client, not the load balancer
app.use(rateLimit(limiter, { rule: 'api' }));
app.post('/login', rateLimit(limiter, { rule: 'login', key: (req) => req.body?.username }), handler);

// Or call it directly; multiple rules at once:
const { allowed, binding } = await limiter.checkMany([
  { rule: 'api', key: ip },
  { rule: 'login', key: username },
]);
```

`check()` throws only for caller mistakes (`UnknownRuleError`, `InvalidRequestError`). It never throws because of store failures; the fail mode handles those.

## Configuration

`config/rate-limiter.yaml` (path from `CONFIG_FILE`), validated at startup with errors that name the field. Unknown keys are rejected. Environment variables override the file:

| Variable | Overrides |
|---|---|
| `PORT`, `HOST`, `LOG_LEVEL` | `server.*` |
| `API_TOKEN` | `server.apiToken` (at least 16 characters) |
| `REDIS_URL` | `redis.url` |
| `REDIS_CLUSTER_NODES` | `redis.clusterNodes`; comma-separated `host:port` seeds, enables Cluster mode |
| `REDIS_KEY_PREFIX` | `redis.keyPrefix` |
| `FAIL_MODE` | `limiter.failMode` (`local` \| `open` \| `closed`) |
| `STORE_TIMEOUT_MS` | `limiter.timeoutMs` |

Rules take durations like `500ms`, `30s`, `15m`, `1h` or `1d`.

## Operations

**Metrics**
- `ratelimit_decisions_total{rule,outcome,source}`: alert when `source=~"fallback|fail-.*"` is non-zero.
- `ratelimit_decision_duration_seconds{source}`
- `ratelimit_store_errors_total{rule,error}`
- `ratelimit_circuit_state` (0 closed, 1 half-open, 2 open)

Plus Node.js process metrics. The limited key is never used as a label, so cardinality stays bounded.

**Redis**
- Every key has a TTL equal to how long its state matters, so idle keys clean themselves up.
- Use `maxmemory-policy volatile-ttl` (or `volatile-lru`), and never `noeviction`. Under memory pressure, forgetting a limit is better than failing writes.
- Persistence is optional: losing limiter state on restart only resets counters.
- Approximate footprint: about 100 bytes per active key for the O(1) algorithms. `sliding-log` needs about 60 bytes per admitted unit inside the window.

**Graceful shutdown:** on SIGTERM the server stops accepting connections, drains in-flight requests (up to `shutdownTimeoutMs`), and closes Redis. The container runs `node` directly so it receives the signal.

## Design trade-offs

- **`checkMany` is not transactional.** Rules may live on different cluster shards. If rule A admits and rule B denies, A's unit is still consumed. This errs toward protection and matches common practice. Checks run in parallel, so a batch costs one round-trip of latency rather than one per rule.
- **Timeouts are not cancellations.** A check that times out may still be applied by Redis afterwards, so the client may be charged for a request that fell back. This is negligible in practice.
- **Deny cache is per node.** After `POST /v1/reset`, other nodes may keep rejecting that key until its cached retry time (bounded by the window). Disable it with `denyCache: false` if instant unblocks matter more than shedding abusive load.
- **`local` fail mode is approximate.** Each node enforces the full limit, so the cluster-wide ceiling during an outage is `nodes × limit`. Supply a custom `fallbackStore` if you need tighter bounds.

## Project layout

```
src/
  core/          algorithms (TS reference), rules, limiter, circuit breaker, errors, types
  stores/        RedisStore + Lua scripts, MemoryStore
  http/          Fastify service, Express/Connect middleware, RateLimit headers
  observability/ Prometheus metrics
  config.ts      YAML + env config with zod validation
  main.ts        service entrypoint (graceful shutdown)
test/            store contract (memory + live Redis), limiter, server, middleware, config
```
