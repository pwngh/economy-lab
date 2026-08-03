# Changelog

Notable changes to `@pwngh/economy-lab`, newest first. Dates are npm publish dates.

## Unreleased (0.8.0)

### Added

- `TableSizes` and `CapacityReport.tables` carry `entitlements`, counting revoked and live rows alike. `read.capacity()` states a fact past `CAPACITY_THRESHOLDS.tableRows` naming the table
  as one row per purchase and its retention as a host policy decision. Breaking: a custom `Store`
  offering `tableSizes` must return the count.
- `ERROR_CODES` publishes `UNKNOWN_ROUTE` (`STORE.UNKNOWN_ROUTE`) and `UNKNOWN_SESSION`
  (`STORE.UNKNOWN_SESSION`), the store protocol's two permanent refusals. `statusForError` maps both to `400`.
- `StoreCapability` names the twelve optional store surfaces; `sealHeads` covers the
  `checkpoints.sealHeads`/`putSealHeads` pair. `./store-kit` publishes `STORE_CAPABILITIES`,
  `capabilitiesOf` and `capabilityConflicts`.
- `runStoreConformance` takes the store's own capability declaration; a capability the store
  declares but does not carry fails the suite, naming it.
- `./testing` publishes the `StoreConformanceOptions` type.
- The store conformance suite covers `lockMany` and `historySize`, a posting whose legs both raise
  and lower one account, and a recorded idempotency key whose transaction rolls back.
- `./testing` publishes `runRateLimiterConformance` and the `RateLimiterHarness` type: the shared
  `RateLimiter` contract every implementation runs, refusals and `retryAfterMs` recovery included.
- `./adapters` publishes `assertRatePolicy` and the `RatePolicy` type; `memoryRateLimiter` and
  `redisRateLimiter` refuse a non-positive `windowMs` or `limit` with `CONFIG.INVALID`.
- The store conformance suite runs one written-out workload against the store and against a fresh
  memory oracle and compares eleven reads.
- `./server` publishes `correlationOf`, `verifyHmac`, `signHmac`, `faultResponse`,
  `sanitizeClientIp`, `isCallerToken`, `SIGNATURE_HEADER` and `TIMESTAMP_HEADER`.
- `./store-kit` publishes `toBase64Url` and `fromBase64Url`; the decoder takes the canonical
  spelling only, so one signature has one string that verifies.
- `./sql-kit` publishes `rowToAccrual`, `rowToSale`, `endOwnedPool` and `safeSqlIdentifier`.
- `./adapters` publishes the `MemoryLedger` type, which names the in-memory ledger's
  `__seedBalance` and `__tamper` hooks.
- `.` publishes the `BoundaryBreak` type, the shape `VerifyReport.firstBreak` carries when an
  export's archive boundary did not authenticate.
- `.` publishes the `ChainBreak` type, the shape a chain break carries on both `firstBreak`
  fields: the account, the transaction, the reason and the two hashes that disagree.
- `.` publishes `readInt`, `readIntOrNull`, `withinIntBounds` and `IntBounds`: reading an integer
  knob out of an environment, and checking one a caller already parsed.
- The `./contract` subpath publishes `FIELDS`, `ROUTES` and `buildOpenApi()`.
- `./contract` publishes `OPERATION_FIELDS`, every field of every operation kind; `FIELDS` is the
  subset a caller may send.
- `./contract` publishes `assertOperationShape` and `hasWireShape`, the field-shape predicates the
  HTTP door and the submit seam both check with.
- The `./client` subpath ships `createClient({ baseUrl, token, fetch? })`: one `submit` and one
  method per `/v1` read. A rejection returns; transport and auth failures throw `EconomyHttpError`.
- `./client` publishes `joinUrl`, `WIRE_LIST_KEY` and `wireRowIdentity`: how a base URL
  joins a path, and which field carries a list row's identity.
