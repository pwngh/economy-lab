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
 * The short tags that begin a generated id. Every id this system mints looks like
 * `<prefix>_<uuid>` (for example `txn_…` for a transaction, `usr_…` for a user),
 * and this union is the full list of allowed prefixes.
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

  // Returns true if the signature is authentic. Accepts the current key plus any
  // still-valid older keys, so a signature made before a key rotation keeps verifying.
  verify(bytes: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/**
 * An optional key/value cache. The system runs fine without one: when no cache is
 * injected it falls back to a default that does nothing (every get misses).
 */
export interface Cache {
  get(key: string): Promise<string | null>;

  // Store a value, optionally expiring it after `ttlMs` milliseconds.
  set(key: string, value: string, ttlMs?: number): Promise<void>;

  invalidate(key: string): Promise<void>;
}

/** Runs a task repeatedly on a fixed interval (used by the background worker). */
export interface Scheduler {
  // Run `task` every `ms` milliseconds and return a function that stops it. The system
  // owns the loop rather than using raw setInterval timers, so stopping it is handled
  // in the same code path as starting it.
  every(ms: number, task: () => Promise<void>, options?: Options): () => void;
}

/**
 * Hands an outgoing event off to be delivered. The concrete adapter behind this sends
 * the event onward (for example to an SQS queue or over HTTP); the core does not know
 * or care which.
 */
export type Dispatcher = (
  event: EconomyEvent,
  options?: Options,
) => Promise<void>;

/**
 * The outside payment provider that actually pays sellers (such as Tilia, Steam, or
 * Meta). Money leaving the platform goes through this.
 */
export interface Processor {
  // Ask the provider to pay a user. The `amount` is in real USD. `key` makes the
  // request safe to retry without paying twice. Returns the provider's own reference
  // for the payout.
  submitPayout(
    input: { key: string; userId: string; amount: Amount },
    options?: Options,
  ): Promise<{ providerRef: string }>;

  // There is no "did it settle?" call here on purpose: the provider reports settlement
  // and disputes by calling back in (inbound webhooks), which the worker reconciles.
}

/** Supplies exchange rates. These come from an audited source — never from config or caller input. */
export interface Rates {
  // The rate to convert one currency to another at a point in time, mainly CREDIT to
  // USD when paying a seller out.
  payout(
    from: Currency,
    to: Currency,
    at: number,
    options?: Options,
  ): Promise<Rate>;

  // The fixed CREDIT-to-USD conversion rate. Used by the reconciliation check that confirms
  // the platform holds enough real USD to cover every user's spendable credits: it values
  // those credits in USD at this rate. Fixed (never market-driven), unlike `payout` above.
  par(currency: Currency): Rate;

  // The fixed CREDIT-to-USD rate a user pays when BUYING credits (≈120 credits/USD at VRChat —
  // a less favourable rate than `par`/`payout`). `topUp` values the cash a buyer pays at this
  // rate; the gap between it and `par` (the credit's backing/cash-out value) is the platform's
  // purchase-spread revenue — VRChat's documented ~40% "purchase fee". Fixed, never market-driven.
  buy(currency: Currency): Rate;
}

/**
 * An exchange rate, stored as exact integers so there's no floating-point drift. The
 * real multiplier is `rate / 10^scale` (e.g. rate 50, scale 2 means 0.50 USD per
 * credit). `rateId` names this exact rate so a transaction can record which one it used.
 *
 * To convert: usd_minor = floor(credit_minor × rate / 10^scale) — multiply, then
 * round down.
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
  // Add `n` to a running counter named `name`.
  count(name: string, n: number, tags?: Record<string, string>): void;

  // Record a single measurement of `value` for `name`.
  observe(name: string, value: number, tags?: Record<string, string>): void;
}

/**
 * The append-only double-entry ledger: where money movements are recorded and balances
 * and history are read back.
 */
export interface Ledger {
  hasAccount(account: AccountRef, options?: Options): Promise<boolean>;

  // Take a row lock on an account so concurrent operations can't race on its balance.
  lock(account: AccountRef, options?: Options): Promise<void>;

  // Record one posting (a balanced set of debit/credit lines) and return the committed
  // transaction.
  append(posting: Posting, options?: Options): Promise<Transaction>;

  // The account's current balance. Kept as a maintained running total, so this is a
  // cheap single read rather than a sum over its whole history.
  balance(account: AccountRef, options?: Options): Promise<Amount>;

  // A page of the account's entries within a time range (see Statement).
  statement(
    account: AccountRef,
    range: Range,
    options?: Options,
  ): Promise<Statement>;

  // The account's settlement lots — each one a chunk of funds added by a single top-up, with
  // the date it becomes eligible to be paid out (see {@link Lot}). Streamed one at a time
  // rather than returned as a single array, so a long history doesn't have to fit in memory.
  timeline(account: AccountRef): AsyncIterable<Lot>;

  // Every account paired with its current chain-head hash (the latest hash in that
  // account's tamper-evident chain).
  heads(): AsyncIterable<readonly [AccountRef, string]>;

  // Every account that has a cached running-balance row, streamed one at a time. The store
  // keeps this cached per-account total (the "materialized" balance) so reads don't have to
  // re-add every entry; the entries themselves remain the source of truth, so the cached
  // figure can be wrong. This list comes from that cache (SQL: the `account_balances` table;
  // memory: the keys of `state.balances`), NOT from the postings, so it surfaces a cached row
  // that has no posting behind it at all — an account `heads` would never visit, because
  // `heads` only sees accounts that actually have entries. The prover walks `heads` first,
  // then for any account seen only here it treats the true (summed-from-entries) balance as 0,
  // so a cached balance with no entries behind it shows up as a mismatch to be reported.
  balanceAccounts(options?: Options): AsyncIterable<AccountRef>;

  // Every posting that touched `account`, in commit order, with the hash recorded for
  // each. The integrity prover replays these to recompute each account's head hash and
  // confirm nothing was altered. The head hashes alone only show the chain is
  // well-formed; reading the full postings here is what catches an edited line.
  lineage(account: AccountRef, options?: Options): AsyncIterable<StoredLink>;

  // The whole posting that committed under `txnId`, or null if there's no such id.
  // A reversal loads this and negates its lines to post the exact opposite. Returning
  // null (instead of guessing) lets the operator-reversal handler fail loudly on an
  // unknown id. Unlike `lineage`, this isn't scoped to one account: it returns the one
  // transaction with all of its lines.
  posting(txnId: string, options?: Options): Promise<Posting | null>;
}

/**
 * The full set of stores the system reads and writes. `transaction` runs a block of
 * work with all of these committing atomically (all or nothing).
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
 * One line of a posting: an account and the amount applied to it. The amount is signed
 * positive in whichever direction makes that account's balance go up. Accounts differ in
 * which direction that is: some accounts grow when debited, others grow when credited. So
 * two accounts of opposite kinds in the same posting carry opposite signs.
 */
export type Leg = { account: AccountRef; amount: Amount };

/**
 * A balanced double-entry posting: a transaction id, its individual debit/credit lines
 * (legs), and free-form metadata. The legs add up to zero in each currency, so every
 * debit is matched by an equal credit and no money is created or lost.
 */
export type Posting = {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
};

/**
 * One posting as `lineage` returns it for a single account, carrying the two hashes that
 * tie it into that account's tamper-evident chain.
 *
 * The chain works like this: each posting's head hash is computed from the previous
 * head plus this posting's own contents, so changing any contents changes the hash. The
 * integrity prover re-hashes (previous head + the account's legs + meta) and checks the
 * result equals the stored `hash` — if a line was edited after the fact, it won't.
 */
export type StoredLink = {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;

  // The account's head hash just BEFORE this posting (a fixed all-zeros "genesis" hex
  // for the account's very first posting).
  prevHash: string;

  // The account's head hash AFTER this posting, recorded when it was appended — the
  // value the prover's recompute must reproduce.
  hash: string;
};

/**
 * The stores a single operation's handler may write to, all inside one database
 * transaction so its writes commit together.
 *
 * Note what's deliberately absent. `trust` isn't here because the risk-velocity write
 * happens outside the transaction (it goes straight through `Store.trust`), and
 * `checkpoints` isn't here because checkpoints are written only by the background
 * worker. There's no separate balance reader either: the funds pre-check reads balances
 * through `ledger.balance`. `promos` IS here: `grantPromo` records the grant in the same
 * transaction as the money posting, so a rolled-back grant leaves no promo-expiry row.
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

/**
 * Makes a repeated request safe to run at most once, keyed by the caller's idempotency
 * key.
 */
export interface IdempotencyStore {
  // Stake a claim on a key. The first caller for a key gets `{ claimed: true }` and may
  // proceed. If another caller is still mid-flight on the same key, this WAITS for them
  // to finish: if they committed, it returns `{ claimed: false }` with their recorded
  // transaction (so the duplicate request returns the same result); if they rolled back,
  // the key was never recorded and a fresh `{ claimed: true }` is granted.
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
 * Dedups raw inbound provider webhooks by the provider's own event id, kept deliberately
 * separate from the domain {@link IdempotencyStore} key space. The webhook ingress claims
 * the provider `eventId` here only as its LAST check — after it has already confirmed the
 * delivery's signature is authentic and the delivery is recent enough — so a rejected or
 * forged delivery never burns the id and a later genuine redelivery still processes. Backed
 * by the `seen_webhooks` table (SQL adapters) or an in-memory Map (memory adapter).
 */
export interface ReplayStore {
  // Atomic insert-if-absent on `eventId`: returns `{ claimed: true }` the first time an id is
  // seen and `{ claimed: false }` on every later sighting, so a redelivered event is processed
  // at most once. Unlike `IdempotencyStore.claim` this carries no transaction payload — the
  // webhook handler only needs to know whether this is the first delivery.
  claim(eventId: string, options?: Options): Promise<{ claimed: boolean }>;
}

/** Stores the summary of each completed sale, keyed by order id (a separate key from the idempotency key). */
export interface SaleStore {
  put(sale: Sale, options?: Options): Promise<void>;

  get(orderId: string, options?: Options): Promise<Sale | null>;
}

/**
 * A transactional outbox: events are saved in the same database transaction as the money
 * move, then a separate relay delivers them. This guarantees an event is never sent for a
 * move that rolled back, nor lost for one that committed.
 */
export interface OutboxStore {
  // Save an event to send later. Called inside the posting's transaction.
  enqueue(message: OutboxMessage, options?: Options): Promise<void>;

  // Grab up to `limit` unsent messages for the relay to deliver. Each grabbed message is
  // locked so a second relay running at the same time skips it and picks different ones.
  // Only 'pending' rows are ever returned: a 'relayed' or 'failed' (dead-lettered) row is
  // terminal and must never be re-claimed, so a single poison message can't wedge the queue.
  claimBatch(
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<OutboxMessage>>;

  // Mark messages delivered. Delivery may still double-send, so the consumer is expected
  // to drop duplicates by message id.
  markRelayed(ids: ReadonlyArray<string>, options?: Options): Promise<void>;

  // Record that delivering `id` failed: bump its `attempts` by exactly one and leave it
  // 'pending' so the next sweep retries it. A row that does not exist (already relayed,
  // already dead-lettered, or never enqueued) is left untouched. Mirrors the read-modify
  // pattern the saga store uses; it must not flip the status — only `deadLetter` does that.
  recordFailure(id: string, options?: Options): Promise<void>;

  // Give up on a poison message: set its status to 'failed' so `claimBatch` never returns
  // it again, recording `reason` (the last failure's error code) for operators. Mirrors
  // SagaStore.deadLetter's shape. A non-existent / already-terminal row is left untouched.
  deadLetter(id: string, reason: string, options?: Options): Promise<void>;
}

/**
 * Tracks each multi-step payout (a "saga") as it moves through its states. A background
 * sweep picks up sagas that are due and pushes each one to its next state.
 */
export interface SagaStore {
  open(saga: Saga, options?: Options): Promise<void>;

  load(id: string, options?: Options): Promise<Saga | null>;

  // Grab up to `limit` sagas whose `dueAt` has passed, for the background sweep to
  // advance. Each is locked so two sweeps running at once take different sagas.
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<Saga>>;

  // Move a saga from `from` to `to` and apply `patch`, but only if it is still in the
  // `from` state. Returns false (changing nothing) if it had already moved on, so two
  // sweeps can't both advance the same saga.
  advance(
    id: string,
    from: SagaState,
    to: SagaState,
    patch: Partial<Saga>,
    options?: Options,
  ): Promise<boolean>;

  // Give up on a saga that can't make progress, recording why.
  deadLetter(id: string, reason: string, options?: Options): Promise<void>;

  // The time of `userId`'s most recent payout REQUEST, used to enforce the minimum gap
  // between requests (config.payoutMinIntervalMs). "Most recent" means the maximum
  // `updatedAt` over ALL of that user's sagas regardless of state — a saga's `updatedAt`
  // equals its request time at open() (requestPayout sets updatedAt = now when it opens the
  // saga in RESERVED) and only ever moves forward as the worker advances it, so the maximum
  // is always >= the latest request and never lets a user slip a second request through the
  // window. Returns null when the user has no sagas at all (so their first request is always
  // allowed). Counts every state including FAILED/SETTLED, so a failed or completed payout
  // still starts the clock on the next one.
  lastPayoutAt(userId: string, options?: Options): Promise<number | null>;
}

/**
 * Tracks which users own which items or features (their "entitlements"), keyed by SKU — the
 * string product code that identifies the item or feature being granted.
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

  // The one ACTIVE subscription matching this (userId, sku, sellerId) triple, or null if the
  // user has no active subscription to that seller's sku. The subscribe handler uses this to
  // refuse opening a second active subscription to the same sku/seller (which would double-bill).
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
  // Returns false (changing nothing) when no row matched — i.e. another overlapping sweeper already
  // billed this period and moved next_due_at on — so the loser treats it as a no-op and never
  // double-charges. Mirrors SagaStore.advance's CAS guard.
  markBilled(
    id: string,
    nextDueAt: number,
    expectedDueAt: number,
    options?: Options,
  ): Promise<boolean>;

  // Mark a subscription LAPSED because a renewal couldn't be paid (the buyer ran out of
  // spendable funds). This is distinct from a user-requested cancel; either way the
  // renewal sweep stops re-billing it.
  markLapsed(id: string, options?: Options): Promise<void>;
}

/**
 * Tracks each marketing promo grant so the background worker can reverse whatever the
 * user hasn't spent once the grant expires. `grantPromo` records the grant here in the
 * same transaction as the credit posting (see {@link Unit}); the promo-expiry sweep later
 * claims due grants and reverses the unspent remainder against `SYSTEM.PROMO_FLOAT`.
 */
export interface PromoStore {
  // Record a new grant. Idempotent on `grant.id`: opening the same id twice is a no-op and
  // never overwrites or duplicates the first row (mirrors how SagaStore.open uses
  // `on conflict (id) do nothing`). Called inside the grant's transaction, so it only takes
  // effect if that transaction commits.
  open(grant: PromoGrant, options?: Options): Promise<void>;

  // Grab up to `limit` grants that have expired and not yet been reversed — those whose
  // `expiresAt` has passed (`expiresAt <= now`) AND whose `reversed` flag is still false —
  // for the promo-expiry sweep to act on. Returned oldest `expiresAt` first, so the most
  // overdue grants are reversed first. A grant already reversed is never handed back, so a
  // single grant is reversed at most once across sweeps.
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<PromoGrant>>;

  // Mark a grant reversed so `claimDue` never returns it again. A no-op on a row that does
  // not exist or is already reversed (the same read-modify guard SagaStore.deadLetter and
  // OutboxStore.deadLetter use), so re-running the sweep over the same grant is harmless.
  markReversed(id: string, options?: Options): Promise<void>;
}

/**
 * Tracks how much each subject has spent recently, the input to the risk gate. Written
 * outside the money transaction (so even a denied attempt still counts toward the limit).
 */
export interface TrustStore {
  read(subject: string, options?: Options): Promise<Velocity>;

  // Record one spending attempt. Idempotent on `attempt.idempotencyKey`, so a genuine
  // retry doesn't double-count.
  bump(subject: string, attempt: Attempt, options?: Options): Promise<void>;

  // Atomically record the attempt (idempotent on `attempt.idempotencyKey`) and return the
  // subject's windowed velocity INCLUDING it, in one indivisible step. This is what the risk
  // gate calls: the record-and-measure must be atomic and serialized per subject, so two
  // concurrent attempts for the same subject can't both read a stale pre-bump total and both
  // slip past the limit (the velocity-limit TOCTOU `read`-then-`bump` left open). A genuine
  // retry of an already-recorded key still returns the current total without counting twice.
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
// The data shapes the stores above pass around. Each is a plain JSON-friendly object
// owned by the module that produces it; the versions here pin the shape the tests rely
// on. An owner may add fields, but must not change one of the methods declared above.

/**
 * The fixed shape of every event the system emits. An `audience: 'client'` event is the
 * kind pushed out to connected clients over the WebSocket.
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
  // - 'pending' — still needs sending; the only status `claimBatch` ever hands back.
  // - 'relayed' — successfully delivered (set by `markRelayed`); never re-claimed.
  // - 'failed'  — dead-lettered after too many delivery attempts (set by `deadLetter`);
  //   a terminal, poison state that `claimBatch` must skip so it can't wedge the queue.
  status: 'pending' | 'relayed' | 'failed';

  // How many delivery attempts have been made. Incremented by `recordFailure` each time a
  // dispatch throws; once it reaches the configured cap the relay dead-letters the row.
  attempts: number;
}

/**
 * A summary of a completed sale. Sales split across several recipients, so this records
 * the exact lines that posted; keeping them lets a later refund reverse the sale precisely.
 */
export interface Sale {
  orderId: string;
  buyerId: string;
  sku: string;

  // Who received the purchased SKU's entitlement. For an ordinary purchase this is the buyer;
  // for a gift it is the recipient (`giftTo`) the buyer bought it for. A refund revokes ownership
  // from this user, so a refunded gift takes the item back from the recipient, not the buyer.
  // Optional for backward compatibility with sales recorded before gifting existed; a missing
  // value means the buyer received it.
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
 * The states a payout saga moves through, from request to settled (or failed). It's a
 * plain readonly array of strings rather than a TypeScript enum.
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

  // How many consecutive times the renewal sweep has failed to bill this subscription with
  // a retryable (temporary) error. Starts at 0 when the subscription is opened. The sweep
  // bumps it on a retryable failure and resets it to 0 on a successful renewal; once it
  // reaches the configured cap (config.maxSubscriptionAttempts) the sweep stops retrying and
  // LAPSES the subscription instead of re-billing it forever. Adapters MUST round-trip this
  // field through save/load (open/markBilled/markLapsed and every load path).
  attempts: number;

  // When the next renewal is due, in epoch milliseconds.
  nextDueAt: number;

  updatedAt: number;
}

/**
 * One stored marketing promo grant the worker can later reverse. Recorded by `grantPromo`
 * alongside the credit posting; the promo-expiry sweep reverses the unspent remainder once
 * `expiresAt` has passed, then sets `reversed` so it is never reversed twice.
 */
export interface PromoGrant {
  // Unique grant id. Reuses the transaction prefix (txn_<uuid>) of the grant's own posting,
  // so a grant and the entry that created it share one id and `open` is idempotent on it.
  id: string;

  userId: string;

  // The credits granted, in CREDIT. The full grant; the sweep reverses only as much of this
  // as the user has NOT already spent (re-read per grant against the live promo balance).
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
 * A signed snapshot of the whole ledger at one moment. It reduces every account's
 * head hash to a single Merkle root (one hash that changes if any account's chain
 * changes) and signs that, so the snapshot vouches for every account at once. It's
 * meant to be anchored somewhere outside this system for independent proof.
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
