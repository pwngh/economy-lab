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

export type Options = { signal?: AbortSignal };

/**
 * Bounds a {@link Ledger.timeline} read. The default streams the whole lot history oldest-first;
 * `order: 'desc'` with `limit`/`offset` reads the newest run, so the maturity tail can stop once
 * it has covered the live balance.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage}
 * for the SQL pushdown.
 */
export type TimelineOptions = {
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

/** Allowed id prefixes. Every minted id is `<prefix>_<uuid>` (e.g. `txn_...`, `usr_...`). */
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

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export interface Ids {
  next(prefix: IdPrefix): string;
}

export interface Digest {
  /** The SHA-256 hash of the input. */
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

  /** Accepts still-valid older keys, so a signature made before a key rotation keeps verifying. */
  verify(bytes: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/**
 * Optional read-through cache for hot reads such as balances; best-effort, so any error degrades
 * to a direct ledger read.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage}
 * for the best-effort cache contract.
 */
export interface Cache {
  get(key: string): Promise<string | null>;

  set(key: string, value: string, ttlMs?: number): Promise<void>;

  invalidate(key: string): Promise<void>;
}

/**
 * Admission control for the HTTP edge. Each `allow` call counts one request against `key` and
 * answers whether it may proceed; the limit and window are the adapter's policy, so the server
 * only ever asks for the verdict. A throwing limiter is treated as absent for that request —
 * the edge fails open, because a down limiter backend should degrade protection, not
 * availability.
 */
export interface RateLimiter {
  allow(key: string): Promise<RateVerdict>;
}

/** What {@link RateLimiter.allow} returns; `retryAfterMs` rides denials that know their window. */
export type RateVerdict = { allowed: boolean; retryAfterMs?: number };

export interface Scheduler {
  /** Runs `task` every `ms` milliseconds; the returned function stops the loop. */
  every(ms: number, task: () => Promise<void>, options?: Options): () => void;
}

/** Hands an outgoing event off for delivery (e.g. SQS or HTTP); the core doesn't know which. */
export type Dispatcher = (
  event: EconomyEvent,
  options?: Options,
) => Promise<void>;

/**
 * External payment provider: all money leaving the platform goes through this.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for the seam,
 * the Tilia adapter, and dispute webhooks.
 */
export interface Processor {
  /** `amount` is in real USD; `key` makes the request safe to retry without paying twice. */
  submitPayout(
    input: { key: string; userId: string; amount: Amount },
    options?: Options,
  ): Promise<{ providerRef: string }>;

  /**
   * Optional evidence probe the sweep consults before force-failing a silent payout: FAILED or
   * RETURNED releases the reserve early, SETTLED blocks the force-fail (a lost webhook can't
   * double-pay), PENDING defers the timeout; absent, webhook plus timeout are the whole protocol.
   */
  payoutStatus?(
    input: { providerRef: string },
    options?: Options,
  ): Promise<PayoutProviderStatus>;
}

/** The answer to {@link Processor.payoutStatus}; the sweep treats UNKNOWN like having no probe. */
export type PayoutProviderStatus = {
  state: 'SETTLED' | 'RETURNED' | 'FAILED' | 'PENDING' | 'UNKNOWN';
};

export interface PayeeDirectory {
  status(userId: string, options?: Options): Promise<PayeeVerification>;
}

export type PayeeVerification = {
  state: 'CLEARED' | 'PENDING' | 'BLOCKED' | 'NONE';
};

/**
 * Supplies fixed CREDIT-to-USD rates from an audited source, never from config or caller input;
 * the three rates always hold `buy >= par >= payout`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/money-model/ The money model} for
 * what `buy`/`par`/`payout` mean, why the ordering holds, and what the spread funds.
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/rates/ Rates} for the port and its
 * configured adapter.
 */
export interface Rates {
  /** The settlement rate at time `at`; on CREDIT-to-USD payout it equals `par`. */
  payout(
    from: Currency,
    to: Currency,
    at: number,
    options?: Options,
  ): Promise<Rate>;

  /** The redemption and backing rate; reconciliation values spendable credits in USD at it. */
  par(currency: Currency): Rate;

  /** The acquisition rate a user pays for credits; `topUp` values the buyer's cash at it. */
  buy(currency: Currency): Rate;
}

/**
 * An exchange rate as exact integers: the multiplier is `rate / 10^scale`, and
 * usd_minor = floor(credit_minor * rate / 10^scale). `rateId` names the rate a transaction used.
 */
export type Rate = { rate: bigint; scale: number; rateId: string };

export interface Logger {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>,
  ): void;
}

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
   * Locks several accounts in one round trip, in a single deadlock-free global order; when
   * absent, callers fall back to per-account `lock` in that same order. Locks release at commit.
   */
  lockMany?(
    accounts: ReadonlyArray<AccountRef>,
    options?: Options,
  ): Promise<void>;

  append(posting: Posting, options?: Options): Promise<Transaction>;

  /** A maintained running total: one read, not a sum over the account's whole history. */
  balance(account: AccountRef, options?: Options): Promise<Amount>;

  statement(
    account: AccountRef,
    range: Range,
    options?: Options,
  ): Promise<Statement>;

  /**
   * The balance re-derived from the account's legs, one Amount per currency present (empty when
   * none), folded server-side on SQL so the prover never ships every leg over the wire.
   */
  derivedBalances(
    account: AccountRef,
    options?: Options,
  ): Promise<ReadonlyArray<Amount>>;

  /** Streams the account's settlement lots; {@link TimelineOptions} bounds the read. */
  timeline(account: AccountRef, options?: TimelineOptions): AsyncIterable<Lot>;

  /** Streams every account with its chain-head hash, the latest in its tamper-evident chain. */
  heads(): AsyncIterable<readonly [AccountRef, string]>;

  /**
   * Like `heads` plus each account's raw signed leg sum in minor units (debit positive — the leg
   * sign convention, not the account's natural side); head and sum must be read in one statement
   * so a concurrent posting can never tear the pair.
   */
  headSums(
    options?: Options,
  ): AsyncIterable<readonly [AccountRef, string, bigint]>;

  /**
   * Streams every account that has a cached running-balance row — such a row can exist with no
   * posting behind it, which `heads` never visits, so the prover surfaces the mismatch from here.
   */
  balanceAccounts(options?: Options): AsyncIterable<AccountRef>;

  /**
   * Streams every posting that touched `account`, in commit order, with each recorded hash; the
   * prover replays these because head hashes alone cannot catch an edited line.
   */
  lineage(account: AccountRef, options?: Options): AsyncIterable<StoredLink>;

  /** The whole posting committed under `txnId`, with all its legs, or null on an unknown id. */
  posting(txnId: string, options?: Options): Promise<Posting | null>;

  /**
   * Streams every committed posting with its full legs, newest first by commit sequence — a total
   * order, so ties never reorder a page.
   */
  list(options?: Options): AsyncIterable<Posting>;
}

/**
 * The full set of stores the system reads and writes.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage}
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
   * The instance-netting journal; it commits outside money transactions, so an accepted movement
   * is durable regardless of any ledger posting's fate.
   */
  movements: MovementJournal;

  /** Runs `work` in one database transaction: everything it writes commits together or not at all. */
  transaction<T>(
    work: (unit: Unit) => Promise<T>,
    options?: Options,
  ): Promise<T>;

  close(): Promise<void>;
}

