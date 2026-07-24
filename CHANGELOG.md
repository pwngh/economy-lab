# Changelog

Notable changes to `@pwngh/economy-lab`, newest first. Dates are npm publish dates.

## Unreleased (0.6.0)

### Added

- The accrual split parks seller shares on the `platform:settlement_accrual` shard at `spend`
  and `subscribe` (`ACCRUAL_DRAIN=1`, `Config.accrualDrain`), and rows land in `accrual_rows`
  until drained. Breaking: `Store.accruals` is required of custom stores.
- The worker's accrual drain sweep moves parked shares to sellers' earned wallets in batches.
- `post_entries` fuses each posting's writes into one stored-procedure call on both SQL
  engines, and the engines answer account existence from a cache whose entries are added only
  at commit.

## 0.5.0 - 2026-07-23

### Added

- `Ledger.links` and `Ledger.linksPage` read an account's chain links in lineage order
  (`StoredLink` rows). Breaking: custom ledger implementations must provide both.
- Breaking: `PayoutSagaRow.txnId` is required. Every saga names the reserve posting it opened
  with, and submit, settle, and reverse re-prove the saga against that posting's sealed
  metadata before acting.
- Subscription, promo, and instance-movement rows carry `txnId` naming their creating posting;
  renewals and sweeps re-prove it before charging or granting.
- The checkpoint seal re-proves only chains whose heads moved since the prior seal
  (`seal_heads`).
- `reproveStoredChains` re-verifies sealed history in rolling pages and advances a
  verified-through watermark; key rotation stamps `rotatedAt`, and the sweep re-proves
  everything sealed before it.
- The stamped SQL schema version is 15: `payout_sagas.txn_id`, `seal_heads`, and
  `chain_reproof`.

### Changed

- Money-deriving reads re-prove the stored posting's chain link before acting: saga settle and
  reverse, subscription renewal, the promo sweep, refund, and reversal.

## 0.4.4 - 2026-07-23

### Added

- The docs site serves the generated TypeDoc API reference at `/api`, one page per exported
  symbol across every package entry point. `npm run docs:api` builds it; the site build and
  deploy fold it in.

### Documentation

- TSDoc across the public surface feeds the `/api` reference; `@see` lines pair each symbol
  with its handbook page.
- Handbook pages cite the reference with `ApiLink` chips and `apiRefs` frontmatter; a docs test
  proves every link resolves into the generated output. The api reference page points at `/api`
  instead of keeping a hand-written symbol table.

## 0.4.3 - 2026-07-23

### Added

- `TOP_UP_BUNDLES_MINOR` lists the purchasable top-up amounts as CREDIT minor units
  (`Config.topUpBundlesMinor`); a `topUp` for an amount off the list is refused with
  `OP.MALFORMED`. Unset accepts any positive amount.

## 0.4.2 - 2026-07-23

### Fixed

- The SQL engines write `payout_usd` on the payout saga row at request time; it used to land
  only at settle, so an in-flight saga row carried no quote.

## 0.4.1 - 2026-07-19

### Added

- `verifyExport` and `parseExport` move offline ledger verification onto the main entry: an
  auditor holding a `read.export` file and the published public key verifies it from the
  package alone. `VerifyReport` and `ParsedExport` name the shapes;
  `scripts/ledger-verify.ts` stays the repository's CLI over the same call.
- `EXPORT_FORMAT` names the marker an export file's header line declares; `verifyExport`
  refuses files without it.

### Changed

- The npm package no longer carries `src/`; `dist` is the shipped code and `db/` the schema.
- The manifest declares `sideEffects: false`; no module does work at import time, so bundlers
  drop what a consumer does not use.

## 0.4.0 - 2026-07-18

### Changed

