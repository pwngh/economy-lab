# Changelog

Notable changes to `@pwngh/economy-lab`, newest first. Dates are npm publish dates.

## Unreleased (0.3.0)

### Added

- `OutboxStore.stats` and `InboxStore.reviveDead` join the store contract, covered by the
  conformance suite; the relay emits `worker.relay.backlog` and `worker.relay.backlog_age_ms`
  from `stats` each run. Breaking: a custom store must implement both to satisfy the interface.
- `Options.correlationId` stamps the submit correlation id onto the outbox envelope
  (`OutboxMessage.correlationId`, a new nullable column for store implementors). Relay failure
  logs carry it; worker-born events carry null.
- `engine.pool.acquire` counts each SQL connection-pool acquisition and `engine.pool.acquire_ms`
  records the wait (both tagged `engine`).
- `DB_POOL_MAX` sizes the SQL connection pool through the composition (`Config.dbPoolMax`);
  unset keeps each driver's default of 10.

### Changed

- `POST /submit` validates every operation field at the decode gate: a missing or wrong-shaped
  field, a malformed `actor`, or a field no variant declares answers `400` `OP.MALFORMED`
  naming the field. Breaking: bodies carrying stray fields were previously accepted and the
  extras ignored.

### Fixed

- `POST /submit` used to refuse `settlePayout` as an unknown kind. The server decodes it like
  every other operation; its optional `providerAmount` rides the wire as a decimal string or
  stays absent.

## 0.2.3 - 2026-07-17

### Added

- `ServerOptions.authenticate` resolves the acting principal for a `/submit` request and stamps
  it as the operation's `actor`. A `null` result answers `401`; a body that carries its own
  `actor` is rejected `400`.
- Request bodies read under a byte ceiling (`ServerOptions.maxBodyBytes`, default 64 KiB,
  answers `413`) and a read deadline (`ServerOptions.readTimeoutMs`, default 10 s, answers
  `408`), on the Fetch handler and the Node bridge alike.
- `ServerOptions.cors` allowlists browser origins with exact matching and preflight handling;
  absent, the server sets no CORS headers.
- A correlation id rides every `/submit` reply: the server derives it (`traceparent` trace
  id, else `x-request-id`, else minted) and echoes it on problem responses and outcomes alike.
- `ServerOptions.rateLimit` admits `/submit` through the new `RateLimiter` port, keyed by the
  authenticated principal or the bridge-stamped client address; a denial answers `429` with
  `retry-after`, and a throwing limiter fails open, counting `economy.ratelimit.degraded`.
  `memoryRateLimiter` counts fixed windows in-process; `redisRateLimiterFrom` shares one
  budget across instances.

## 0.2.2 - 2026-07-17

### Fixed

- Concurrent MySQL submits above the pool limit used to starve the pool permanently: planting a
  transaction's first-use account rows took a second pool connection, so every in-flight
  transaction waited for a connection none could release. A transaction now uses one connection
  for its whole life — first-use rows plant on its own connection (safe at READ COMMITTED, which
  takes no gap lock on a missing key) and roll back with the operation.

## 0.2.1 - 2026-07-16

### Added

- The SQL engines meter their transient-retry pressure through optional `meter`/`logger`
  store options, wired by the composition: `engine.retry` counts each conflict and each
  exhausted budget (tagged `engine`, `outcome`), `engine.retry.recovered` counts commits
  the budget rescued, and an exhausted budget logs `engine.retry.exhausted`.
  `withTransientRetry` takes `{ maxAttempts, observer }` in place of a positional
  `maxAttempts`.
- The payout sweep meters its lifecycle: a `worker.payouts.saga_age_ms` gauge per claimed
  saga (time in the current state) and counters for `dead_lettered`,
  `settlement_unreported`, and `pending_past_timeout`.
- `Worker.pause()` and `resume()` skip the scheduled sweeps while paused; an explicit
  `runOnce` still runs. `paused()` reports the flag.
- The `Scheduler` type is exported from the main entry.

## 0.2.0 - 2026-07-16

### Added