- `read.wallet`, `read.entitlements`, `read.subscriptions` and `read.payouts` are the storefront
  reads. Breaking: custom `SubscriptionStore` implementations must provide `listFor`.
- The `/v1` read routes on the reference host: `wallet`, `entitlements`, `subscriptions`,
  `payouts`, `rates`, `catalog` and `posting/{txnId}`. `ServerOptions.reads: false` unmounts them.
  Breaking: `ServerPorts` includes `rates`.
- `Ports.catalog` takes a host-owned `CatalogPort` and `submit` checks every `spend` against it,
  so a spend off the live offer answers `CATALOG_MISMATCH` naming the disagreeing field.
- `EVENT_TYPES` pins the fourteen event types and `EconomyEvent.type` is that union. Breaking:
  an unrostered type string no longer compiles. Unchanged on the wire.
- `PromoStore.liveFor(userId)` returns every not-yet-reversed grant a user holds, expired or not.
  Breaking: custom `Store` implementations must carry it.
- `PromoStore.holders()` streams every user id holding a grant row, reversed rows included.
  Breaking: custom `Store` implementations must carry it.
- `EntitlementStore.revoke` takes `options.source`, the grant to drop; without it the call drops
  every grant on the sku. `./store-kit` publishes `collapseEntitlementGrants` and `EntitlementRowRef`.
  Breaking: custom `Store` implementations key entitlements on `(userId, sku, source)` and yield
  `sources` from `list`.
- `read.export()` emits the signed archive boundary, and `verifyExport` authenticates it offline.
  `VerifyReport.boundary` carries the verdict.
- `packages/economy` hosts `@pwngh/economy`, the front door to the lab: `createApp` builds a
  running economy from an `economy.app.ts` module, and the `economy` bin runs
  `dev | serve | worker | check | routes`.

### Changed

- `statusForError` reads the retry verdict before the code: a non-retryable `SAGA.INVALID_TRANSITION`
  or `SESSION.SETTLED` answers `409` where it answered `500`, and the retryable arms still answer `503`.
- `statusForError` answers `421` for `SESSION.MISROUTED`, and the problem response carries `owner`,
  the node holding the scope, so a redirected caller is told where to go.
- `ProveReport` carries `firstBreak`, the `ChainBreak` behind a false `chainIntact`. `HealthReport`
  narrows it to `null`, because the light chain check opens no link. Reading a report is unchanged;
  a caller that builds one by hand supplies the new field.
- `VerifyReport.firstBreak` is typed `ChainBreak | BoundaryBreak | null` rather than `unknown`.
- `ProveReport` carries `prover`, naming which prover filled it: `proveEconomy` or `read.health`.
  The two flags named `chainIntact` answer different questions, so a copied report says which it
  holds. `HealthReport` narrows to the second; a caller that builds one by hand supplies the field.
- Breaking: the supervisor's `prove` port returns a `ProveReport` rather than `unknown`, and
  `detail.prover` names the prover behind the integrity escalation's evidence, null when there is none.
- The repository runs its own product: `economy/app.ts` is an `EconomyModule` the `economy` bin
  discovers with no flag, and the Docker image runs `economy serve` over it. The hand-wired host
  entry `main.ts`, its `demo.ts` sample and the `server-env.ts` knob parser are gone; `npm run dev`,
  `start`, `worker` and `demo` run bin verbs.
- The Tilia and taskq host bridges moved to `economy/lib/`; each hands its port to `createApp`
  behind a slot that carries a `close`, so the framework releases what the module opened.
- Breaking: the `./ops` subpath is `./supervisor` and exports the same 44 names, two of them
  renamed. `/api/modules/ops.html` redirects to the renamed module page.
- Breaking: the `./testing` subpath is gone; `runStoreConformance`, `runCacheConformance`,
  `runRateLimiterConformance`, `runDispatcherConformance`, `runProcessorConformance`,
  `StoreConformanceOptions`, `DispatcherHarness` and `ProcessorHarness` are
  `@pwngh/economy-conformance`, reached through `@pwngh/economy/conformance`. The lab compiles
  only what it publishes, so no test file ships in its tarball.
