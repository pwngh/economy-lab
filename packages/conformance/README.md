# conformance

Hold a store, cache, rate limiter, dispatcher or processor to its contract.

## Features

- **One suite per port.** Five run functions, each taking a factory for the thing under test.
- **An oracle, not a checklist.** Every suite runs the same workload against your implementation
  and against a fresh in-memory one, then compares the reads.
- **Capabilities are resolved, not trusted.** A capability you declare but do not carry fails the
  suite naming it; one you do not declare registers a skip naming what it needed.
- **A skip says what it wanted.** A run against an unreachable backend reports what it did not
  prove rather than passing quietly.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

Hand a suite a factory. It registers its cases under `node:test` and runs them.

```ts
import { runStoreConformance } from '@pwngh/economy/conformance';

runStoreConformance('my-store', () => openMyStore(), {
  capabilities: { outbox: true, inbox: true, sagas: true },
});
```

### Declaring what you carry

The suite reads your store to decide what it offers, and compares that against what you declared.
A disagreement fails, in both directions, so the declaration is a claim being checked rather than
configuration being obeyed.

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

It is not a test runner and not a benchmark. It registers cases under `node:test` and reports
what your implementation answered, and it says nothing about how fast it answered.

It does not open a database for you. Every suite takes a factory because connecting, migrating
and tearing down are yours.

## Related Packages

- [`@pwngh/economy`](../economy) — the umbrella every door is reached through
- [`@pwngh/economy-postgres`](../postgres) — a ledger store this suite certifies
- [`@pwngh/economy-mysql`](../mysql) — the same, on MySQL or MariaDB

## License

MIT