/** Every external capability `economyFromCapabilities(...)` needs, gathered into one object. */
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
  payees?: PayeeDirectory;
  pricing: FeePolicy;
  config: Config;
};

/**
 * One line of a posting: an account and the amount applied, debit-positive — a credit is stored
 * negated whatever the account's normal side, so the sign is the ledger's, not the account
 * holder's (a top-up's wallet leg is negative). `balanceDelta` (from `/store-kit`) converts a
 * leg to the signed change in that account's balance.
 */
export type Leg = { account: AccountRef; amount: Amount };

/** A balanced double-entry posting: legs sum to zero in each currency. */
export type Posting = {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
};

/**
 * One posting as `lineage` returns it, carrying the two hashes that tie it into the account's
 * tamper-evident chain.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 * hash chain.
 */
export type StoredLink = {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;

  /** The account's head hash before this posting; a fixed all-zeros "genesis" hex for the first. */
  prevHash: string;

  /** The account's head hash after this posting; the prover's recompute must reproduce it. */
  hash: string;
};

/**
 * The stores one operation's handler may write to, all inside one database transaction;
 * `checkpoints` is absent because only the worker writes it.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage}
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
  /** Cached so the funds screen and handler share one read; unset outside the pipeline. */
  balances?: Map<string, Amount>;
}