- `.` publishes `postEntry`, the validated posting write a conformance suite builds ledger state
  with.
- Breaking: `OpsRuntime` is `SupervisorRuntime` and `createOpsRuntime` is
  `createSupervisorRuntime` on `./supervisor`. The other 42 names are unchanged.
- Breaking: the module flag `flags.ops` is `flags.supervisor`; `flags: { ops: true }` is refused
  with `UNKNOWN_EXPORT` naming the new spelling. `AppHandle.ops` is `AppHandle.supervisor`.
- `SUPERVISOR=1` compiles to the module's `flags.supervisor` rather than a second supervisor
  composition in the host. `OPS_INTERVAL_MS` is gone; the supervisor ticks on `WORKER_INTERVAL_MS`.
- The supervisor's audit sink logs under `supervisor.audit`.
- `describeEnv` reports the port kind `openPorts` will build: `store` and `processor` gain
  `supplied`, `cache` gains `supplied` and `declined`. `url` stays the knob the environment names.
- Breaking: the Redis, SQS, Postgres and MySQL adapters left the lab for their own packages, and
  their drivers are no longer peer dependencies of the lab. The four packages publish in the same
  release as this one; the five bullets below name every symbol that moved and where it went.
- Breaking: `./adapters/redis` is gone; `redisCache` and `redisRateLimiter` are
  `@pwngh/economy-redis`.
- Breaking: `./adapters/sqs` is gone; `sqsDispatcher`, `SqsClient`, `SqsCommand` and
  `SqsDispatcherOptions` are `@pwngh/economy-sqs`.
- Breaking: `./engines/postgres` is gone; `postgresStore`, `PgPool`, `PostgresStoreOptions` and
  `EngineOpenOptions` are `@pwngh/economy-postgres`.
- Breaking: `./engines/mysql` is gone; `mysqlStore`, `createMysqlPool`, `applyMysqlSchema`,
  `readSchemaVersion`, `MysqlPool` and `EngineOpenOptions` are `@pwngh/economy-mysql`.
- Breaking: `./engines/mysql-mariadb` is gone; `createMariadbPool` and `MysqlPool` are
  `@pwngh/economy-mysql/mariadb`.
- A pagination cursor is read under the canonical base64url decoder; a re-spelled cursor answers
  `400` where it used to decode.
- Breaking: `reversePayout.providerReported` is off the wire contract. A request body naming it
  answers `OP.MALFORMED`. The verified payout-failed webhook still sets it.
- Breaking: `feeForPrice` takes the priced `Amount` where it took a bare minor count.
- Breaking: `Config.freshnessWindowMs` and `FRESHNESS_WINDOW_MS` are the webhook timestamp bound that
  `replayWindowMs` and `REPLAY_WINDOW_MS` were; replay is refused by the event-id claim on
  `ServerOptions.replay`. No alias — a `REPLAY_WINDOW_MS` still set is a `preflight` warning.
- A promo spend draws down the soonest-expiring grant first, ties by grant id.
- The promo-expiry sweep re-proves every grant face it reads against that grant's posting; an
  unverifiable row is refused with `CHAIN.BROKEN`.
- `src/money-arithmetic.ts`, `src/money-sql.ts` and `src/fold.ts` carry the money arithmetic, and
  the lab depends on no money package. No published symbol or subpath moves.

### Fixed

- `build:packages` links a workspace bin whose target did not exist at install time. `npm ci` runs
  before the build, so a fresh checkout linked neither the `economy` bin nor `create-economy`.
- The `check` workflow job runs the static tier only. It also ran the unit tier, which needs
  postgres and mysql and counts an unreachable engine as a failure rather than a skip.

