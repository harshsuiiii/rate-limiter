/*
 * Redis Lua scripts. Each is the twin of the function of the same name in
 * `core/algorithms.ts`; keep them in sync (the shared contract tests enforce it).
 *
 * Scripts run atomically on the Redis primary that owns the key, which is what
 * makes the limiter correct across any number of application nodes.
 *
 * ARGV layout (all scripts): [now, limit, windowMs, burst, cost]
 *   now < 0  => use the Redis server clock (TIME), so app-node clock skew is irrelevant.
 *   now >= 0 => trust the caller's clock (used by tests and `clock: 'client'`).
 *
 * Returns: { allowed (0|1), remaining, retryAfterMs, resetAfterMs } as integers.
 */

const PRELUDE = `
local now = tonumber(ARGV[1])
if now < 0 then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local limit = tonumber(ARGV[2])
local W = tonumber(ARGV[3])
local burst = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
`;

export const TOKEN_BUCKET = `${PRELUDE}
local key = KEYS[1]
local cap = burst * W
local need = cost * W
local units = cap
local data = redis.call('HMGET', key, 'u', 'ts')
local su = tonumber(data[1])
local ts = tonumber(data[2])
if su ~= nil and ts ~= nil then
  if now < ts then now = ts end
  units = math.min(cap, su + (now - ts) * limit)
end
local allowed = 0
local retry = 0
if units >= need then
  allowed = 1
  if cost > 0 then
    units = units - need
    redis.call('HSET', key, 'u', string.format('%.17g', units), 'ts', string.format('%.17g', now))
    redis.call('PEXPIRE', key, math.max(math.ceil((cap - units) / limit), 1))
  end
else
  retry = math.ceil((need - units) / limit)
end
local reset = math.ceil((cap - units) / limit)
return { allowed, math.floor(units / W), retry, reset }
`;

export const SLIDING_WINDOW = `${PRELUDE}
local key = KEYS[1]
local start = now - (now % W)
local ws = start
local c = 0
local p = 0
local data = redis.call('HMGET', key, 'ws', 'c', 'p')
if data[1] then
  ws = tonumber(data[1])
  c = tonumber(data[2])
  p = tonumber(data[3])
  if start > ws then
    if start - ws == W then p = c else p = 0 end
    c = 0
    ws = start
  end
end
local elapsed = now - ws
local est = p * (W - elapsed) + c * W
local allowed = 0
local retry = 0
local remaining
if est + cost * W <= limit * W then
  allowed = 1
  remaining = math.floor((limit * W - est - cost * W) / W)
  if cost > 0 then
    c = c + cost
    redis.call('HSET', key, 'ws', string.format('%.17g', ws), 'c', c, 'p', p)
    redis.call('PEXPIRE', key, ws + 2 * W - now)
  end
else
  remaining = math.max(0, math.floor((limit * W - est) / W))
  if c + cost <= limit then
    local x = W - math.floor(((limit - c - cost) * W) / p)
    retry = math.max(1, x - elapsed)
  else
    local y = W - math.floor(((limit - cost) * W) / c)
    retry = W - elapsed + y
  end
end
local reset = 0
if c > 0 then reset = ws + 2 * W - now elseif p > 0 then reset = ws + W - now end
return { allowed, remaining, retry, reset }
`;

export const FIXED_WINDOW = `${PRELUDE}
local key = KEYS[1]
local start = now - (now % W)
local ws = start
local c = 0
local data = redis.call('HMGET', key, 'ws', 'c')
local sws = tonumber(data[1])
if sws ~= nil and sws >= start then
  ws = sws
  c = tonumber(data[2])
end
local allowed = 0
local retry = 0
if c + cost <= limit then
  allowed = 1
  if cost > 0 then
    c = c + cost
    redis.call('HSET', key, 'ws', string.format('%.17g', ws), 'c', c)
    redis.call('PEXPIRE', key, ws + W - now)
  end
else
  retry = ws + W - now
end
local reset = 0
if c > 0 then reset = ws + W - now end
return { allowed, math.max(0, limit - c), retry, reset }
`;

// KEYS[1] = ZSET of admitted units (score = timestamp), KEYS[2] = member sequence counter.
// Both keys share a hash tag, so this is safe on Redis Cluster.
export const SLIDING_LOG = `${PRELUDE}
local key = KEYS[1]
local seqKey = KEYS[2]
local expired = redis.call('ZREMRANGEBYSCORE', key, '-inf', now - W)
local count = redis.call('ZCARD', key)
local allowed = 0
local retry = 0
local remaining
if count + cost <= limit then
  allowed = 1
  remaining = limit - count - cost
  if cost > 0 then
    local seq = redis.call('INCRBY', seqKey, cost)
    for i = 1, cost do
      redis.call('ZADD', key, now, seq - cost + i)
    end
    redis.call('PEXPIRE', key, W)
    redis.call('PEXPIRE', seqKey, W)
  end
else
  local e = redis.call('ZRANGE', key, count + cost - limit - 1, count + cost - limit - 1, 'WITHSCORES')
  retry = tonumber(e[2]) + W - now
  remaining = math.max(0, limit - count)
end
local reset = 0
local newest = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
if newest[2] then reset = tonumber(newest[2]) + W - now end
return { allowed, remaining, retry, reset }
`;
