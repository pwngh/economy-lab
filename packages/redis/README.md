# redis

The Redis ports for [`@pwngh/economy`](../economy). Two products in one package, because Redis
fills two of the economy's ports: the read-through `Cache` in front of the store, and the
fixed-window `RateLimiter` at the HTTP edge. It is not a queue, and never has been.

## Features

- **Two factories, one connection each:** `redisCache(url)` and `redisRateLimiter(url, options)`.
  Each opens its own client and each `close()` releases it.
- **The cache is best-effort by contract:** a failed read or write throws a retryable
  `STORE.FAILURE`, which the economy logs as `economy.cache.degraded` before reading the store
  instead. A Redis outage costs latency, never correctness.
- **Redis enforces expiry, not the process:** `ttlMs` maps to `PX`, so a restarted service does
  not resurrect stale balances.
- **The limit holds across processes:** the counter lives in Redis, so ten app instances share
  one budget instead of ten.
- **A window is counted and armed together:** one `EVAL` per call does the increment and the
  expiry, so nothing that can happen between two round trips leaves a key counting with no way
  to expire.
- **Namespaced keys:** `economy:cache:` and `economy:ratelimit:`, so an operator can find or drop
  them as a set and nothing collides with the rest of the instance.

## Installation

```sh
npm i @pwngh/economy
```

`ioredis` comes with it.

## Usage

```ts
import { redisCache } from '@pwngh/economy/redis';

export let ports = {
  cache: await redisCache(process.env.REDIS_URL!),
};
```

The economy reads balances through it and invalidates on every posting that moves one. Nothing
else to wire.

### Rate limiting the HTTP edge

```ts
import { redisRateLimiter } from '@pwngh/economy/redis';

let limiter = await redisRateLimiter(process.env.REDIS_URL!, {
  limit: 100,
  windowMs: 60_000,
});

await limiter.allow('usr_ada'); // { allowed: true }
await limiter.allow('usr_ada'); // { allowed: false, retryAfterMs: 59_912 } past the limit
```

The limiter is not a `Ports` slot. It goes to `createServer`, which answers a denial with the
`retryAfterMs` it reports.

### Bringing your own client

```ts
import Redis from 'ioredis';
import { redisCache } from '@pwngh/economy/redis';

let cache = redisCache(new Redis({ sentinels, name: 'economy' })); // no await: it is already open
```

Sentinel, cluster, and TLS all live here rather than in an options bag this package would have to
mirror. Given a client, both factories return directly instead of a promise.

Ownership follows creation, and the types carry it. A cache or limiter built over your client has
no `close`, so nothing here can end a connection you opened — not this package, and not the
economy closing around it. Quit it yourself when you are done. The URL forms are the other way
round: they opened the connection, so they hand back a `close()` and the economy calls it.

### What this package does not do

- **It is not a dispatcher.** Redis fills `Cache` and `RateLimiter`. Events go out through
  [`@pwngh/economy-sqs`](../sqs) or an HTTP dispatcher.
- **It is not a store.** Nothing here is durable, and no money is ever read from it without the
  store behind it.
- **The limiter is a fixed window, not a sliding one.** Two full bursts can land either side of a
  boundary. That is the trade for one round trip per call.
- **It does not decide what an outage costs.** A limiter that cannot reach Redis throws a
  retryable `STORE.FAILURE`. The lab's edge fails open on that throw — the call is admitted and
  `economy.ratelimit.degraded` counts it — so an unreachable Redis costs protection rather than
  availability. A host calling `allow()` directly gets the throw and makes that call itself.

## Related Packages

- [`@pwngh/economy`](../economy) — the economy these ports serve
- [`@pwngh/economy-postgres`](../postgres) — the store this cache sits in front of
- [`@pwngh/economy-sqs`](../sqs) — the outbound events, which are a different port

## License

[MIT](../../LICENSE.md)