- Breaking: hard renames with the old names deleted, no aliases: `capabilitiesFromEnv` →
  `openPorts`, `Capabilities` → `Ports`, `checkEnv` → `preflight`, `describeSelection` /
  `Selection` → `describeEnv` / `EnvDescription`, `systemCapabilities` → `systemRuntime`,
  `runOnce` → `sweep`, `read.prove` → `read.health`, `SweepInput` → `SweepRequest`,
  `WebhookAck` → `WebhookReceipt`, `Options` → `CallOptions`, `noopLogger` / `noopMeter` →
  `silentLogger` / `silentMeter`, `redisCacheFrom` / `redisRateLimiterFrom` → `redisCache` /
  `redisRateLimiter`, `instanceSession` → `openInstanceSession`, `neg` → `negate`,
  `opsRuntime` → `createOpsRuntime`, `SessionDeps` / `SupervisorDeps` → `SessionPorts` /
  `SupervisorPorts`, `EntitlementAttrs` → `EntitlementAttributes`.
- Breaking: a rejected `Outcome` carries `detail` as its sole discriminant; the top-level
  `reason` field is deleted (`detail.reason` holds the code). Unchanged on the wire: HTTP
  responses still carry `reason` beside `detail`.
- Breaking: `EconomyStatus.paused` is `maintenanceActive`; the worker's own switch stays
  `sweepsPaused`.
- Breaking: `createEconomy(ports)` is the single construction call — the zero-arg and
  options-object forms are deleted; `createWorker(ports, economy)` replaces
  `createWorker(store, ctx)`.
- Breaking: `createServer` requires `authenticate`: pass a verifier, or `false` to trust the
  body's actor; leaving it unset throws `CONFIG.INVALID`.
- Breaking: the old composition entry points are deleted: `compose`, `composeWorker`,
  `workerCtxFrom`, `economyFromCapabilities`, `externalsFromEnv`, `ExternalPorts`,
  `Externals`, `RuntimeDefaults`, `EconomyOptions`, `WorkerCtx`.
- Breaking: the main entry slims to construction and domain; adapters, worker, server,
  store-kit, and netting symbols live on their own subpaths, with the construction calls
  dual-homed on the main entry.
- `postgresStore` and `mysqlStore` open without touching schema; `schema: 'assert'` checks
  the stamped version (`postgresStore` at open, `mysqlStore` once before the first operation),
  and `openPorts` asserts eagerly on the pool.

### Added

- `openPorts(env, init)` is the sole path from environment to ports: it loads `Config` and
  `Secrets` (init wins per field, both frozen), fills runtime and external ports with dev
  stand-ins outside production, opens the store the `DATABASE_URL` scheme names, and applies
  the production absence policy.
- `preflight(env, init)` reports `PreflightIssue`s without constructing anything; every issue
  with severity `error` is exactly what `openPorts` throws as one `CONFIG.INVALID`. A decline
  flag shadowing a configured source reports a `warning`.
- `boot(env, init)` returns `{ ports, economy, worker }` over one set of ports;
  `worker: false` skips the worker.
- `memoryPorts({ signingKey })` is a complete in-memory `Ports` value for tests and
  quickstarts: memory store, dev rates and fees, in-memory processor, and a real Ed25519
  signer.
- Production requires `dispatcher`, `payees`, and `anchor` to be set or explicitly declined
  (init `false`, or env `DISPATCHER_DECLINED`/`PAYEES_DECLINED`/`ANCHOR_DECLINED`); a bare
  omission fails startup. `DECLINE_KEYS` lists the flags.
- `Secrets` splits from `Config`: secrets load into `ports.secrets`, `SECRET_KEYS` names
  them, and `CONFIG_KEYS` is secrets-free. `DB_POOL_MAX` caps the SQL connection pool.
- `read.health()` is the light liveness read; `proveEconomy` stays the thorough pass.
- `DEV_RATES` names the development rate table; `paginate` walks any cursor read to
  completion; `findByHash` looks a transaction up by chain hash; `read.payouts` and
  `SagaStore.list` take a `states` filter.
- `worker.start()` runs on a built-in interval scheduler when no `scheduler` port is set.
- `idempotencyKey(...parts)` mints an idempotency key from the joined parts, or a random
  one when called bare.
- `usd(decimal)` builds a USD amount from a two-decimal string.
- `createSupervisorFrom(runtime, ports, scheduler)` builds the ops supervisor over an
  existing runtime's signals.
- The `./worker` and `./server` subpaths export the worker and HTTP server entry points.

## 0.3.2 - 2026-07-17

### Added