- `createSupervisor` holds every `SupervisorConfig` knob to its bounds and throws `CONFIG.INVALID`
  at construction, naming the knob and its range. Out of bounds, a knob switched a detection
  pass off with nothing said. Durations cap at 86400000 (24 hours), count thresholds at a minimum of 1.
- A throw out of the supervisor's `escalate` hook is caught and recorded as an `acted` audit record
  carrying `{ action: 'page', failure }`. It used to abort the tick before containment ran.
- `createServer` holds `ports.config` to the knob bounds and throws `CONFIG.INVALID` with the knob
  and its range. `ServerPorts` is a `Pick` a host builds by hand, and its config had met no door.
- `Config.freshnessWindowMs` carries a maximum of 86400000 (24 hours). A larger window admits every
  timestamp, which turns the webhook skew check off rather than widening it.
- `defaultConfig`, `mergeConfig`, `inspectConfig`, `memoryPorts` and `openPorts` all read one set of
  `Config` knob bounds: a value outside them is `CONFIG.INVALID` naming the knob and range, and an
  environment value the reader discarded for its default is a `preflight` warning. Init knobs used
  to be applied unbounded.
- The knob bounds hold at every door — `createEconomy`, `createWorker`, `runSweeps`, `drainInbox`,
  `relayOutbox` and the instance lane answer `CONFIG.INVALID` with the knob and the range.
  `Ctx.config` and `WorkerCtx.config` take only a checked config, so a new door fails the typecheck.
- `CONFIG_KEYS` is derived from the knob table rather than restated, so a new knob with no
  `.env.example` entry fails the environment-surface gate. Its value and order are unchanged.
- `preflight` reported a `TOP_UP_BUNDLES_MINOR` the resolver throws on as clean, so a deploy gate
  passed on an environment that could not boot.
- All three declinable slots resolve through the same reading `dispatcher` already used, so
  `PAYEES_DECLINED` and `ANCHOR_DECLINED` win over a port supplied through the init.
- `verifyExport` reports `chainIntact: false` when the archive boundary fails authentication or is
  verified with no public key, and `firstBreak` carries a `BoundaryBreak` naming which. Both had
  reported `chainIntact: true` where the live prover faults.
- `recordCheckpoint`'s dirty set is every leaf whose head or sum moved, so an account whose sum
  moved behind an unchanged head is replayed in full rather than signed over.
- `reproveStoredChains` holds each link against the link before it, across page edges, so a link
  deleted from the middle of a chain no longer leaves the page reported clean. A signed boundary's
  archive head is the only predecessor a prune may have removed.
- A `limit` of zero let one call per window through `memoryRateLimiter` while `redisRateLimiter`
  denied it. Every call goes through the one comparison.
- The HTTP store server threw a bare error for an unknown route, path prefix or transaction id, and
  each wrapped as a retryable `STORE.FAILURE` with the name stripped out. All three are typed at
  their throw sites as non-retryable `STORE.UNKNOWN_ROUTE` or `STORE.UNKNOWN_SESSION`.
- The HTTP store client discarded a `retryable: false` when it rewrote a fault code it does not
  know. It rewrites the code still, and keeps the server's verdict.
- `submit` and `submitBatch` checked no field's type, so a non-string id became an account by
  interpolation. `validateOperation` runs `assertOperationShape` over `FIELDS`, and a wrong shape
  is `OP.MALFORMED` naming the field.
- `InstanceEconomy.purchase` posts without passing `validateOperation`, so `buyerId`, `product.sku`,
  `price` and `recipients` are checked against the same predicates.
- Every engine orders `read.statement` by commit sequence, then by leg within a posting. MySQL used
  to order by `postedAt`, which a stepped-back `Clock` could permute.
- `OutboxStore.claimBatch` and `InboxStore.claimInbound` left a Postgres timestamp tie unordered,
  so a claim smaller than the tie could pass a row over indefinitely; both end on the primary key.
- One row per `(userId, sku)` made every revoke take the sku whole. Rows are keyed by the granting
  source, so refund, the settle-replay backstop and the lapse each revoke only the grant they made.
  Schema 18.