- `read.balance` on a bare sharded platform account sums its shard rows. `shardsOf` and
  `shardRef` are exported from `/store-kit` and the main entry.
- The main entry bundles for the browser without aliases or stubs (esbuild gate in CI).
- `credits(n)` builds a CREDIT `Amount` from whole credits; fractions are refused with
  `INVALID_AMOUNT`.
- `Transaction` carries the posting's `meta`; `requestPayout` records its saga id there.
  Breaking: custom `Ledger.append` implementations must return it.

### Changed

- Breaking: `RejectionDetail` money fields (`required`, `available`, `minimum`, `requested`,
  `spent`, `limit`) are branded `Amount`s, not decimal strings. Unchanged on the wire.
- Breaking: `spend.recipients` is required and must be non-empty; an empty list is refused
  with `OP.MALFORMED`.
- The velocity gate splits into outflow (`spend`, `subscribe`, `requestPayout`) and inflow
  (`topUp`, `grantPromo`) windows per user. Both default to `velocityLimitMinor`;
  `VELOCITY_INFLOW_LIMIT_MINOR` and `VELOCITY_OUTFLOW_LIMIT_MINOR` override.
  `RISK_DENIED.detail.class` names the tripped window; trust-store subjects are now
  `<class>:<userId>`.
- An unknown operation `kind` is refused with a typed `OP.MALFORMED` fault.
- Config overrides merge one level deep into `maturityHorizonMs` and `payoutSla`.
- The config is frozen at construction; change a knob by rebuilding over the same store.
- Maturity horizons default to 0 outside production; production requires
  `MATURITY_HORIZON_CARD_MS`, and other rails default to it.
- `SagaStore.list` breaks `updatedAt` ties by `id` descending on every engine.
- The in-memory store queues overlapping transactions instead of throwing.
- The store server registers a transaction session once the queued body starts.
- Injected-port throws dead-letter as `PROVIDER.FAILURE`, not `STORE.FAILURE`.

### Documentation

- The performance page is re-measured with the queue; the storage page states the one-writer
  contract.
- The disputed-sale runbook: refund the order first, then claw back the wallet.
- Statement paging is range windowing; `Statement.cursor` is reserved.

## 0.1.2 - 2026-07-16

### Added

- The webhook toolkit is exported from the main entry: `decodeWebhookEvent`,
  `handlePurchaseWebhook`, `toOperation`, and the event types.

### Documentation

- The HTTP service page's webhook example uses the exported toolkit.
- `Recipient` documents the share rule: `shareBps` are basis points of the post-fee net,
  summing to 10,000.
- `Transaction.legs` documents the debit-positive sign convention.

## 0.1.1 - 2026-07-16

### Added

- `/store-kit` entry point for custom store authors: the chain, encoding, and ordering
  helpers.
- Submit metrics: operations counted by kind and outcome, and timed.
- The background worker's sweep input accepts an optional reconcile feed.
- The subscription price band is configuration (`SUBSCRIPTION_PRICE_MIN_MINOR`,
  `SUBSCRIPTION_PRICE_MAX_MINOR`).

### Changed

- Rejections carry structured detail: `INSUFFICIENT_FUNDS` reports `required` and
  `available`, `FUNDS_IMMATURE` reports `availableAt`, and `RISK_DENIED` reports `spent`,
  `limit`, `windowMs`, and `retryAfter`.
- Subscription charges run behind the maturity gate: immature funds defer the renewal,
  insufficient funds lapse it.

### Fixed

- Redelivered payout settlements are idempotent: a second `settlePayout` or `reversePayout`
  delivery returns the original outcome.
- Injected services are shape-checked at wiring time; the payout dead-letter log fires after
  commit.

### Documentation

- The handbook covers redelivered settlements and the payout saga's row key.

## 0.1.0 - 2026-07-15

Initial release: one double-entry ledger carrying wallets, payouts, subscriptions, and a
marketplace; in-memory, Postgres, MySQL, and HTTP stores held to one conformance suite; the
HTTP service; the background worker; and the compiled dist build with per-entry-point exports.
