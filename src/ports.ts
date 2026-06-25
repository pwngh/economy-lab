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
} from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Config } from '#src/config.ts';

/** Per-call options. Pass a `signal` to let the caller cancel the operation in flight. */
export type Options = { signal?: AbortSignal };

/**
 * Allowed id prefixes. Every minted id is `<prefix>_<uuid>` (e.g. `txn_…`, `usr_…`).
 */
export type IdPrefix =
  | 'usr'
  | 'txn'
  | 'evt'
  | 'obx'
  | 'pay'
  | 'sub'
  | 'chk'
  | 'ent'
  | 'rec'
  | 'adj';

/** Reads the current wall-clock time. */
export interface Clock {
  // Milliseconds since the Unix epoch (midnight UTC, 1 Jan 1970).
  now(): number;
}

/** Mints fresh unique ids. */
export interface Ids {
  // Returns a new id of the form `${prefix}_${uuidv4}`.
  next(prefix: IdPrefix): string;
}

/** Hashes raw bytes. */
export interface Digest {
  // Returns the SHA-256 hash of the input, computed via the platform's crypto.subtle.
  hash(bytes: Uint8Array): Promise<Uint8Array>;
}

/** Signs bytes and checks signatures, used to vouch for ledger checkpoints. */
export interface Signer {
  sign(bytes: Uint8Array): Promise<Uint8Array>;