- `feeForPrice` and `revenueForSplit` rounded a fee up to a whole unit on any currency, so the
  fee-exceeds-price cap could miss. Both refuse a price that is not CREDIT.
- The promo-expiry sweep clamped each reversal against the whole pooled promo balance, so an
  expiring grant clawed back credit belonging to a grant that had not expired.
- The promo sweep burns pooled credit no live grant claims back to `SYSTEM.PROMO_FLOAT`
  (`promos.surplus`), reported by `PromoExpirySummary.surplus`. A refund of a promo-funded sale
  stranded the difference.
- The store conformance suite registers a skip naming the capability a store lacks; seven
  branches against the HTTP store had reported a pass having asserted nothing.
- `SagaAdvanceOptions.expectAttempts` makes a same-state `SagaStore.advance` exclusive, so a
  permanently failing payout is dead-lettered and its reserve returned.
- The `checkpointVerify` sweep audits against the sealed-head snapshot; a store carrying no snapshot
  reports `unverified` rather than a pass. It had flagged a mismatch on every cycle with traffic.
- `createClient` interpolated a non-string `options.token`, sending the literal
  `Bearer () => 'tok'`. It throws a `TypeError` naming `@pwngh/economy-client`.
- `joinUrl` strips every trailing slash from the base and every leading slash from the path, so a
  `baseUrl` of `//` no longer builds a protocol-relative URL that sends the bearer token off-origin.
- A checkpoint sealed after an archival pass no longer dead-letters with `CHAIN.BROKEN`; the live
  remainder chains from the pruned anchor hash.
- A settle whose replay threw left the session on the netted path, so a retry paid the net twice.
  Failover forces the replay path.
- `InstanceSession.wasSettled()` reports finished only once every chunk has posted; a settle that
  stopped between chunks had been skipped by the orphan sweep and pruned by retention.
- `recoverSession` derived chunk ids from its own `chunkWidth`, which a recovering process need not
  have been given. It reads the width off the stored chunk's legs.
- The orphan sweep refunded a session escrow with no age bound, even in its report-only default.
  The refund waits for `settleOlderThanMs`, like the settle.
- `refundEscrowRemainder` reads the remainder under the escrow lock, inside the transaction that
  spends it, so a settle chunk landing in between cannot overdraw the escrow.
- A throw carrying a string `code` beside a boolean `retryable` keeps its own verdict, and the inbox
  dead-letters a non-retryable provider fault on its first failure. Every injected-port throw had
  wrapped as retryable `PROVIDER.FAILURE`; one carrying no verdict still does.
- A non-retryable submit throw fails the payout through the dead-letter reversal on the first
  hand-off, returning the reserve at once; a retryable or verdict-less throw keeps the full attempt
  budget and the settlement window. The hand-off and status-probe logs carry the port fault's code.
- `relayOutbox` dead-letters a non-retryable dispatcher throw on the first delivery under the fault's
  code; a retryable or verdict-less throw keeps the full `maxOutboxAttempts` budget.

### Documentation

- TSDoc on the exported surface and the comments in `src/`, `scripts/`, and `test/` are
  rewritten in plain language.
- The `/api` module pages are named by import path (`ports`, `worker`, `engines/postgres`,
  `testing`); the old file-path URLs answer 301 redirects.
- The HTTP snippets and handbook examples use amounts at real platform scale; each snippet
  shows its response envelope.
- The README states sixteen sweeps; `test/readme.test.ts` pins the count to `SWEEP_NAMES`.

## 0.7.0 - 2026-07-23

### Added

- `read.capacity()` reports history size, verified-through and checkpoint ages, accrual backlog,
  and session and reservation footprints, with an advisory per gauge against the exported
  `CAPACITY_THRESHOLDS`. Breaking: custom `Economy` implementations must provide it.