/** Makes a repeated request run at most once, keyed by the caller's idempotency key. */
export interface IdempotencyStore {
  /**
   * Stakes a claim on a key: a claim on an in-flight key waits for its owner, a committed key
   * replays the recorded transaction as `{ claimed: false }`, and a rolled-back key is granted
   * fresh as `{ claimed: true }`.
   */
  claim(
    key: string,
    options?: Options,
  ): Promise<{ claimed: true } | { claimed: false; transaction: Transaction }>;

  /** Called inside the posting's transaction, so it only takes effect if the posting commits. */
  record(
    key: string,
    transaction: Transaction,
    options?: Options,
  ): Promise<void>;
}

/**
 * Dedups raw inbound provider webhooks by provider event id, in a key space separate from the
 * domain {@link IdempotencyStore}. The ingress claims the id only after verifying the delivery,
 * so a forged delivery never burns it and a later genuine redelivery still processes.
 */
export interface ReplayStore {
  /** Atomically inserts `eventId` if absent; `claimed` is true only on the first sighting. */
  claim(eventId: string, options?: Options): Promise<{ claimed: boolean }>;
}

/** Stores the summary of each completed sale, keyed by order id (a separate key from the idempotency key). */
export interface SaleStore {
  put(sale: Sale, options?: Options): Promise<void>;

  get(orderId: string, options?: Options): Promise<Sale | null>;
}

/**
 * A transactional outbox: events save in the same database transaction as the money move, so an
 * event is never sent for a rolled-back move nor lost for a committed one.
 */
export interface OutboxStore {
  /** Saves an event to send later. Called inside the posting's transaction. */
  enqueue(message: OutboxMessage, options?: Options): Promise<void>;

  /**
   * Grabs up to `limit` pending messages, each locked so a concurrent relay picks different ones.
   * A 'relayed' or 'dead' row is terminal and never re-claimed.
   */
  claimBatch(
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<OutboxMessage>>;

  /** Delivery may still double-send, so the consumer drops duplicates by message id. */
  markRelayed(ids: ReadonlyArray<string>, options?: Options): Promise<void>;

  /** Bumps `attempts` and leaves the row 'pending'; only `deadLetter` may flip the status. */
  recordFailure(id: string, options?: Options): Promise<void>;

  /**
   * Sets status 'dead' so `claimBatch` never returns it again, recording `reason` for operators;
   * a non-existent or already-terminal row is left untouched.
   */
  deadLetter(id: string, reason: string, options?: Options): Promise<void>;

  /**
   * A read-only gauge of the pending backlog: how many rows wait and how old the oldest is.
   * Age is computed on the store's own time base, so an app/database clock skew never distorts
   * it. The relay sweep observes this each run — a backlog that only grows means the relay is
   * down or the events are poisoned.
   */
  stats(options?: Options): Promise<OutboxStats>;
}

/** What {@link OutboxStore.stats} reports; `oldestPendingAgeMs` is null when nothing is pending. */
export type OutboxStats = {
  pending: number;
  oldestPendingAgeMs: number | null;
};

/**
 * A transactional inbox: the inbound mirror of {@link OutboxStore}. A verified provider event,
 * mapped to the {@link Operation} it should apply, saves in the same transaction as the ingress
 * that claimed it; a recorded event is eventually applied or dead-lettered.
 */
export interface InboxStore {
  /** Dedupes on `entry.key`, so a redelivered provider event is applied at most once. */
  enqueueInbound(entry: InboxEntry, options?: Options): Promise<InboxEntry>;

  /**
   * Grabs up to `limit` pending rows oldest-first, each locked so a concurrent worker picks
   * different ones. An 'applied' or 'dead' row is terminal and never re-claimed.
   */
  claimInbound(
    input: { now: number; limit: number },
    options?: Options,
  ): Promise<ReadonlyArray<InboxEntry>>;

  /**
   * Called inside the apply's transaction, so a rolled-back apply leaves the row 'pending'; a
   * non-existent or already-terminal row is left untouched.
   */
  markApplied(id: string, options?: Options): Promise<void>;