  // True if the signature is authentic. Accepts the current key plus still-valid older keys,
  // so a signature made before a key rotation keeps verifying.
  verify(bytes: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/**
 * Optional read-through key/value cache for hot reads (balances). Best-effort: when none is injected
 * the read path skips it and goes straight to the ledger, and a cache error degrades to a direct
 * ledger read rather than failing the request — so a cache only ever speeds reads, never breaks them.
 * `memoryCache` is the in-process reference; `redisCacheFrom` is the Redis adapter.
 */
export interface Cache {
  get(key: string): Promise<string | null>;

  // Store a value, optionally expiring it after `ttlMs` milliseconds.
  set(key: string, value: string, ttlMs?: number): Promise<void>;

  invalidate(key: string): Promise<void>;
}

/** Runs a task repeatedly on a fixed interval (used by the background worker). */
export interface Scheduler {
  // Run `task` every `ms` milliseconds; returns a function that stops it. Loop is owned here
  // rather than via raw setInterval, so start and stop share one code path.
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
 * External payment provider that pays sellers (e.g. Tilia, Steam, Meta). All money leaving
 * the platform goes through this.
 */
export interface Processor {
  // Pay a user. `amount` is in real USD. `key` makes the request safe to retry without paying
  // twice. Returns the provider's reference for the payout.
  submitPayout(
    input: { key: string; userId: string; amount: Amount },
    options?: Options,
  ): Promise<{ providerRef: string }>;

  // No "did it settle?" call: the provider reports settlement and disputes via inbound
  // webhooks, which the worker reconciles.
}

/** Supplies exchange rates from an audited source, never from config or caller input. */
export interface Rates {
  // Rate to convert one currency to another at a point in time, mainly CREDIT to USD on payout.
  payout(
    from: Currency,
    to: Currency,
    at: number,
    options?: Options,
  ): Promise<Rate>;

  // Fixed CREDIT-to-USD rate (never market-driven), unlike `payout`. Used by the reconciliation
  // check that the platform holds enough real USD to cover every user's spendable credits,
  // valuing those credits in USD at this rate.
  par(currency: Currency): Rate;

  // Fixed CREDIT-to-USD rate a user pays when buying credits (≈120 credits/USD at VRChat, less
  // favourable than `par`/`payout`). `topUp` values the buyer's cash at this rate; the gap
  // between it and `par` (the credit's backing/cash-out value) is the platform's purchase-spread
  // revenue, VRChat's documented ~40% "purchase fee". Never market-driven.
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

/** The append-only double-entry ledger: records money movements, reads back balances and history. */
export interface Ledger {
  hasAccount(account: AccountRef, options?: Options): Promise<boolean>;

  // Take a row lock on an account so concurrent operations can't race on its balance.
  lock(account: AccountRef, options?: Options): Promise<void>;

  // Record one posting (a balanced set of debit/credit lines) and return the committed
  // transaction.
  append(posting: Posting, options?: Options): Promise<Transaction>;

  // The account's current balance. A maintained running total, so this is a single read
  // rather than a sum over its whole history.
  balance(account: AccountRef, options?: Options): Promise<Amount>;

  // A page of the account's entries within a time range (see Statement).
  statement(
    account: AccountRef,
    range: Range,
    options?: Options,
  ): Promise<Statement>;

  // The account's settlement lots, each a chunk of funds from a single top-up with the date
  // it becomes eligible to be paid out (see {@link Lot}). Streamed one at a time so a long
  // history doesn't have to fit in memory.
  timeline(account: AccountRef): AsyncIterable<Lot>;

  // Every account paired with its current chain-head hash (the latest hash in that
  // account's tamper-evident chain).
  heads(): AsyncIterable<readonly [AccountRef, string]>;

  // Every account with a cached running-balance row, streamed one at a time (SQL:
  // `account_balances`; memory: keys of `state.balances`). Entries are the source of truth, so a
  // cached row can exist with no posting behind it — `heads` never visits those, so the prover
  // relies on this list to surface them as a mismatch.
  balanceAccounts(options?: Options): AsyncIterable<AccountRef>;

  // Every posting that touched `account`, in commit order, with each recorded hash. The integrity
  // prover replays these to recompute the account's head hash and confirm nothing was altered.
  // Head hashes alone only show the chain is well-formed; the full postings catch an edited line.
  lineage(account: AccountRef, options?: Options): AsyncIterable<StoredLink>;

  // The whole posting that committed under `txnId`, or null if no such id. A reversal loads this
  // and negates its lines to post the exact opposite; null on an unknown id lets the
  // operator-reversal handler fail loudly. Unlike `lineage`, not scoped to one account: returns
  // the one transaction with all its lines.
  posting(txnId: string, options?: Options): Promise<Posting | null>;
}

/**
 * The full set of stores the system reads and writes. `transaction` runs a block of work
 * with all of these committing atomically (all or nothing).
 */
export interface Store {
  ledger: Ledger;
  idempotency: IdempotencyStore;
  sales: SaleStore;
  outbox: OutboxStore;
  sagas: SagaStore;
  entitlements: EntitlementStore;
  subscriptions: SubscriptionStore;
  promos: PromoStore;
  trust: TrustStore;
  checkpoints: CheckpointStore;
  replay: ReplayStore;

  // Run `work` inside one database transaction, passing it the subset of stores that
  // participate in that transaction; everything it writes commits together or not at all.
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
 * into that account's tamper-evident chain. Each head hash is computed from the previous head
 * plus this posting's contents, so changing any contents changes the hash. The prover re-hashes
 * (previous head + the account's legs + meta) and checks it equals the stored `hash`; an
 * after-the-fact edit won't match.
 */
export type StoredLink = {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;

  // The account's head hash before this posting (a fixed all-zeros "genesis" hex for the
  // account's first posting).
  prevHash: string;

  // The account's head hash after this posting, recorded when it was appended; what the prover's
  // recompute must reproduce.
  hash: string;
};

/**
 * The stores a single operation's handler may write to, all inside one database transaction so
 * its writes commit together.
 *
 * Deliberately absent: `trust` (the risk-velocity write happens outside the transaction, via
 * `Store.trust`), `checkpoints` (written only by the background worker), and a separate balance
 * reader (the funds pre-check reads via `ledger.balance`). `promos` is included so `grantPromo`
 * records the grant in the same transaction as the money posting; a rolled-back grant leaves no
 * promo-expiry row.
 */
export interface Unit {
  ledger: Ledger;
  idempotency: IdempotencyStore;
  sales: SaleStore;
  outbox: OutboxStore;
  sagas: SagaStore;
  entitlements: EntitlementStore;
  subscriptions: SubscriptionStore;
  promos: PromoStore;
}

/** Makes a repeated request run at most once, keyed by the caller's idempotency key. */
export interface IdempotencyStore {
  // Stake a claim on a key. The first caller gets `{ claimed: true }` and may proceed. If another
  // caller is still mid-flight on the same key, this waits for them: if they committed, returns
  // `{ claimed: false }` with their recorded transaction (so the duplicate returns the same
  // result); if they rolled back, the key was never recorded and a fresh `{ claimed: true }` is
  // granted.
  claim(
    key: string,
    options?: Options,
  ): Promise<{ claimed: true } | { claimed: false; transaction: Transaction }>;

  // Record the committed transaction for a key. Called inside the posting's transaction,
  // so it only takes effect if the posting actually commits.
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
  // Atomic insert-if-absent on `eventId`: returns `{ claimed: true }` the first time an id is seen
  // and `{ claimed: false }` on every later sighting, so a redelivered event is processed at most
  // once. Unlike `IdempotencyStore.claim` this carries no transaction payload; the webhook handler
  // only needs to know whether this is the first delivery.
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
  // Save an event to send later. Called inside the posting's transaction.
  enqueue(message: OutboxMessage, options?: Options): Promise<void>;

  // Grab up to `limit` unsent messages for the relay. Each is locked so a concurrent relay skips
  // it and picks different ones. Only 'pending' rows are returned; a 'relayed' or 'failed'
  // (dead-lettered) row is terminal and never re-claimed, so a poison message can't wedge the
  // queue.
  claimBatch(
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<OutboxMessage>>;

  // Mark messages delivered. Delivery may still double-send, so the consumer drops duplicates
  // by message id.
  markRelayed(ids: ReadonlyArray<string>, options?: Options): Promise<void>;

  // Record that delivering `id` failed: bump `attempts` by one and leave it 'pending' so the next
  // sweep retries it. A non-existent row (already relayed, dead-lettered, or never enqueued) is
  // left untouched. Mirrors the saga store's read-modify pattern; must not flip the status, only
  // `deadLetter` does that.
  recordFailure(id: string, options?: Options): Promise<void>;

  // Give up on a poison message: set status to 'failed' so `claimBatch` never returns it
  // again, recording `reason` (the last failure's error code) for operators. Mirrors
  // SagaStore.deadLetter. A non-existent or already-terminal row is left untouched.
  deadLetter(id: string, reason: string, options?: Options): Promise<void>;
}

/**
 * Tracks each multi-step payout (a "saga") as it moves through its states. A background
 * sweep picks up sagas that are due and pushes each one to its next state.
 */
export interface SagaStore {
  open(saga: Saga, options?: Options): Promise<void>;

  load(id: string, options?: Options): Promise<Saga | null>;

  // Every saga regardless of state, newest `updatedAt` first, streamed one at a time like
  // `LedgerStore.balanceAccounts`. Unlike `claimDue` (only due, in-progress sagas), this is the
  // whole board — settled and failed payouts included — for a UI to render. Ties on `updatedAt`
  // come back in an unspecified order (it varies with each backend's collation), so a caller must
  // not depend on it.
  list(options?: Options): AsyncIterable<Saga>;

  // Grab up to `limit` sagas whose `dueAt` has passed, for the background sweep to advance.
  // Each is locked so concurrent sweeps take different sagas.
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<Saga>>;

  // Move a saga from `from` to `to` and apply `patch`, only if it's still in `from`. Returns
  // false (changing nothing) if it already moved on, so two sweeps can't both advance it.
  advance(
    id: string,
    from: SagaState,
    to: SagaState,
    patch: Partial<Saga>,
    options?: Options,
  ): Promise<boolean>;

  // Give up on a saga that can't make progress, recording why.
  deadLetter(id: string, reason: string, options?: Options): Promise<void>;

  // Time of `userId`'s most recent payout request, used to enforce config.payoutMinIntervalMs
  // between requests. Returns the max `updatedAt` over all of this user's sagas in any state:
  // `updatedAt` is set to the request time at open() and only advances, so the max is always >=
  // the latest request and never lets a second request slip through the window. Null when the
  // user has no sagas (first request always allowed).
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

  // The one ACTIVE subscription matching this (userId, sku, sellerId) triple, or null if none.
  // The subscribe handler uses this to refuse a second active subscription to the same sku/seller,
  // which would double-bill.
  activeFor(
    userId: string,
    sku: string,
    sellerId: string,
    options?: Options,
  ): Promise<Subscription | null>;

  cancel(id: string, options?: Options): Promise<void>;

  // Find up to `limit` subscriptions whose next charge is due, for the renewal sweep.
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<Subscription>>;

  // Record a successful renewal, as a compare-and-set against the period the sweeper claimed:
  // set next_due_at=nextDueAt, period=period+1, attempts=0 WHERE id=id AND next_due_at=expectedDueAt.
  // Returns false (changing nothing) when no row matched, i.e. another overlapping sweeper already
  // billed this period and moved next_due_at on, so the loser treats it as a no-op and never
  // double-charges. Mirrors SagaStore.advance's CAS guard.
  markBilled(
    id: string,
    nextDueAt: number,
    expectedDueAt: number,
    options?: Options,
  ): Promise<boolean>;

  // Mark a subscription LAPSED because a renewal couldn't be paid (buyer ran out of spendable
  // funds). Distinct from a user-requested cancel; either way the renewal sweep stops re-billing
  // it.
  markLapsed(id: string, options?: Options): Promise<void>;
}

/**
 * Tracks each marketing promo grant so the background worker can reverse whatever the user
 * hasn't spent once the grant expires. `grantPromo` records the grant here in the same
 * transaction as the credit posting (see {@link Unit}); the promo-expiry sweep later claims due
 * grants and reverses the unspent remainder against `SYSTEM.PROMO_FLOAT`.
 */
export interface PromoStore {
  // Record a new grant. Idempotent on `grant.id`: opening the same id twice is a no-op and never
  // overwrites or duplicates the first row (mirrors SagaStore.open's `on conflict (id) do
  // nothing`). Called inside the grant's transaction, so it only takes effect if that transaction
  // commits.
  open(grant: PromoGrant, options?: Options): Promise<void>;

  // Grab up to `limit` grants that have expired (`expiresAt <= now`) and whose `reversed` flag is
  // still false, for the promo-expiry sweep to act on. Returned oldest `expiresAt` first, so the
  // most overdue grants are reversed first. A grant already reversed is never handed back, so a
  // single grant is reversed at most once across sweeps.
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<PromoGrant>>;

  // Mark a grant reversed so `claimDue` never returns it again. No-op on a row that doesn't exist
  // or is already reversed (the same read-modify guard SagaStore.deadLetter and
  // OutboxStore.deadLetter use), so re-running the sweep over the same grant is harmless.
  markReversed(id: string, options?: Options): Promise<void>;
}

/**
 * Tracks how much each subject has spent recently, the input to the risk gate. Written outside
 * the money transaction, so even a denied attempt still counts toward the limit.
 */
export interface TrustStore {
  read(subject: string, options?: Options): Promise<Velocity>;

  // Record one spending attempt. Idempotent on `attempt.idempotencyKey`, so a genuine
  // retry doesn't double-count.
  bump(subject: string, attempt: Attempt, options?: Options): Promise<void>;

  // Atomically record the attempt (idempotent on `attempt.idempotencyKey`) and return the
  // subject's windowed velocity including it, in one indivisible step. What the risk gate calls:
  // the record-and-measure must be atomic and serialized per subject, so two concurrent attempts
  // for the same subject can't both read a stale pre-bump total and both slip past the limit (the
  // velocity-limit TOCTOU that `read`-then-`bump` left open). A genuine retry of an
  // already-recorded key still returns the current total without counting twice.
  record(
    subject: string,
    attempt: Attempt,
    options?: Options,
  ): Promise<Velocity>;
}

/** Stores signed ledger snapshots. Written only by the background worker. */
export interface CheckpointStore {
  put(checkpoint: Checkpoint, options?: Options): Promise<void>;

  // The most recent checkpoint, or null if none exists yet.
  latest(options?: Options): Promise<Checkpoint | null>;
}

// --- Record types -----------------------------------------------------------------
// The data shapes the stores above pass around. Each is a plain JSON-friendly object owned by the
// module that produces it; the versions here pin the shape the tests rely on. An owner may add
// fields, but must not change one of the methods declared above.

/**
 * The fixed shape of every event the system emits. An `audience: 'client'` event is pushed out
 * to connected clients over the WebSocket.
 */
export interface EconomyEvent {
  // Unique event id, of the form evt_<uuid>.
  id: string;

  // The event name, e.g. 'economy.sale.completed'.
  type: string;

  // Schema version of this event's shape, currently 1.
  version: number;

  // When the event happened, in epoch milliseconds.
  occurredAt: number;

  // What the event is about: a user id (usr_…) or transaction id (txn_…).
  subject: string;

  // The event's payload.
  data: Record<string, unknown>;

  // Whether the event is for internal consumers or to be pushed to clients.
  audience: 'internal' | 'client';
}

/** One stored outbox row: an event plus the bookkeeping for delivering it (see OutboxStore). */
export interface OutboxMessage {
  // Unique row id, of the form obx_<uuid>.
  id: string;

  event: EconomyEvent;

  // Where the event is in its delivery lifecycle:
  // - 'pending': still needs sending; the only status `claimBatch` ever hands back.
  // - 'relayed': delivered (set by `markRelayed`); never re-claimed.
  // - 'failed':  dead-lettered after too many attempts (set by `deadLetter`); a terminal, poison
  //   state that `claimBatch` must skip so it can't wedge the queue.
  status: 'pending' | 'relayed' | 'failed';

  // How many delivery attempts have been made. Incremented by `recordFailure` each time a dispatch
  // throws; once it reaches the configured cap the relay dead-letters the row.
  attempts: number;
}

/**
 * A summary of a completed sale. Sales split across several recipients, so this records the exact
 * lines that posted; keeping them lets a later refund reverse the sale precisely.
 */
export interface Sale {
  orderId: string;
  buyerId: string;
  sku: string;

  // Who received the purchased SKU's entitlement. For an ordinary purchase this is the buyer; for
  // a gift it's the recipient (`giftTo`) the buyer bought it for. A refund revokes ownership from
  // this user, so a refunded gift takes the item back from the recipient, not the buyer. Optional
  // for backward compatibility with sales recorded before gifting existed; a missing value means
  // the buyer received it.
  recipientId?: string;

  // What the buyer paid.
  price: Amount;

  // The platform's cut of the price.
  fee: Amount;

  // The exact debit/credit lines that posted for this sale.
  legs: ReadonlyArray<Leg>;

  txnId: string;
  postedAt: number;
}

/**
 * The states a payout saga moves through, from request to settled (or failed). A plain readonly
 * array of strings rather than a TypeScript enum.
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
  // Unique saga id, of the form pay_<uuid>.
  id: string;

  userId: string;

  // The seller's earned credits set aside for this payout (moved into the
  // payout-reserve account while it's in flight).
  reserve: Amount;

  // Names the exact CREDIT-to-USD rate this payout is locked to.
  rateId: string;

  state: SagaState;

  // The payment provider's reference once submitted, null before then.
  providerRef: string | null;

  // How many times the worker has tried to advance this saga.
  attempts: number;

  // When the worker should next act on it, in epoch milliseconds.
  dueAt: number;

  updatedAt: number;
}

/** The states a subscription can be in. */
export const SUBSCRIPTION_STATES = ['ACTIVE', 'LAPSED', 'CANCELED'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/** The stored state of one recurring subscription. */
export interface Subscription {
  // Unique subscription id, of the form sub_<uuid>.
  id: string;

  userId: string;
  sellerId: string;
  sku: string;

  // What each renewal charges.
  price: Amount;

  // How long one billing period lasts, in milliseconds.
  periodMs: number;

  state: SubscriptionState;

  // Which billing period number it's on (increments each renewal).
  period: number;

  // Consecutive retryable (temporary) failures to bill this subscription. Starts at 0 at open.
  // The sweep bumps it on a retryable failure and resets to 0 on a successful renewal; once it
  // reaches the configured cap (config.maxSubscriptionAttempts) the sweep stops retrying and
  // lapses the subscription instead of re-billing it forever. Adapters must round-trip this field
  // through save/load (open/markBilled/markLapsed and every load path).
  attempts: number;

  // When the next renewal is due, in epoch milliseconds.
  nextDueAt: number;

  updatedAt: number;
}

/**
 * One stored marketing promo grant the worker can later reverse. Recorded by `grantPromo`
 * alongside the credit posting; the promo-expiry sweep reverses the unspent remainder once
 * `expiresAt` has passed, then sets `reversed` so it's never reversed twice.
 */
export interface PromoGrant {
  // Unique grant id. Reuses the transaction prefix (txn_<uuid>) of the grant's own posting,
  // so a grant and the entry that created it share one id and `open` is idempotent on it.
  id: string;

  userId: string;

  // The credits granted, in CREDIT. The full grant; the sweep reverses only as much of this as
  // the user hasn't already spent (re-read per grant against the live promo balance).
  amount: Amount;

  // When the grant expires, in epoch milliseconds. The sweep claims it once this is reached.
  expiresAt: number;

  // Whether the worker has already reversed this grant. Starts false at `open`; set true by
  // `markReversed` after the unspent remainder is reversed, so `claimDue` skips it thereafter.
  reversed: boolean;
}

/** A subject's recent spending, accumulated over one time window for the risk gate to check. */
export interface Velocity {
  subject: string;

  // When the current window began, in epoch milliseconds.
  windowStart: number;

  // Total spent so far in this window.
  spent: Amount;

  // How many attempts happened in this window.
  attempts: number;
}

/** One recorded spending attempt. Idempotent on its key, so a genuine retry never double-counts. */
export interface Attempt {
  idempotencyKey: string;
  amount: Amount;

  // When the attempt happened, in epoch milliseconds.
  at: number;

  // Whether the attempt went through or was turned down.
  outcome: 'committed' | 'rejected';
}

/**
 * A signed snapshot of the whole ledger at one moment. Reduces every account's head hash to a
 * single Merkle root (one hash that changes if any account's chain changes) and signs that, so
 * the snapshot covers every account at once. Meant to be anchored outside this system for
 * independent proof.
 */
export interface Checkpoint {
  // Unique checkpoint id, of the form chk_<uuid>.
  id: string;

  // The Merkle root over all account heads, as lowercase hex.
  root: string;

  // The signature over `root`, as lowercase hex.
  signature: string;

  // How many account heads the root covers.
  count: number;

  // When the snapshot was taken, in epoch milliseconds.
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

  // The entries on this page: which transaction, the amount applied, and when it posted.
  entries: ReadonlyArray<{ txnId: string; amount: Amount; postedAt: number }>;

  // The token to fetch the next page, or null when this is the last page.
  cursor: string | null;
}

/**
 * One settlement lot for a top-up: an amount that becomes mature (eligible to be paid
 * out) at `maturesAt`. The maturity calculation consumes these oldest-first (FIFO).
 */
export interface Lot {
  txnId: string;
  amount: Amount;

  // Where the funds came from.
  source: string;

  // When the lot was topped up, in epoch milliseconds.
  toppedUpAt: number;

  // When the lot matures, in epoch milliseconds.
  maturesAt: number;
}
