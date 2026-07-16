# Changelog

Notable changes to `@pwngh/economy-lab`, newest first. Dates are npm publish dates.

## Unreleased (0.2.0)

### Added

- `read.balance` on a bare sharded platform account sums its shard rows. `shardsOf` and
  `shardRef` are exported from `/store-kit` and the main entry.
- `credits(n)` builds a CREDIT `Amount` from whole credits; fractions are refused with
  `INVALID_AMOUNT`.
- `Transaction` carries the posting's `meta`; `requestPayout` records its saga id there.
  Breaking: custom `Ledger.append` implementations must return it.

### Changed

- Breaking: `RejectionDetail` money fields (`required`, `available`, `minimum`, `requested`,
  `spent`, `limit`) are branded `Amount`s, not decimal strings. Unchanged on the wire.
- Breaking: `spend.recipients` is required and must be non-empty; an empty list is refused
  with `OP.MALFORMED`.
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

## Unreleased (0.1.2)

### Added

- The webhook toolkit is exported from the main entry: `decodeWebhookEvent`,
  `handlePurchaseWebhook`, `toOperation`, and the event types.

### Documentation

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