  /**
   * Bumps `attempts` and leaves the row 'pending'; only `deadLetter` may flip the status. A
   * non-existent row is left untouched.
   */
  bumpAttempt(id: string, options?: Options): Promise<void>;

  /**
   * Sets status 'dead' so `claimInbound` never returns it again, recording `reason` for
   * operators; a non-existent or already-terminal row is left untouched.
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

  /** If more than one saga ever carried this provider reference, the newest `updatedAt` wins. */
  findByProviderRef(
    providerRef: string,
    options?: Options,
  ): Promise<Saga | null>;

  /** Every saga regardless of state, newest `updatedAt` first; ties on `updatedAt` break by `id` descending. */
  list(options?: Options): AsyncIterable<Saga>;

  /** Grabs up to `limit` due sagas, each locked so concurrent sweeps take different ones. */
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
   * The max `updatedAt` over all of the user's sagas in any state, enforcing
   * config.payoutMinIntervalMs. `updatedAt` only advances, so the max never undershoots the
   * latest request; null when the user has no sagas, so a first request is always allowed.
   */
  lastPayoutAt(userId: string, options?: Options): Promise<number | null>;
}

/** Tracks which users own which items or features (entitlements), keyed by SKU (the product code). */
export interface EntitlementStore {
  grant(
    userId: string,
    sku: string,
    attrs: EntitlementAttrs,
    options?: Options,
  ): Promise<void>;

  revoke(userId: string, sku: string, options?: Options): Promise<void>;

  owns(userId: string, sku: string, options?: Options): Promise<boolean>;

  /**
   * Streams every non-revoked grant for the user, expired ones included, sorted by sku. Each row
   * carries the expiry `owns` applies at read time (null never lapses), so a caller can reproduce
   * the ownership decision.
   */
  list(userId: string, options?: Options): AsyncIterable<EntitlementGrant>;
}

export interface EntitlementGrant {
  sku: string;

  /** Epoch ms the grant lapses (owned while now <= expiresAt), or null for a perpetual grant. */
  expiresAt: number | null;
}

/** Tracks recurring subscriptions and when each is next due to bill. */
export interface SubscriptionStore {
  open(sub: Subscription, options?: Options): Promise<void>;

  load(id: string, options?: Options): Promise<Subscription | null>;

  /**
   * The one ACTIVE subscription for this (userId, sku, sellerId), or null; subscribe uses it to
   * refuse a second active subscription, which would double-bill.
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
   * Records a successful renewal as a compare-and-set against the period the sweeper claimed
   * (`next_due_at = expectedDueAt`); returns false and changes nothing when another sweeper
   * already billed the period, so the loser never double-charges.
   */
  markBilled(
    id: string,
    nextDueAt: number,
    expectedDueAt: number,
    options?: Options,
  ): Promise<boolean>;

  /**
   * Marks a subscription LAPSED because a renewal couldn't be paid — distinct from a
   * user-requested cancel; either way the sweep stops re-billing it.
   */
  markLapsed(id: string, options?: Options): Promise<void>;
}

/**
 * Tracks each marketing promo grant so the promo-expiry sweep can reverse the unspent remainder
 * against `SYSTEM.PROMO_FLOAT` once the grant expires.
 */
export interface PromoStore {
  /**
   * Idempotent on `grant.id`: opening the same id twice never overwrites the first row. Called
   * inside the grant's transaction, so it only takes effect if that transaction commits.
   */
  open(grant: PromoGrant, options?: Options): Promise<void>;

  /**
   * Grabs up to `limit` expired (`expiresAt <= now`), not-yet-reversed grants, oldest `expiresAt`
   * first; a reversed grant is never handed back, so a grant is reversed at most once across sweeps.
   */
  claimDue(
    now: number,
    limit: number,
    options?: Options,
  ): Promise<ReadonlyArray<PromoGrant>>;

  /**
   * Marks a grant reversed so `claimDue` never returns it again; a missing or already-reversed
   * row is a no-op, so re-running the sweep is harmless.
   */
  markReversed(id: string, options?: Options): Promise<void>;
}

/**
 * Tracks how much each subject has spent recently — the risk gate's input. Two views: the
 * store-level instance commits on its own connection, the {@link Unit} view writes inside the
 * money transaction, so every attempt is counted exactly once whether its operation commits or
 * rolls back.
 */
export interface TrustStore {
  read(subject: string, options?: Options): Promise<Velocity>;

