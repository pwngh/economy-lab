/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import type { Amount, Currency } from '#src/money.ts';
import type {
  Transaction,
  EntitlementAttrs,
  FeePolicy,
  Operation,
} from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Config } from '#src/config.ts';

/** Per-call options. Pass a `signal` to let the caller cancel the operation in flight. */
export type Options = { signal?: AbortSignal };

/**
 * Bounds a {@link Ledger.timeline} read so the page, not the account lifetime, sets the cost. The
 * default (omitted, or `order: 'asc'` with no `limit`) streams the whole lot history oldest-first,
 * as the original signature did; `order: 'desc'` with `limit`/`offset` reads the newest run, the
 * order the maturity tail wants so it can stop once it has covered the live balance.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging}
 * for the SQL pushdown.
 */
export type TimelineOptions = {
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

/** Allowed id prefixes. Every minted id is `<prefix>_<uuid>` (e.g. `txn_…`, `usr_…`). */
export type IdPrefix =
  | 'usr' // a user — host-supplied (not minted here); owns the wallet accounts
  | 'txn' // a ledger transaction: one posting of balanced legs
  | 'evt' // a domain event (EconomyEvent), emitted on commit
  | 'obx' // an outbox row: a pending event awaiting relay
  | 'ibx' // an inbox row: a verified inbound event awaiting apply
  | 'pay' // a payout saga
  | 'sub' // a subscription
  | 'chk' // a signed integrity checkpoint
  | 'ent' // an entitlement — reserved (declared, not currently minted)
  | 'rec' // a record, e.g. reconciliation/receivable — reserved (not currently minted)
  | 'adj'; // an operator adjustment — reserved (not currently minted)

/** Reads the current wall-clock time. */
export interface Clock {
  /** Milliseconds since the Unix epoch (midnight UTC, 1 Jan 1970). */
  now(): number;
}

/** Mints fresh unique ids. */
export interface Ids {
  /** Returns a new id of the form `${prefix}_${uuidv4}`. */
  next(prefix: IdPrefix): string;
}

/** Hashes raw bytes. */
export interface Digest {
  /** Returns the SHA-256 hash of the input, computed via the platform's crypto.subtle. */
  hash(bytes: Uint8Array): Promise<Uint8Array>;
}

/**
 * Signs bytes and checks signatures, used to vouch for ledger checkpoints.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/signer/ Signer} for the contract,
 * the reference adapter, and key rotation.
 */
export interface Signer {
  sign(bytes: Uint8Array): Promise<Uint8Array>;

  /**
   * True if the signature is authentic. Accepts the current key plus still-valid older keys,
   * so a signature made before a key rotation keeps verifying.
   */
  verify(bytes: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/**
 * Optional read-through key/value cache for hot reads such as balances. The cache is best-effort, so
 * any error degrades to a direct ledger read and never fails the request. When none is injected, the
 * read path skips it and goes straight to the ledger. A cache therefore only ever speeds reads up; it
 * never breaks them. `memoryCache` is the in-process reference adapter; `redisCacheFrom` is the Redis
 * adapter.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging}
 * for the best-effort cache contract.
 */
export interface Cache {
  get(key: string): Promise<string | null>;

  /** Store a value, optionally expiring it after `ttlMs` milliseconds. */
  set(key: string, value: string, ttlMs?: number): Promise<void>;

  invalidate(key: string): Promise<void>;
}

/** Runs a task repeatedly on a fixed interval (used by the background worker). */
export interface Scheduler {
  /**
   * Runs `task` every `ms` milliseconds and returns a function that stops it. The loop lives behind
   * this port rather than a raw setInterval, so start and stop share one code path.
   */
  every(ms: number, task: () => Promise<void>, options?: Options): () => void;
}

/**
 * Hands an outgoing event off for delivery. The adapter sends it onward (e.g. SQS or HTTP);
 * the core doesn't know which.
 */
export type Dispatcher = (
  event: EconomyEvent,
  options?: Options,
) => Promise<void>;

/**
 * External payment provider that pays sellers (e.g. a payout processor or payment rail). All money
 * leaving the platform goes through this.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for the seam,
 * the Thunes adapter, and dispute webhooks.
 */
export interface Processor {
  /**
   * Pays a user. `amount` is in real USD. `key` makes the request safe to retry without paying
   * twice. Returns the provider's reference for the payout.
   */
  submitPayout(
    input: { key: string; userId: string; amount: Amount },
    options?: Options,
  ): Promise<{ providerRef: string }>;

  // There is no "did it settle?" call. The provider reports settlement and disputes through inbound
  // webhooks, which the worker reconciles.
}

/**
 * Dual-Rate Credit Economy.
 *
 * This port supplies fixed CREDIT-to-USD rates from an audited source, never from config or caller
 * input. It hands the core three rates that always hold the order `buy >= par >= payout`, where the
 * `buy`-to-`par` gap is the platform spread.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/money-model/ The money model} for
 * what `buy`/`par`/`payout` mean, why the ordering holds, and what the spread funds.
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/rates/ Rates} for the port and its
 * configured adapter.
 */
export interface Rates {
  /**
   * Returns the settlement rate to convert one currency to another at a point in time. This is
   * mainly used to convert CREDIT to USD on payout, where the rate equals `par`.
   */
  payout(
    from: Currency,
    to: Currency,
    at: number,
    options?: Options,
  ): Promise<Rate>;

  /**
   * Returns the redemption and backing rate. The reconciliation check uses it to confirm the
   * platform holds enough real USD to cover every user's spendable credits, valuing those credits
   * in USD at this rate.
   */
  par(currency: Currency): Rate;

  /**
   * Returns the acquisition rate a user pays when buying credits. It is less favorable than `par`
   * or `payout`. `topUp` values the buyer's cash at this rate. The gap between it and `par` is the
   * platform spread (see this type's doc-comment).
   */
  buy(currency: Currency): Rate;
}

/**
 * An exchange rate, stored as exact integers to avoid floating-point drift. The multiplier
 * is `rate / 10^scale` (e.g. rate 50, scale 2 = 0.50 USD per credit). `rateId` names this
 * rate so a transaction can record which one it used.
 *
 * Convert: usd_minor = floor(credit_minor × rate / 10^scale).
 */
export type Rate = { rate: bigint; scale: number; rateId: string };

/** Structured logging. */
export interface Logger {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>,
  ): void;
}

/** Emits metrics. */
export interface Meter {
  count(name: string, n: number, tags?: Record<string, string>): void;

  observe(name: string, value: number, tags?: Record<string, string>): void;
}

/**
 * The append-only double-entry ledger: records money movements, reads back balances and history.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/
 *   Accounts & double-entry}
 * for postings, legs, and the chart of accounts.
 */
export interface Ledger {
  hasAccount(account: AccountRef, options?: Options): Promise<boolean>;

  /** Takes a row lock on an account so concurrent operations can't race on its balance. */
  lock(account: AccountRef, options?: Options): Promise<void>;

  /**
   * Locks several accounts in one round trip, in a single deadlock-free global order. Optional:
   * `lockAll` (src/ledger.ts) uses it when present (Postgres' ordered `for update`), else falls back
   * to per-account `lock` in that same order (in-memory no-op lock, MySQL's per-name GET_LOCK). Only
   * meaningful inside a transaction, where locks release at commit, like `lock`.
   */
  lockMany?(
    accounts: ReadonlyArray<AccountRef>,
    options?: Options,
  ): Promise<void>;

  /**
   * Records one posting, a balanced set of debit and credit lines, and returns the committed
   * transaction.
   */
  append(posting: Posting, options?: Options): Promise<Transaction>;

  /**
   * Returns the account's current balance. This is a maintained running total, so it is a single
   * read rather than a sum over the account's whole history.
   */
  balance(account: AccountRef, options?: Options): Promise<Amount>;

  /** Returns a page of the account's entries within a time range (see Statement). */
  statement(
    account: AccountRef,
    range: Range,
    options?: Options,
  ): Promise<Statement>;

  /**
   * Streams the account's settlement lots. Each lot is a chunk of funds from a single top-up,
   * tagged with the date it becomes eligible to be paid out (see {@link Lot}). Lots stream one at a
   * time so a long history doesn't have to fit in memory. `options` bounds the read so a caller
   * that only needs the newest run of lots (the maturity FIFO tail) never touches the whole account
   * history; the default is the full history, oldest-first. See {@link TimelineOptions}.
   */
  timeline(account: AccountRef, options?: TimelineOptions): AsyncIterable<Lot>;

  /**
   * Streams every account paired with its current chain-head hash, the latest hash in that
   * account's tamper-evident chain.
   */
  heads(): AsyncIterable<readonly [AccountRef, string]>;

  /**
   * Streams every account that has a cached running-balance row, one at a time (SQL:
   * `account_balances`; memory: keys of `state.balances`). Entries are the source of truth, so a
   * cached row can exist with no posting behind it. `heads` never visits such an account, so the
   * prover relies on this list to surface it as a mismatch.
   */
  balanceAccounts(options?: Options): AsyncIterable<AccountRef>;

  /**
   * Streams every posting that touched `account`, in commit order, with each recorded hash. The
   * integrity prover replays these to recompute the account's head hash and confirm nothing was
   * altered. Head hashes alone only show the chain is well-formed; replaying the full postings
   * catches an edited line.
   */
  lineage(account: AccountRef, options?: Options): AsyncIterable<StoredLink>;

  /**
   * Returns the whole posting that committed under `txnId`, or null if no such id exists. A reversal
   * loads this posting and negates its lines to post the exact opposite. Returning null on an
   * unknown id lets the operator-reversal handler fail loudly. Unlike `lineage`, this is not scoped
   * to one account: it returns the one transaction with all its lines.
   */
  posting(txnId: string, options?: Options): Promise<Posting | null>;

  /**
   * Streams every committed posting, newest commit first, one at a time like `SagaStore.list`.
   * Unlike `posting` (one transaction by id) or `lineage` (one account's chain), this is the whole
   * ledger: every transaction type and every account touched. A UI can render the journal from it
   * without tracking minted txn ids itself. Each posting carries its full legs, like `posting`, so a
   * reader can expand a row without a second lookup. "Newest first" follows the commit sequence (the
   * postings primary key and sequence), so the order is total and ties never reorder a page.
   */
  list(options?: Options): AsyncIterable<Posting>;
}

/**
 * The full set of stores the system reads and writes. `transaction` runs a block of work
 * with all of these committing atomically (all or nothing).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging}
 * for the sub-stores, the outbox/inbox, and the adapters.
 */
export interface Store {
  ledger: Ledger;
  idempotency: IdempotencyStore;
  sales: SaleStore;
  outbox: OutboxStore;
  inbox: InboxStore;
  sagas: SagaStore;
  entitlements: EntitlementStore;
  subscriptions: SubscriptionStore;
  promos: PromoStore;
  trust: TrustStore;
  checkpoints: CheckpointStore;
  replay: ReplayStore;

  /**
   * Runs `work` inside one database transaction, passing it the subset of stores that participate
   * in that transaction. Everything `work` writes commits together or not at all.
   */
  transaction<T>(work: (tx: Unit) => Promise<T>, options?: Options): Promise<T>;

  close(): Promise<void>;
}

/** Every external capability `createEconomy(...)` needs, gathered into one object. */
export type Capabilities = {
  store: Store;
  clock: Clock;
  ids: Ids;
  digest: Digest;
  signer: Signer;
  processor: Processor;
  rates: Rates;
  logger: Logger;
  meter: Meter;
  cache?: Cache;
  scheduler?: Scheduler;
  dispatcher?: Dispatcher;
  pricing: FeePolicy;
  config: Config;
};

/**
 * One line of a posting: an account and the amount applied to it. Signed positive in whichever
 * direction grows that account's balance. Some accounts grow when debited, others when credited,
 * so two accounts of opposite kinds in one posting carry opposite signs.
 */
export type Leg = { account: AccountRef; amount: Amount };

/**
 * A balanced double-entry posting: a transaction id, its debit/credit lines (legs), and
 * free-form metadata. Legs sum to zero in each currency, so every debit is matched by an equal
 * credit and no money is created or lost.
 */
export type Posting = {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
};

/**
 * One posting as `lineage` returns it for a single account, carrying the two hashes that tie it
 * into that account's tamper-evident chain. Each link's hash commits to the account's prior head,
 * so altering a past entry stops the chain re-deriving. The prover re-hashes (previous head + the
 * account's legs + meta) and checks it equals the stored `hash`; an after-the-fact edit won't match.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 * hash chain.
 */
export type StoredLink = {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;

  /**
   * The account's head hash before this posting (a fixed all-zeros "genesis" hex for the
   * account's first posting).
   */
  prevHash: string;

  /**
   * The account's head hash after this posting, recorded when it was appended; what the prover's
   * recompute must reproduce.
   */
  hash: string;
};

/**
 * The stores a single operation's handler may write to, all inside one database transaction so its
 * writes commit together. `promos` and `inbox` are included so their writes share the money
 * posting's transaction; a rolled-back grant or apply then leaves no orphan row. `trust` rides the
 * transaction too, so a committed attempt shares the money commit; after a rollback, `submit`
 * re-records the attempt so it still counts. `checkpoints` is absent (only the worker writes it).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging}
 * for atomicity and the outbox/inbox.
 */
export interface Unit {
  ledger: Ledger;
  idempotency: IdempotencyStore;
  sales: SaleStore;
  outbox: OutboxStore;
  inbox: InboxStore;
  sagas: SagaStore;
  entitlements: EntitlementStore;
  subscriptions: SubscriptionStore;
  promos: PromoStore;
  trust: TrustStore;
  /**
   * Balances cached for one operation so the funds screen and handler share one read each; the pipeline
   * fills it after locking. Unset outside the pipeline (e.g. a test), where readers use `ledger.balance`.
   */
  balances?: Map<string, Amount>;
}

/** Makes a repeated request run at most once, keyed by the caller's idempotency key. */
export interface IdempotencyStore {
  /**
   * Stakes a claim on a key. The first caller gets `{ claimed: true }` and may proceed. If another
   * caller is still mid-flight on the same key, this call waits for them. If that caller committed,
   * this returns `{ claimed: false }` with their recorded transaction, so the duplicate returns the
   * same result. If that caller rolled back, the key was never recorded, so a fresh
   * `{ claimed: true }` is granted.
   */
  claim(
    key: string,
    options?: Options,
  ): Promise<{ claimed: true } | { claimed: false; transaction: Transaction }>;

  /**
   * Records the committed transaction for a key. Called inside the posting's transaction, so it only
   * takes effect if the posting actually commits.
   */
  record(
    key: string,
    transaction: Transaction,
    options?: Options,
  ): Promise<void>;
}

/**
 * Dedups raw inbound provider webhooks by the provider's event id, kept separate from the domain
 * {@link IdempotencyStore} key space. The webhook ingress claims the provider `eventId` here only
 * as its last check, after confirming the delivery's signature is authentic and recent enough, so
 * a rejected or forged delivery never burns the id and a later genuine redelivery still processes.
 * Backed by the `seen_webhooks` table (SQL) or an in-memory Map (memory adapter).
 */
export interface ReplayStore {
  /**
   * Atomically inserts `eventId` if it is absent. Returns `{ claimed: true }` the first time an id is
   * seen and `{ claimed: false }` on every later sighting, so a redelivered event is processed at
   * most once. Unlike `IdempotencyStore.claim`, this carries no transaction payload, because the
   * webhook handler only needs to know whether this is the first delivery.
   */
  claim(eventId: string, options?: Options): Promise<{ claimed: boolean }>;
}

/** Stores the summary of each completed sale, keyed by order id (a separate key from the idempotency key). */
export interface SaleStore {
  put(sale: Sale, options?: Options): Promise<void>;

  get(orderId: string, options?: Options): Promise<Sale | null>;
}

/**
 * A transactional outbox: events are saved in the same database transaction as the money move,
 * then a separate relay delivers them. An event is never sent for a rolled-back move, nor lost
 * for a committed one.
 */
export interface OutboxStore {
  /** Saves an event to send later. Called inside the posting's transaction. */
  enqueue(message: OutboxMessage, options?: Options): Promise<void>;

  /**
   * Grabs up to `limit` unsent messages for the relay. Each is locked so a concurrent relay skips it
   * and picks different ones. Only 'pending' rows are returned. A 'relayed' or dead-lettered
   * ('failed') row is terminal and never re-claimed, so a poison message can't wedge the queue.
   */
  claimBatch(
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<OutboxMessage>>;

  /**
   * Marks messages delivered. Delivery may still double-send, so the consumer drops duplicates by
   * message id.
   */
  markRelayed(ids: ReadonlyArray<string>, options?: Options): Promise<void>;

  /**
   * Records that delivering `id` failed. Bumps `attempts` by one and leaves the row 'pending' so the
   * next sweep retries it. A non-existent row (already relayed, dead-lettered, or never enqueued) is
   * left untouched. Mirrors the saga store's read-modify pattern. This must not flip the status;
   * only `deadLetter` does that.
   */
  recordFailure(id: string, options?: Options): Promise<void>;

  /**
   * Gives up on a poison message. Sets status to 'failed' so `claimBatch` never returns it again,
   * recording `reason` (the last failure's error code) for operators. Mirrors SagaStore.deadLetter.
   * A non-existent or already-terminal row is left untouched.
   */
  deadLetter(id: string, reason: string, options?: Options): Promise<void>;
}

/**
 * A transactional inbox: the inbound mirror of {@link OutboxStore}. A verified provider event,
 * already mapped to the {@link Operation} it should apply, is saved in the same database
 * transaction as the webhook ingress that claimed it, then a separate apply worker submits each
 * pending operation and marks the row applied. An inbound event is recorded before it is applied,
 * and a recorded event is eventually applied (or dead-lettered). The outbox is outbound: a
 * committed money move emits an event to deliver. The inbox is inbound: a received event drives a
 * money move to post.
 */
export interface InboxStore {
  /**
   * Saves a verified inbound event to apply later. Called inside the webhook handler's transaction.
   * Dedupes on `entry.key` (the provider's event id): a duplicate is a no-op that returns the
   * existing row rather than inserting a second, so a redelivered provider event is applied at most
   * once.
   */
  enqueueInbound(entry: InboxEntry, options?: Options): Promise<InboxEntry>;

  /**
   * Grabs up to `limit` pending rows for the apply worker, oldest `receivedAt` first. Each is locked
   * so a concurrent worker skips it and picks different ones. Only 'pending' rows are returned. An
   * 'applied' or dead-lettered ('dead') row is terminal and never re-claimed, so a poison event
   * can't wedge the queue. Mirrors OutboxStore.claimBatch and the saga and relay claims.
   */
  claimInbound(
    input: { now: number; limit: number },
    options?: Options,
  ): Promise<ReadonlyArray<InboxEntry>>;

  /**
   * Marks a row applied once its operation has been submitted and committed. Called inside the
   * apply's transaction, so it only takes effect if the money posting actually commits. A
   * rolled-back apply leaves the row 'pending' for the next sweep. A non-existent or
   * already-terminal row is left untouched.
   */
  markApplied(id: string, options?: Options): Promise<void>;

  /**
   * Records that applying `id` failed. Bumps `attempts` by one and leaves the row 'pending' so the
   * next sweep retries it. A non-existent row (already applied, dead-lettered, or never enqueued) is
   * left untouched. Mirrors OutboxStore.recordFailure. This must not flip the status; only
   * `deadLetter` does that.
   */
  bumpAttempt(id: string, options?: Options): Promise<void>;

  /**
   * Gives up on a poison event. Sets status to 'dead' so `claimInbound` never returns it again,
   * recording `reason` (the last failure's error code) for operators. Mirrors
   * OutboxStore.deadLetter. A non-existent or already-terminal row is left untouched.
   */
  deadLetter(id: string, reason: string, options?: Options): Promise<void>;
}

/**
 * Tracks each multi-step payout (a "saga") as it moves through its states. A background
 * sweep picks up sagas that are due and pushes each one to its next state.
 */
export interface SagaStore {
  open(saga: Saga, options?: Options): Promise<void>;

  load(id: string, options?: Options): Promise<Saga | null>;

  /**
   * Streams every saga regardless of state, newest `updatedAt` first, one at a time like
   * `Ledger.balanceAccounts`. Unlike `claimDue` (only due, in-progress sagas), this is the
   * whole board, including settled and failed payouts, for a UI to render. Ties on `updatedAt` come
   * back in an unspecified order that varies with each backend's collation, so a caller must not
   * depend on it.
   */
  list(options?: Options): AsyncIterable<Saga>;

  /**
   * Grabs up to `limit` sagas whose `dueAt` has passed, for the background sweep to advance. Each is
   * locked so concurrent sweeps take different sagas.
   */
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<Saga>>;

  /**
   * Moves a saga from `from` to `to` and applies `patch`, only if it is still in `from`. Returns
   * false and changes nothing if it already moved on, so two sweeps can't both advance it.
   */
  advance(
    id: string,
    from: SagaState,
    to: SagaState,
    patch: Partial<Saga>,
    options?: Options,
  ): Promise<boolean>;

  /** Gives up on a saga that can't make progress, recording why. */
  deadLetter(id: string, reason: string, options?: Options): Promise<void>;

  /**
   * Returns the time of `userId`'s most recent payout request, used to enforce
   * config.payoutMinIntervalMs between requests: the max `updatedAt` over all of the user's sagas in
   * any state. `updatedAt` is set to the request time at open() and only advances, so the max never
   * undershoots the latest request and lets no second request slip through the window.
   * Returns null when the user has no sagas, so a first request is always allowed.
   */
  lastPayoutAt(userId: string, options?: Options): Promise<number | null>;
}

/**
 * Tracks which users own which items or features (entitlements), keyed by SKU, the string
 * product code identifying the item or feature granted.
 */
export interface EntitlementStore {
  grant(
    userId: string,
    sku: string,
    attrs: EntitlementAttrs,
    options?: Options,
  ): Promise<void>;

  revoke(userId: string, sku: string, options?: Options): Promise<void>;

  owns(userId: string, sku: string, options?: Options): Promise<boolean>;
}

/** Tracks recurring subscriptions and when each is next due to bill. */
export interface SubscriptionStore {
  open(sub: Subscription, options?: Options): Promise<void>;

  load(id: string, options?: Options): Promise<Subscription | null>;

  /**
   * Returns the one ACTIVE subscription matching this (userId, sku, sellerId) triple, or null if
   * none exists. The subscribe handler uses this to refuse a second active subscription to the same
   * sku and seller, which would double-bill.
   */
  activeFor(
    userId: string,
    sku: string,
    sellerId: string,
    options?: Options,
  ): Promise<Subscription | null>;

  cancel(id: string, options?: Options): Promise<void>;

  /** Finds up to `limit` subscriptions whose next charge is due, for the renewal sweep. */
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<Subscription>>;

  /**
   * Records a successful renewal as a compare-and-set against the period the sweeper claimed:
   * set next_due_at=nextDueAt, period=period+1, attempts=0 WHERE id=id AND next_due_at=expectedDueAt.
   * Returns false and changes nothing when no row matched, which means another overlapping sweeper
   * already billed this period and moved next_due_at on. The loser treats that as a no-op and never
   * double-charges. Mirrors SagaStore.advance's compare-and-set guard.
   */
  markBilled(
    id: string,
    nextDueAt: number,
    expectedDueAt: number,
    options?: Options,
  ): Promise<boolean>;

  /**
   * Marks a subscription LAPSED because a renewal couldn't be paid, after the buyer ran out of
   * spendable funds. This is distinct from a user-requested cancel, but either way the renewal sweep
   * stops re-billing it.
   */
  markLapsed(id: string, options?: Options): Promise<void>;
}

/**
 * Tracks each marketing promo grant so the background worker can reverse whatever the user
 * hasn't spent once the grant expires. `grantPromo` records the grant here in the same
 * transaction as the credit posting (see {@link Unit}); the promo-expiry sweep later claims due
 * grants and reverses the unspent remainder against `SYSTEM.PROMO_FLOAT`.
 */
export interface PromoStore {
  /**
   * Records a new grant. Idempotent on `grant.id`: opening the same id twice is a no-op that never
   * overwrites or duplicates the first row (mirrors SagaStore.open's `on conflict (id) do nothing`).
   * Called inside the grant's transaction, so it only takes effect if that transaction commits.
   */
  open(grant: PromoGrant, options?: Options): Promise<void>;

  /**
   * Grabs up to `limit` grants that have expired (`expiresAt <= now`) and whose `reversed` flag is
   * still false, for the promo-expiry sweep to act on. Returns them oldest `expiresAt` first, so the
   * most overdue grants are reversed first. A grant already reversed is never handed back, so a
   * single grant is reversed at most once across sweeps.
   */
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<PromoGrant>>;

  /**
   * Marks a grant reversed so `claimDue` never returns it again. A row that doesn't exist or is
   * already reversed is a no-op (the same read-modify guard SagaStore.deadLetter and
   * OutboxStore.deadLetter use), so re-running the sweep over the same grant is harmless.
   */
  markReversed(id: string, options?: Options): Promise<void>;
}

/**
 * Tracks how much each subject has spent recently, the input to the risk gate. It comes in two
 * views: the store-level instance commits on its own connection, and the {@link Unit} view writes
 * inside the money transaction. `submit` combines them so every attempt ends up counted exactly
 * once, whether its operation commits or rolls back.
 */
export interface TrustStore {
  read(subject: string, options?: Options): Promise<Velocity>;

  /**
   * Records one spending attempt. Idempotent on `attempt.idempotencyKey`, so a genuine retry doesn't
   * double-count.
   */
  bump(subject: string, attempt: Attempt, options?: Options): Promise<void>;

  /**
   * Records the attempt (idempotent on `attempt.idempotencyKey`) and returns the subject's windowed
   * velocity including it, in one indivisible step, atomic and serialized per subject. This is what
   * the risk gate calls; see screenRisk in economy.ts for why record-and-measure must be one step
   * (the velocity-limit TOCTOU). A genuine retry of an already-recorded key still returns the
   * current total without counting twice.
   */
  record(
    subject: string,
    attempt: Attempt,
    options?: Options,
  ): Promise<Velocity>;
}

/** Stores signed ledger snapshots. Written only by the background worker. */
export interface CheckpointStore {
  put(checkpoint: Checkpoint, options?: Options): Promise<void>;

  /** The most recent checkpoint, or null if none exists yet. */
  latest(options?: Options): Promise<Checkpoint | null>;
}

// --- Record types -----------------------------------------------------------------
// The data shapes the stores above pass around. Each is a plain JSON-friendly object owned by the
// module that produces it. The versions here pin the shape the tests rely on. An owner may add
// fields, but must not change one of the methods declared above.

/**
 * The fixed shape of every event the system emits. An `audience: 'client'` event is pushed out
 * to connected clients over the WebSocket.
 */
export interface EconomyEvent {
  /** Unique event id, of the form evt_<uuid>. */
  id: string;

  /** The event name, e.g. 'economy.sale.completed'. */
  type: string;

  /** Schema version of this event's shape, currently 1. */
  version: number;

  /** When the event happened, in epoch milliseconds. */
  occurredAt: number;

  /** What the event is about: a user id (usr_…) or transaction id (txn_…). */
  subject: string;

  /** The event's payload. */
  data: Record<string, unknown>;

  /** Whether the event is for internal consumers or to be pushed to clients. */
  audience: 'internal' | 'client';
}

/** One stored outbox row: an event plus the bookkeeping for delivering it (see OutboxStore). */
export interface OutboxMessage {
  /** Unique row id, of the form obx_<uuid>. */
  id: string;

  event: EconomyEvent;

  /**
   * Where the event is in its delivery lifecycle:
   * - 'pending': still needs sending; the only status `claimBatch` ever hands back.
   * - 'relayed': delivered (set by `markRelayed`); never re-claimed.
   * - 'failed':  dead-lettered after too many attempts (set by `deadLetter`); a terminal, poison
   *   state that `claimBatch` must skip so it can't wedge the queue.
   */
  status: 'pending' | 'relayed' | 'failed';

  /**
   * How many delivery attempts have been made. Incremented by `recordFailure` each time a dispatch
   * throws; once it reaches the configured cap the relay dead-letters the row.
   */
  attempts: number;

  /**
   * Why the relay gave up on this message, set when it reaches the terminal 'failed' status; null
   * otherwise. Mirrors Saga.reason.
   */
  reason: string | null;
}

/** One stored inbox row: a verified inbound event mapped to the operation it applies (see InboxStore). */
export interface InboxEntry {
  /** Unique row id, of the form ibx_<uuid>. */
  id: string;

  /**
   * The provider's event id. Doubles as the dedupe key on enqueue (a duplicate provider event is a
   * no-op that returns the existing row) and as the submitted operation's idempotencyKey, so a
   * redelivered event resolves to the same money move at most once.
   */
  key: string;

  /**
   * The operation to submit when this row is applied (e.g. a topUp or clawback), already mapped
   * from the verified provider event.
   */
  operation: Operation;

  /**
   * Where the event is in its apply lifecycle:
   * - 'pending': still needs applying; the only status `claimInbound` ever hands back.
   * - 'applied': submitted and committed (set by `markApplied`); never re-claimed.
   * - 'dead':    dead-lettered after too many attempts (set by `deadLetter`); a terminal, poison
   *   state that `claimInbound` must skip so it can't wedge the queue.
   */
  status: 'pending' | 'applied' | 'dead';

  /**
   * How many apply attempts have been made. Incremented by `bumpAttempt` each time an apply
   * throws; once it reaches the configured cap the worker dead-letters the row.
   */
  attempts: number;

  /**
   * When the verified event was received and enqueued, in epoch milliseconds. `claimInbound`
   * returns pending rows oldest `receivedAt` first.
   */
  receivedAt: number;

  /**
   * Why the worker gave up on this row, set when it reaches the terminal 'dead' status; null
   * otherwise. Mirrors Saga.reason.
   */
  reason: string | null;
}

/**
 * A summary of a completed sale. Sales split across several recipients, so this records the exact
 * lines that posted; keeping them lets a later refund reverse the sale precisely.
 */
export interface Sale {
  orderId: string;
  buyerId: string;
  sku: string;

  /**
   * Who received the purchased SKU's entitlement. For an ordinary purchase this is the buyer; for
   * a gift it's the recipient (`giftTo`) the buyer bought it for. A refund revokes ownership from
   * this user, so a refunded gift takes the item back from the recipient, not the buyer. Optional
   * for backward compatibility with sales recorded before gifting existed; a missing value means
   * the buyer received it.
   */
  recipientId?: string;

  /** What the buyer paid. */
  price: Amount;

  /** The platform's cut of the price. */
  fee: Amount;

  /** The exact debit/credit lines that posted for this sale. */
  legs: ReadonlyArray<Leg>;

  txnId: string;
  postedAt: number;
}

/**
 * The states a payout saga moves through, from request to settled (or failed). A plain readonly
 * array of strings rather than a TypeScript enum.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/lifecycles/ Lifecycles} for the
 * payout saga and subscription state machines.
 */
export const SAGA_STATES = [
  'REQUESTED',
  'RESERVED',
  'SUBMITTED',
  'SETTLED',
  'FAILED',
] as const;
export type SagaState = (typeof SAGA_STATES)[number];

/** The stored state of one in-flight payout. */
export interface Saga {
  /** Unique saga id, of the form pay_<uuid>. */
  id: string;

  userId: string;

  /**
   * The seller's earned credits set aside for this payout (moved into the
   * payout-reserve account while it's in flight).
   */
  reserve: Amount;

  /** Names the exact CREDIT-to-USD rate this payout is locked to. */
  rateId: string;

  state: SagaState;

  /** The payment provider's reference once submitted, null before then. */
  providerRef: string | null;

  /**
   * Why the worker gave up on this payout, set when it reaches FAILED; null otherwise. Stored on
   * the saga so a reader takes it straight off the record instead of re-deriving it from posting
   * meta.
   */
  reason: string | null;

  /** How many times the worker has tried to advance this saga. */
  attempts: number;

  /** When the worker should next act on it, in epoch milliseconds. */
  dueAt: number;

  updatedAt: number;

  /**
   * The gross USD disbursed, set when settlePayout marks this payout SETTLED; null otherwise. Stored
   * on the saga so a reader takes it straight off the record instead of re-deriving it from posting
   * meta.
   */
  payoutUsd: Amount | null;
}

/** The states a subscription can be in. */
export const SUBSCRIPTION_STATES = ['ACTIVE', 'LAPSED', 'CANCELED'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/** The stored state of one recurring subscription. */
export interface Subscription {
  /** Unique subscription id, of the form sub_<uuid>. */
  id: string;

  userId: string;
  sellerId: string;
  sku: string;

  /** What each renewal charges. */
  price: Amount;

  /** How long one billing period lasts, in milliseconds. */
  periodMs: number;

  state: SubscriptionState;

  /** Which billing period number it's on (increments each renewal). */
  period: number;

  /**
   * Consecutive retryable (temporary) failures to bill this subscription. Starts at 0 at open.
   * The sweep bumps it on a retryable failure and resets to 0 on a successful renewal; once it
   * reaches the configured cap (config.maxSubscriptionAttempts) the sweep stops retrying and
   * lapses the subscription instead of re-billing it forever. Adapters must round-trip this field
   * through save/load (open/markBilled/markLapsed and every load path).
   */
  attempts: number;

  /** When the next renewal is due, in epoch milliseconds. */
  nextDueAt: number;

  updatedAt: number;
}

/**
 * One stored marketing promo grant the worker can later reverse. Recorded by `grantPromo`
 * alongside the credit posting; the promo-expiry sweep reverses the unspent remainder once
 * `expiresAt` has passed, then sets `reversed` so it's never reversed twice.
 */
export interface PromoGrant {
  /**
   * Unique grant id. Reuses the transaction prefix (txn_<uuid>) of the grant's own posting,
   * so a grant and the entry that created it share one id and `open` is idempotent on it.
   */
  id: string;

  userId: string;

  /**
   * The credits granted, in CREDIT. The full grant; the sweep reverses only as much of this as
   * the user hasn't already spent (re-read per grant against the live promo balance).
   */
  amount: Amount;

  /** When the grant expires, in epoch milliseconds. The sweep claims it once this is reached. */
  expiresAt: number;

  /**
   * Whether the worker has already reversed this grant. Starts false at `open`; set true by
   * `markReversed` after the unspent remainder is reversed, so `claimDue` skips it thereafter.
   */
  reversed: boolean;
}

/** A subject's recent spending, accumulated over one time window for the risk gate to check. */
export interface Velocity {
  subject: string;

  /** When the current window began, in epoch milliseconds. */
  windowStart: number;

  /** Total spent so far in this window. */
  spent: Amount;

  /** How many attempts happened in this window. */
  attempts: number;
}

/** One recorded spending attempt. Idempotent on its key, so a genuine retry never double-counts. */
export interface Attempt {
  idempotencyKey: string;
  amount: Amount;

  /** When the attempt happened, in epoch milliseconds. */
  at: number;

  /** Whether the attempt went through or was turned down. */
  outcome: 'committed' | 'rejected';
}

/**
 * A signed snapshot of the whole ledger at one moment. Reduces every account's head hash to a
 * single Merkle root (one hash that changes if any account's chain changes) and signs that, so
 * the snapshot covers every account at once. Meant to be anchored outside this system for
 * independent proof.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 * hash chain and signed-checkpoint construction.
 */
export interface Checkpoint {
  /** Unique checkpoint id, of the form chk_<uuid>. */
  id: string;

  /** The Merkle root over all account heads, as lowercase hex. */
  root: string;

  /** The signature over `root`, as lowercase hex. */
  signature: string;

  /** How many account heads the root covers. */
  count: number;

  /** When the snapshot was taken, in epoch milliseconds. */
  at: number;
}

/**
 * A time range for a statement query, in epoch milliseconds. Half-open: `from` is
 * included, `to` is not.
 */
export interface Range {
  from: number;
  to: number;
}

/** One page of an account's entries. Pages are walked via the cursor. */
export interface Statement {
  account: AccountRef;

  /** The entries on this page: which transaction, the amount applied, and when it posted. */
  entries: ReadonlyArray<{ txnId: string; amount: Amount; postedAt: number }>;

  /** The token to fetch the next page, or null when this is the last page. */
  cursor: string | null;
}

/**
 * One settlement lot for a top-up: an amount that becomes mature (eligible to be paid
 * out) at `maturesAt`. The maturity calculation consumes these oldest-first (FIFO).
 */
export interface Lot {
  txnId: string;
  amount: Amount;

  /** Where the funds came from. */
  source: string;

  /** When the lot was topped up, in epoch milliseconds. */
  toppedUpAt: number;

  /** When the lot matures, in epoch milliseconds. */
  maturesAt: number;
}