- `sweepRetention` prunes idempotency rows older than `idempotencyOlderThanMs`
  (`IdempotencyStore.deleteOlderThan`) and settled sessions older than `sessionsOlderThanMs`; a
  session is pruned only after its settle posting re-proves. The worker runs it as the
  `retention` job.
- `archiveSealedPrefix` moves sealed history pages to an `ArchiveSink` under signed per-account
  archive heads, and the prover verifies the pruned boundary at every proof
  (`CheckpointStore.putArchiveBoundary`). `Ledger.archivePage` pages postings out;
  `Ledger.prune` deletes them once archived.
- The stamped SQL schema version is 17: `archive_state`, `archive_heads`, and an
  oldest-first index on `idempotency.created_at`.

## 0.6.3 - 2026-07-23

### Added

- `openClusterNode` composes a multi-node economy behind a rendezvous-hashed `scopeRouter`: each
  session scope routes to one node, a call landing on the wrong node is refused with
  `SESSION.MISROUTED`, and the orphan sweep takes over scopes whose node died.

## 0.6.2 - 2026-07-23

### Added

- `@pwngh/economy-lab/engines/mysql-mariadb` opens the MySQL store over a `mariadb` pool
  (`createMariadbPool`; the dependency is an optional peer). `mysql2` stays the default engine.
- `partitionedSchemaSql(canonical)` rewrites the PostgreSQL schema onto a hash-partitioned
  layout; the store conformance suite covers it.
- `WIRE_TRIAL` runs the store conformance suite over an alternative wire driver behind the pool
  seam; `BENCH_PG_DRIVER` and `BENCH_MYSQL_DRIVER` pick the drivers a bench run uses.
- `npm run bench:queue` runs an unattended sequence of bench rounds with cool-downs and a
  per-backend rig canary (`BENCH_QUEUE`, `BENCH_QUEUE_COOLDOWN_MS`, `BENCH_CANARY_OPS`).
- `make env` merges `.env.compose`'s container URLs into `.env` without overwriting values
  already set.

## 0.6.1 - 2026-07-23

### Added

- `openInstanceSession` sessions net purchases by product kind: `instant` stays in the session
  journal, `permanent` and `temporary` grant at the call and settle later. A session settles
  once — a record after settle is refused with `SESSION.SETTLED` — and long-lived scopes rotate
  by epoch (`epochMinter`).
- `sharedReservations` keeps the reservation counter in the store, so it holds across processes
  and nodes; `createReservations` stays the in-process default.
- `openInstanceEconomy` is the session fast lane over netting: ownership is durable at the
  purchase call, ledger money moves at settle. Purchases screen against matured balance,
  per-user session caps, and idempotent replay.
- `InstanceEconomyOptions.prefund` funds a per-session escrow up front so draws cannot fail at
  settle; settle refunds the remainder.
- `sweepOrphanSessions` settles or releases sessions whose owner vanished and
  `reconcileReservations` repairs the shared counter; both run as worker jobs.

## 0.6.0 - 2026-07-23

### Added

- The accrual split parks seller shares on the `platform:settlement_accrual` shard at `spend`
  and `subscribe` (`ACCRUAL_DRAIN=1`, `Config.accrualDrain`), and rows land in `accrual_rows`
  until drained. Breaking: `Store.accruals` is required of custom stores.
- The worker's accrual drain sweep moves parked shares to sellers' earned wallets in batches.
- `post_entries` fuses each posting's writes into one stored-procedure call on both SQL
  engines, and the engines answer account existence from a cache whose entries are added only
  at commit.
- `Economy.submitBatch(operations, options)` commits a group of operations in one store
  transaction and isolates a failing member by bisection; `BatchOutcome` reports each slot,
  index-aligned with the input. `createSubmitCoalescer` folds concurrent submits into batches
  behind one flush. Breaking: custom `Economy` implementations must provide `submitBatch`.
- The stamped SQL schema version is 16: `accrual_rows`, the `reservations` table, and the
  `escrow` account kind.

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