  /** Idempotent on `attempt.idempotencyKey`, so a genuine retry doesn't double-count. */
  bump(subject: string, attempt: Attempt, options?: Options): Promise<void>;

  /**
   * Records the attempt (idempotent on `attempt.idempotencyKey`) and returns the subject's
   * windowed velocity including it, in one atomic step serialized per subject — record-and-measure
   * must be one step (the velocity-limit TOCTOU; see screenRisk in economy.ts).
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

  latest(options?: Options): Promise<Checkpoint | null>;
}

/**
 * One accepted in-instance movement: a balanced set of legs not yet posted to the ledger, made
 * ledger-final at settle. `prevHash`/`hash` chain the session's movements and the settlement
 * posting anchors the final head, so tamper-evidence extends to every movement.
 */
export interface Movement {
  sessionId: string;

  /** Position in the session chain, from 0. */
  seq: number;

  /** The movement's idempotency key, unique across all sessions. */
  idempotencyKey: string;

  legs: ReadonlyArray<Leg>;

  /** Session chain hash before this movement; the genesis value (64 zeros) for the first. */
  prevHash: string;

  /** Session chain hash after this movement. */
  hash: string;

  /** Epoch ms the movement was accepted. */
  recordedAt: number;
}

/**
 * The append-only instance-netting journal. A batch commits in one transaction (one fsync for N
 * movements), and journal rows carry no locks, chain links, or balance updates. A duplicate
 * idempotency key or (sessionId, seq) rejects the batch; the session splits and retries around
 * the poison row.
 */
export interface MovementJournal {
  append(movements: ReadonlyArray<Movement>, options?: Options): Promise<void>;

  /** Streams a session's movements in seq order — the source of truth settle derives from. */
  bySession(sessionId: string, options?: Options): AsyncIterable<Movement>;
}

// --- Record types -----------------------------------------------------------------
// The data shapes the stores above pass around: plain JSON-friendly objects. An owner may add
// fields, but must not change the store methods declared above.

/**
 * The fixed shape of every event the system emits. An `audience: 'client'` event is pushed out
 * to connected clients over the WebSocket.
 */
export interface EconomyEvent {
  id: string;

  /** The event name, e.g. 'economy.sale.completed'. */
  type: string;

  /** Schema version of this event's shape, currently 1. */
  version: number;

  /** When the event happened, in epoch milliseconds. */
  occurredAt: number;

  /** What the event is about: a user id (usr_...) or transaction id (txn_...). */
  subject: string;

  data: Record<string, unknown>;

  audience: 'internal' | 'client';
}

/** One stored outbox row: an event plus the bookkeeping for delivering it (see OutboxStore). */
export interface OutboxMessage {
  id: string;

  event: EconomyEvent;

  /** 'pending' is the only status `claimBatch` ever hands back; 'relayed' and 'dead' are terminal. */
  status: 'pending' | 'relayed' | 'dead';

  /** Delivery attempts so far; at the configured cap the relay dead-letters the row. */
  attempts: number;

  /** Why the relay gave up, set when the row goes 'dead'; null otherwise. */
  reason: string | null;
}

/** One stored inbox row: a verified inbound event mapped to the operation it applies (see InboxStore). */
export interface InboxEntry {
  id: string;

  /**
   * The provider's event id: the dedupe key on enqueue and the submitted operation's
   * idempotencyKey, so a redelivered event resolves to the same money move at most once.
   */
  key: string;

  operation: Operation;

  /** 'pending' is the only status `claimInbound` ever hands back; 'applied' and 'dead' are terminal. */
  status: 'pending' | 'applied' | 'dead';

  /** Apply attempts so far; at the configured cap the worker dead-letters the row. */
  attempts: number;

  /** When the verified event was enqueued, in epoch milliseconds. */
  receivedAt: number;

  /** Why the worker gave up, set when the row goes 'dead'; null otherwise. */
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
   * Who received the SKU's entitlement: the buyer, or the gift recipient (`giftTo`); a refund
   * revokes ownership from this user. Missing means the buyer (sales recorded before gifting
   * existed).
   */
  recipientId?: string;