- `@pwngh/economy-lab/ops`: the operations supervisor, folded in from `@pwngh/economy-ops` —
  `opsRuntime` signal capture over the `meter`/`logger` ports, twelve signature detectors,
  `createSupervisor` with guarded remediations, audit records to an injected `AuditSink`. The
  core never imports it.
- Supervisor levers: a targeted relay re-drive (`SupervisorDeps.runRelay`), an inbox
  dead-letter revive (`SupervisorDeps.reviveInbox`), and worker pause on integrity mismatch
  (`SupervisorDeps.pauseWorker`) with a containment latch over every tier-1 lever.
- `hashChainedAuditSink` hash-chains the audit trail; `verifyAuditChain` reports the first
  break. `make audit-verify FILE=...`; `scripts/ops-audit-worm.ts` is the sealed-segment
  example.
- `OPS=1` composes the supervisor around the worker (`OPS_INTERVAL_MS` paces it); `demo:ops`
  runs the `stuck-saga`, `integrity`, and `deadlock` demos.
- `make backup` dumps each configured engine into `backups/`; `make restore-drill` restores
  the newest dump into a scratch `el_drill_*` namespace and proves it.
- `make ci` runs the whole GitHub CI locally: the check and apps jobs; `DB=1` adds the db
  matrix against live engines.

### Changed

- `VELOCITY_LIMIT_MINOR` is required in production (startup fails fast naming it, like the
  secrets); the 1,000-credit default applies outside production. `checkEnv` reports both
  policy anchors, `VELOCITY_LIMIT_MINOR` and `MATURITY_HORIZON_CARD_MS`.

### Documentation

- An Ops & runbooks section on the docs site: the supervisor, the audit trail, backup and
  restore, key rotation, and one runbook per signature.

## 0.3.1 - 2026-07-17

### Added

- `SIGNING_SECRETS_PRIOR` lists rotated-out signing secrets; checkpoints sealed under them
  still verify.
- The seal stamps the sealing key's `kid` onto the checkpoint row. `Signer.kid` (optional on
  the port) answers the current key's id; the default signer's is the first 16 hex characters
  of its Ed25519 public key. The `kid` is audit metadata only — verification still tries every
  trusted key — and rows sealed before stamping read back null.
- The `Anchor` port publishes each sealed checkpoint to a store outside the ledger's database
  (`WorkerCtx.anchor`, optional). A failed publish logs `worker.checkpoint.anchor_failed` and
  never blocks the seal; `httpAnchor` on the adapters subpath POSTs the row over HTTP.
- `read.export()` streams the ledger as canonical JSONL: a header, every account's chain links
  in lineage order, then the latest checkpoint. Amounts ride as decimal strings.
- `scripts/verify.ts` verifies an exported ledger offline — re-proves every hash chain and
  checks the checkpoint's Merkle root and Ed25519 signature against a published public key,
  with no store access. `make ledger-verify FILE=<jsonl> KEY=<hex public key>`; exits nonzero
  on any break.

## 0.3.0 - 2026-07-17

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
- `economy.webhook.duplicate` counts duplicate webhook acknowledgements, tagged `provider` and
  `layer` (`stale`, `replay`, `inbox`), via `ServerOptions.meter` and the `handleWebhook`
  context.
- `worker.checkpoint.seal_ms` records seal duration, tagged `outcome`.
- `worker.sweep` counts each worker batch, tagged `failed` with the batch's failed-job count;
  `worker.checkpoint.verify` counts each clean verify (`outcome: 'ok'`).
- `economy.submit` carries a rejection's `reason` code alongside `kind` and `status`.
- `SweepInput.only` narrows a worker run to the named jobs; the rest report idle summaries.
- The rate ordering `buy >= par` is enforced for every rate source: `economyFromCapabilities`
  throws `CONFIG_INVALID` at construction on a misordered source, and a source that turns
  misordered afterward faults the top-up with the same code and both rate ids.
- Payouts are priced once, at request: `requestPayout` stores the USD quote on the saga
  (`Saga.payoutUsd`), the worker submits that quote to the rail, `settlePayout` posts it
  unchanged under the locked `rateId`, and the treasury float sweep values in-flight payouts
  at it. `requestPayout` throws `CONFIG_INVALID` when the payout rate exceeds `par`. Rows
  opened before pricing-at-request keep converting at the current rate.

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
