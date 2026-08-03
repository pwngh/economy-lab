# conformance

The port test suites for [`@pwngh/economy`](../economy). `conformance` runs your own store, cache,
limiter, dispatcher or processor through the cases the built-in ones pass.

## Features

- **Five suites, one per port:** store, cache, rate limiter, dispatcher, processor.
- **The store suite runs against an oracle:** the same workload on your store and on the in-memory
  one, reads compared.
- **The store suite checks what you declare:** a capability your store does not have fails the
  suite; [one you leave out](#declaring-what-you-carry) skips its cases.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

Give a suite a factory. It adds its cases to `node:test` and runs them.

```ts
import { runStoreConformance } from '@pwngh/economy/conformance';

runStoreConformance('my-store', () => openMyStore(), {
  capabilities: { outbox: true, inbox: true, sagas: true },
});
```

### Declaring what you carry

Store suite only. It looks at your store to see what it actually offers, then checks that against
what you declared. Either kind of mismatch fails. What you declare is a claim the suite checks,
not a switch it obeys.

```ts
runStoreConformance('my-store', () => openMyStore(), {
  capabilities: { outbox: true, appendAll: false },
});
```

### The other four ports

```ts
import {
  runCacheConformance,
  runDispatcherConformance,
  runProcessorConformance,
  runRateLimiterConformance,
} from '@pwngh/economy/conformance';

runCacheConformance('my-cache', () => openMyCache());
runRateLimiterConformance('my-limiter', () => openMyLimiter());
runDispatcherConformance('my-dispatcher', () => openMyDispatcher());
runProcessorConformance('my-processor', () => openMyProcessor());
```

### What this package is not

It is not a test runner and not a benchmark. It adds cases to `node:test` and tells you whether
your code gave the right answers. It says nothing about how fast.

It will not open a database for you. Every suite takes a factory, so connecting, migrating and
cleaning up stay yours.

## Related Packages

- [`@pwngh/economy`](../economy) — the umbrella every door is reached through
- [`@pwngh/economy-postgres`](../postgres) — a ledger store that passes these suites
- [`@pwngh/economy-mysql`](../mysql) — the same, on MySQL or MariaDB

## License

MIT