  /** What the buyer paid. */
  price: Amount;

  /** The platform's cut of the price. */
  fee: Amount;

  legs: ReadonlyArray<Leg>;

  txnId: string;
  postedAt: number;
}

/**
 * The states a payout saga moves through, from request to settled (or failed).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/payout-saga/ The payout saga} for the
 * saga states; subscriptions have their own page.
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
  id: string;

  userId: string;

  /** The seller's earned credits, held in the payout-reserve account while this is in flight. */
  reserve: Amount;

  /** Names the exact CREDIT-to-USD rate this payout is locked to. */
  rateId: string;

  state: SagaState;

  /** The payment provider's reference once submitted, null before then. */
  providerRef: string | null;

  /** Why the worker gave up on this payout, set when it reaches FAILED; null otherwise. */
  reason: string | null;

  /** How many times the worker has tried to advance this saga. */
  attempts: number;

  /** When the worker should next act on it, in epoch milliseconds. */
  dueAt: number;

  updatedAt: number;

  /**
   * The gross USD disbursed, set when settlePayout marks this payout SETTLED; null otherwise.
   * Stored on the saga so a reader never re-derives it from posting meta.
   */
  payoutUsd: Amount | null;
}

export const SUBSCRIPTION_STATES = ['ACTIVE', 'LAPSED', 'CANCELED'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export interface Subscription {
  id: string;

  userId: string;
  sellerId: string;
  sku: string;

  /** What each renewal charges. */
  price: Amount;

  periodMs: number;

  state: SubscriptionState;

  /** Which billing period number it's on (increments each renewal). */
  period: number;

  /**
   * Consecutive retryable billing failures: bumped on a retryable failure, reset to 0 on a
   * successful renewal; at config.maxSubscriptionAttempts the sweep lapses the subscription.
   * Adapters must round-trip this field through every save/load path.
   */
  attempts: number;

  /** When the next renewal is due, in epoch milliseconds. */
  nextDueAt: number;

  updatedAt: number;
}

/** One stored marketing promo grant, for the promo-expiry sweep to reverse (see {@link PromoStore}). */
export interface PromoGrant {
  /** Reuses the grant posting's txn_ id, so `open` is idempotent on it. */
  id: string;

  userId: string;

  /** The full grant, in CREDIT; the sweep reverses only what the user hasn't already spent. */
  amount: Amount;

  /** When the grant expires, in epoch milliseconds. */
  expiresAt: number;

  /** Set true once the unspent remainder is reversed; `claimDue` skips it thereafter. */
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

  outcome: 'committed' | 'rejected';
}

/**
 * A signed snapshot of the whole ledger: every account's head hash reduced to one Merkle root and
 * signed, meant to be anchored outside this system for independent proof. Version 2 roots carry
 * balance sums up the tree, so the signature (over root hash and root sum together) also attests
 * conservation at seal time; version 1 rows predate the sums and verify forever under the
 * hash-only construction.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 * hash chain and signed-checkpoint construction.
 */
export interface Checkpoint {
  id: string;

  /** The Merkle root over all account heads (v2: heads and sums), as lowercase hex. */
  root: string;

  /** The signature (v1: over `root`; v2: over `root` and the 8-byte root sum), as lowercase hex. */
  signature: string;

  /** How many account heads the root covers. */
  count: number;

  /** When the snapshot was taken, in epoch milliseconds. */
  at: number;

  /** Preimage construction this row was sealed under. Rows from before versioning decode as 1. */
  v: 1 | 2;

  /**
   * The root's balance sum in minor units as a signed decimal string (JSON and the row can't
   * carry a bigint), or null on v1 rows. Zero on every honestly sealed v2 row: the seal refuses
   * to sign a ledger whose raw leg sums do not net to zero.
   */
  sum: string | null;
}

/** A statement query's time range, in epoch milliseconds. Half-open: `from` is included, `to` is not. */
export interface Range {
  from: number;
  to: number;
}

/** One page of an account's entries. Paging is by narrowing the `Range`, window by window. */
export interface Statement {
  account: AccountRef;

  entries: ReadonlyArray<{ txnId: string; amount: Amount; postedAt: number }>;

  /** Reserved. No read accepts a cursor and every engine returns null; page by the range. */
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
