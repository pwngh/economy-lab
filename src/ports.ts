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
  EntitlementAttributes,
  FeePolicy,
  Operation,
} from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Config, Secrets } from '#src/config.ts';

export type CallOptions = {
  /**
   * Aborts the adapter's wait, not work already done: an adapter observes it on network and
   * database waits, and a caller treats an aborted call's effects as unknown, never as undone.
   */
  signal?: AbortSignal;

  /**
   * Correlation id of the request driving this call. Read by submit's outbox enqueue, which
   * stamps it onto the event envelope so the relay's logs can name the originating request;
   * every other consumer ignores it.
   */
  correlationId?: string;
};

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

/**
 * The core's single time source: due times, expiries, maturity, and rate lookups all read it,
 * so a fixed test clock makes every sweep deterministic. Store-side age gauges (e.g.
 * {@link OutboxStore.stats}) deliberately use the store's own time base instead.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/**
 * Mints unique identifiers, one namespace per entity kind (see {@link IdPrefix}). An id must
 * never repeat within its prefix: minted ids become row keys, and `txn_` ids are hashed into
 * the tamper-evident chain. The runtime default appends a `crypto.randomUUID()` to the prefix.
 */
export interface Ids {
  next(prefix: IdPrefix): string;
}

/**
 * Content hashing for chain links, checkpoints, and session movements. The algorithm is part of
 * the contract: provers recompute stored hashes from stored content, so anything other than
 * SHA-256 makes every previously stored hash fail verification.
 */
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
  /**
   * Signs `bytes` with the current key — the one {@link Signer.kid} names; the reference
   * adapter signs Ed25519 over the raw bytes.
   */
  sign(bytes: Uint8Array): Promise<Uint8Array>;

  /** Accepts still-valid older keys, so a signature made before a key rotation keeps verifying. */
  verify(bytes: Uint8Array, signature: Uint8Array): Promise<boolean>;

  /**
   * Identifier of the key `sign` currently uses; the reference signer answers the first 16 hex
   * characters of the Ed25519 public key. Stamped onto checkpoints so an auditor can tell which
   * key sealed a row across rotations. Optional: a signer without it seals rows with a null kid.
   */
  kid?(): Promise<string>;
}

/**
 * Optional read-through cache for hot reads such as balances; best-effort, so any error degrades
 * to a direct ledger read.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage}
 * for the best-effort cache contract.
 */
export interface Cache {
  /**
   * The cached string, or null on a miss or an expired entry; the core's read path treats a
   * throwing get as a miss.
   */
  get(key: string): Promise<string | null>;

  /**
   * Stores `value` whole, overwriting any previous entry. `ttlMs` bounds the entry's life;
   * without it the entry lives until invalidated or evicted, and eviction at any time is legal —
   * every read tolerates a miss.
   */
  set(key: string, value: string, ttlMs?: number): Promise<void>;

  /**
   * Removes the key so the next get reads through; a missing key is a no-op. The core calls it
   * after a commit changes a cached balance, and a failed invalidate only logs — give entries a
   * lifetime if a pinned stale value is unacceptable.
   */
  invalidate(key: string): Promise<void>;
}

/**
 * Admission control for the HTTP edge. Each `allow` call counts one request against `key` and
 * answers whether it may proceed; the limit and window are the adapter's policy, so the server
 * only ever asks for the verdict. A throwing limiter is treated as absent for that request —
 * the edge fails open, because a down limiter backend should degrade protection, not
 * availability.
 *
 * @example
 * // A fixed-budget limiter: 100 requests per key, refilled by the adapter's own policy.
 * const budgets = new Map<string, number>();
 * const limiter: RateLimiter = {
 *   async allow(key) {
 *     const left = budgets.get(key) ?? 100;
 *     if (left === 0) return { allowed: false, retryAfterMs: 1_000 };
 *     budgets.set(key, left - 1);
 *     return { allowed: true };
 *   },
 * };
 */
export interface RateLimiter {
  allow(key: string): Promise<RateVerdict>;
}

/** What {@link RateLimiter.allow} returns; `retryAfterMs` rides denials that know their window. */
export type RateVerdict = { allowed: boolean; retryAfterMs?: number };

export interface Scheduler {
  /** Runs `task` every `ms` milliseconds; the returned function stops the loop. */
  every(
    ms: number,
    task: () => Promise<void>,
    options?: CallOptions,
  ): () => void;
}

/**
 * Hands an outgoing event off for delivery (e.g. SQS or HTTP); the core doesn't know which. A
 * resolved call means handed off, and delivery is at-least-once — consumers dedupe by event id.
 * A rejection counts one failed attempt against the outbox row; the relay retries it until
 * `config.maxOutboxAttempts` dead-letters it.
 */
export type Dispatcher = (
  event: EconomyEvent,
  options?: CallOptions,
) => Promise<void>;

/**
 * External payment provider: all money leaving the platform goes through this.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for the seam,
 * the Tilia adapter, and dispute webhooks.
 */
export interface Processor {
  /**
   * Submits a USD transfer to the provider. `amount` is in real USD; `key` makes the request
   * safe to retry without paying twice. The returned `providerRef` is the provider's own id for
   * the transfer — webhooks and the `payoutStatus` probe join back to the saga through it.
   */
  submitPayout(
    input: { key: string; userId: string; amount: Amount },
    options?: CallOptions,
  ): Promise<{ providerRef: string }>;

  /**
   * Optional evidence probe the sweep consults before force-failing a silent payout: FAILED or
   * RETURNED releases the reserve early, SETTLED blocks the force-fail (a lost webhook can't
   * double-pay), PENDING defers the timeout; absent, webhook plus timeout are the whole protocol.
   */
  payoutStatus?(
    input: { providerRef: string },
    options?: CallOptions,
  ): Promise<PayoutProviderStatus>;
}

/** The answer to {@link Processor.payoutStatus}; the sweep treats UNKNOWN like having no probe. */
export type PayoutProviderStatus = {
  state: 'SETTLED' | 'RETURNED' | 'FAILED' | 'PENDING' | 'UNKNOWN';
};

/**
 * The host's payee-verification directory (KYC or tax status). requestPayout consults it when
 * configured: any state other than CLEARED rejects with PAYEE_UNVERIFIED before any credits are
 * reserved, and a throwing directory faults the request — the gate fails closed. Optional in
 * {@link Ports}; absent, every payee passes.
 */
export interface PayeeDirectory {
  status(userId: string, options?: CallOptions): Promise<PayeeVerification>;
}

/**
 * The answer to {@link PayeeDirectory.status}. Only CLEARED admits a payout; PENDING, BLOCKED,
 * and NONE all reject the same way, so the distinction is for operators, not the core.
 */
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
    options?: CallOptions,
  ): Promise<Rate>;

  /** The redemption and backing rate; reconciliation values spendable credits in USD at it. */
  par(currency: Currency): Rate;

  /** The acquisition rate a user pays for credits; `topUp` values the buyer's cash at it. */
  buy(currency: Currency): Rate;
}

/**
 * An exchange rate as exact integers: the multiplier is `rate / 10^scale`. Each conversion
 * names its own rounding (a payout floors, a top-up ceils), and `rateId` names the rate a
 * transaction used.
 */
export type Rate = { rate: bigint; scale: number; rateId: string };

/**
 * Structured logging. `log` is synchronous and called on hot paths, so it must not throw and
 * should hand off rather than block. Call sites put policy facts and identifiers in `fields`,
 * never secrets (credentials live in {@link Ports.secrets}, which is never logged).
 */
export interface Logger {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>,
  ): void;
}

/**
 * Metrics. Both methods are called synchronously on the request path, so they must not throw or
 * block — buffer and ship out of band. `count` accumulates; `observe` records one point-in-time
 * sample (the core observes wall times in milliseconds and backlog gauges as row counts).
 */
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
  /**
   * Whether the ledger accepts postings against `account`: a registered platform account or any
   * well-formed user wallet. The posting guard turns a false into an UNKNOWN_ACCOUNT fault, so a
   * typo can never mint a new account and strand a balance on it.
   */
  hasAccount(account: AccountRef, options?: CallOptions): Promise<boolean>;

  /** Takes a row lock on an account so concurrent operations can't race on its balance. */
  lock(account: AccountRef, options?: CallOptions): Promise<void>;

  /**
   * Locks several accounts in one round trip, in a single deadlock-free global order; when
   * absent, callers fall back to per-account `lock` in that same order. Locks release at commit.
   */
  lockMany?(
    accounts: ReadonlyArray<AccountRef>,
    options?: CallOptions,
  ): Promise<void>;

  /**
   * Commits one posting under the caller's `txnId`: stamps `postedAt`, assigns the next commit
   * sequence, extends each leg account's hash chain, and folds each leg into the account's
   * running balance — all atomic with the enclosing {@link Store.transaction}. Callers take the
   * account locks first (`lock`/`lockMany`), so chain heads never fork.
   */
  append(posting: Posting, options?: CallOptions): Promise<Transaction>;

  /**
   * Appends several postings in one engine round trip, exactly as if `append` ran per posting
   * in order — a later posting chains onto an earlier one's new head when they share an
   * account. Optional: the hot operations that post entry pairs (topUp, settlePayout) fuse
   * through it where the engine offers it; absent, callers loop `append`.
   */
  appendAll?(
    postings: ReadonlyArray<Posting>,
    options?: CallOptions,
  ): Promise<Transaction[]>;

  /** A maintained running total: one read, not a sum over the account's whole history. */
  balance(account: AccountRef, options?: CallOptions): Promise<Amount>;

  /**
   * The account's entries whose `postedAt` falls in the half-open `range`, in commit order.
   * Each entry's amount is the leg's signed effect on the account's balance (`balanceDelta`),
   * not the raw debit-positive leg.
   */
  statement(
    account: AccountRef,
    range: Range,
    options?: CallOptions,
  ): Promise<Statement>;

  /**
   * The balance re-derived from the account's legs, one Amount per currency present (empty when
   * none), folded server-side on SQL so the prover never ships every leg over the wire.
   */
  derivedBalances(
    account: AccountRef,
    options?: CallOptions,
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
    options?: CallOptions,
  ): AsyncIterable<readonly [AccountRef, string, bigint]>;

  /**
   * Streams every account that has a cached running-balance row — such a row can exist with no
   * posting behind it, which `heads` never visits, so the prover surfaces the mismatch from here.
   */
  balanceAccounts(options?: CallOptions): AsyncIterable<AccountRef>;

  /**
   * Streams every posting that touched `account`, in commit order, with each recorded hash; the
   * prover replays these because head hashes alone cannot catch an edited line.
   * `options.sinceHash` bounds the walk to links recorded after the one carrying that head hash —
   * the incremental seal's tail read; an unknown hash streams nothing.
   */
  lineage(
    account: AccountRef,
    options?: LineageOptions,
  ): AsyncIterable<StoredLink>;

  /** The whole posting committed under `txnId`, with all its legs, or null on an unknown id. */
  posting(txnId: string, options?: CallOptions): Promise<Posting | null>;

  /**
   * The chain links the posting extended, one per touched account. `verifiedPosting`
   * (src/chain.ts) recomputes each link's hash from the posting's stored content before any
   * handler derives money from it — the read that makes an in-place edit of stored history fault
   * instead of shaping a reversal. Empty on an unknown id.
   */
  links(
    txnId: string,
    options?: CallOptions,
  ): Promise<ReadonlyArray<PostingLink>>;

  /**
   * One page of every stored chain link in commit order, with each link's posting content — the
   * rolling re-proof's read (src/worker/reproof.ts). `limit` bounds the postings visited per
   * page (a posting's links never split across pages). `cursor` is engine-internal ordering
   * state: pass null to start from the oldest posting, then the returned cursor verbatim; a
   * null returned cursor means the walk consumed the newest stored posting.
   */
  linksPage(
    cursor: number | null,
    limit: number,
    options?: CallOptions,
  ): Promise<LinkPage>;

  /**
   * Streams every committed posting with its full legs, newest first by commit sequence — a total
   * order, so ties never reorder a page.
   */
  list(options?: CallOptions): AsyncIterable<Posting>;
}

/** One account's chain link on one posting, as {@link Ledger.links} returns it. */
export type PostingLink = {
  account: AccountRef;
  prevHash: string;
  hash: string;
};

/** One {@link Ledger.linksPage} page: links with their posting content, plus the resume cursor. */
export type LinkPage = {
  links: ReadonlyArray<{ account: AccountRef } & StoredLink>;
  cursor: number | null;
};

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
  accruals: AccrualStore;
  checkpoints: CheckpointStore;
  replay: ReplayStore;

  /**
   * The session-netting journal; it commits outside money transactions, so an accepted movement
   * is durable regardless of any ledger posting's fate.
   */
  movements: MovementJournal;

  /**
   * The shared cross-node reservation counter behind multi-node netting (`sharedReservations`,
   * src/netting.ts): one row per account, `add` folds a delta in atomically and returns the
   * post-add pending total. Absent on stores that cannot host a shared counter (the HTTP edge
   * adapter); the in-process registry remains the single-node default either way.
   */
  reservations?: ReservationStore;

  /** Runs `work` in one database transaction: everything it writes commits together or not at all. */
  transaction<T>(
    work: (unit: Unit) => Promise<T>,
    options?: CallOptions,
  ): Promise<T>;

  /**
   * Submit micro-batching support, optional: commits K work items for one fsync on the clean
   * path while isolating failures per item — a failing item's slot carries its error and its
   * writes roll back alone; its batch-mates still commit. Items run sequentially, and a later
   * item can observe an earlier one's writes. How isolation is achieved is each engine's own
   * strategy. Under any strategy an item can execute more than once across attempts — always
   * fully rolled back in between — so the caller's idempotency keys make the replay
   * exactly-once. When absent, callers fall back to one transaction per item.
   */
  batchTransaction?<T>(
    works: ReadonlyArray<(unit: Unit) => Promise<T>>,
    options?: CallOptions,
  ): Promise<Array<BatchSlot<T>>>;

  /**
   * Releases the store's resources — the SQL engines end their connection pool. Terminal: no
   * call on the store is valid after it.
   */
  close(): Promise<void>;
}

/**
 * One work item's slot in a {@link Store.batchTransaction}: its return value, or the error its
 * savepoint rolled back with. The batch itself only rejects when the shared transaction cannot
 * commit at all.
 */
export type BatchSlot<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * The finished DI bag every `create*` door takes. Structural — a plain object literal with these
 * fields is a Ports; `openPorts` and `memoryPorts` build one and freeze its config and secrets
 * after mint.
 */
export type Ports = {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly digest: Digest;
  readonly signer: Signer;
  readonly processor: Processor;
  readonly rates: Rates;
  readonly pricing: FeePolicy;
  readonly logger: Logger;
  readonly meter: Meter;
  /** Policy only — log-safe; credentials ride in `secrets`. */
  readonly config: Config;
  /** Never log. */
  readonly secrets: Secrets;
  readonly cache?: Cache;
  readonly dispatcher?: Dispatcher;
  readonly payees?: PayeeDirectory;
  readonly scheduler?: Scheduler;
  readonly anchor?: Anchor;
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
  accruals: AccrualStore;
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
    options?: CallOptions,
  ): Promise<{ claimed: true } | { claimed: false; transaction: Transaction }>;

  /** Called inside the posting's transaction, so it only takes effect if the posting commits. */
  record(
    key: string,
    transaction: Transaction,
    options?: CallOptions,
  ): Promise<void>;
}

/**
 * Dedups raw inbound provider webhooks by provider event id, in a key space separate from the
 * domain {@link IdempotencyStore}. The ingress claims the id only after verifying the delivery,
 * so a forged delivery never burns it and a later genuine redelivery still processes.
 */
export interface ReplayStore {
  /** Atomically inserts `eventId` if absent; `claimed` is true only on the first sighting. */
  claim(eventId: string, options?: CallOptions): Promise<{ claimed: boolean }>;
}

/**
 * One seller share parked on a SETTLEMENT_ACCRUAL shard by a spend or subscribe under the accrual
 * split (config.accrualDrain). A positive row is a share awaiting the drain; a negative row is
 * refund-recovery debt appended when a refund reverses an already-drained share. Rows are never
 * deleted: terminal rows are the permanent per-order share record refund reads instead of the
 * sale's legs.
 */
export interface AccrualRow {
  /** The order (or, for subscription charges, the posting id) the share came from. */
  orderId: string;

  sellerId: string;

  /** Distinguishes rows of one (orderId, sellerId): 0 for the sale share, higher for recovery rows. */
  seq: number;

  /** The share in CREDIT; negative on a refund-recovery row. */
  amount: Amount;

  /** The SETTLEMENT_ACCRUAL shard the spend credited; the drain debits the same row. */
  shard: AccountRef;

  status: 'pending' | 'drained' | 'refunded';

  /**
   * The posting that created the row, immutable — refund matches an order's rows to its sale
   * posting by it, so a hostile orderId that collides with another charge's key can never pull
   * that charge's rows into a reversal.
   */
  txnId: string;

  /** The drain or refund posting that settled the row; null while pending. */
  settledTxnId: string | null;

  /** Epoch ms the row was written; the drain-lag gauge ages pending rows by it. */
  recordedAt: number;
}

/** Names one {@link AccrualRow} for the drain's and refund's terminal marks. */
export type AccrualRowKey = { orderId: string; sellerId: string; seq: number };

/**
 * The parked-share ledger behind the accrual split. `put` joins the operation's transaction; the
 * claim methods take row locks with commit-release semantics, so a row is claimed by exactly one
 * of a refund and a drain and whichever commits first flips the status the other respects.
 */
export interface AccrualStore {
  /**
   * Joins the operation's transaction. A duplicate (orderId, sellerId, seq) is a fault, never
   * an overwrite — recovery rows take fresh seqs instead.
   */
  put(rows: ReadonlyArray<AccrualRow>, options?: CallOptions): Promise<void>;

  /** Locks and returns every row of an order, any status; the refund path partitions them. */
  claimByOrder(orderId: string, options?: CallOptions): Promise<AccrualRow[]>;

  /** Distinct sellers with pending rows, up to `limit` — the drain's work list. */
  pendingSellers(limit: number, options?: CallOptions): Promise<string[]>;

  /**
   * Locks and returns up to `limit` of one seller's pending rows — positive shares first, then
   * recovery rows, each oldest first. Positives lead so a deep recovery backlog can never crowd
   * every share out of the claim window and stall the seller's drain.
   */
  claimPendingBySeller(
    sellerId: string,
    limit: number,
    options?: CallOptions,
  ): Promise<AccrualRow[]>;

  /** Flips pending rows terminal, recording the settling posting as `settledTxnId`. */
  markDrained(
    keys: ReadonlyArray<AccrualRowKey>,
    settledTxnId: string,
    options?: CallOptions,
  ): Promise<void>;

  /** Flips pending rows terminal, recording the settling posting as `settledTxnId`. */
  markRefunded(
    keys: ReadonlyArray<AccrualRowKey>,
    settledTxnId: string,
    options?: CallOptions,
  ): Promise<void>;

  /**
   * The pending backlog: the positive pending rows' total (equal to the ACCRUAL shards' summed
   * balance at any quiescent point — the prover check) and the oldest pending row's age.
   */
  stats(
    options?: CallOptions,
  ): Promise<{ pendingMinor: bigint; oldestPendingAgeMs: number | null }>;

  /**
   * The seller's pending rows summed, negatives included. Negative means refund debt the drain
   * has not yet recovered; payout admission subtracts it from payable earned credit.
   */
  netPending(sellerId: string, options?: CallOptions): Promise<bigint>;
}

/** Stores the summary of each completed sale, keyed by order id (a separate key from the idempotency key). */
export interface SaleStore {
  /**
   * Upserts by `sale.orderId`. Called inside the charge's transaction, so a rolled-back sale
   * leaves no row.
   */
  put(sale: Sale, options?: CallOptions): Promise<void>;

  get(orderId: string, options?: CallOptions): Promise<Sale | null>;
}

/**
 * A transactional outbox: events save in the same database transaction as the money move, so an
 * event is never sent for a rolled-back move nor lost for a committed one.
 */
export interface OutboxStore {
  /** Saves an event to send later. Called inside the posting's transaction. */
  enqueue(message: OutboxMessage, options?: CallOptions): Promise<void>;

  /**
   * Grabs up to `limit` pending messages, each locked so a concurrent relay picks different ones.
   * A 'relayed' or 'dead' row is terminal and never re-claimed.
   */
  claimBatch(
    limit: number,
    options?: CallOptions,
  ): Promise<ReadonlyArray<OutboxMessage>>;

  /** Delivery may still double-send, so the consumer drops duplicates by message id. */
  markRelayed(ids: ReadonlyArray<string>, options?: CallOptions): Promise<void>;

  /** Bumps `attempts` and leaves the row 'pending'; only `deadLetter` may flip the status. */
  recordFailure(id: string, options?: CallOptions): Promise<void>;

  /**
   * Sets status 'dead' so `claimBatch` never returns it again, recording `reason` for operators;
   * a non-existent or already-terminal row is left untouched.
   */
  deadLetter(id: string, reason: string, options?: CallOptions): Promise<void>;

  /**
   * A read-only gauge of the pending backlog: how many rows wait and how old the oldest is.
   * Age is computed on the store's own time base, so an app/database clock skew never distorts
   * it. The relay sweep observes this each run — a backlog that only grows means the relay is
   * down or the events are poisoned.
   */
  stats(options?: CallOptions): Promise<OutboxStats>;
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
  enqueueInbound(
    entry: InboxMessage,
    options?: CallOptions,
  ): Promise<InboxMessage>;

  /**
   * Grabs up to `limit` pending rows oldest-first, each locked so a concurrent worker picks
   * different ones. An 'applied' or 'dead' row is terminal and never re-claimed.
   */
  claimInbound(
    input: { now: number; limit: number },
    options?: CallOptions,
  ): Promise<ReadonlyArray<InboxMessage>>;

  /**
   * Called inside the apply's transaction, so a rolled-back apply leaves the row 'pending'; a
   * non-existent or already-terminal row is left untouched.
   */
  markApplied(id: string, options?: CallOptions): Promise<void>;

  /**
   * Bumps `attempts` and leaves the row 'pending'; only `deadLetter` may flip the status. A
   * non-existent row is left untouched.
   */
  bumpAttempt(id: string, options?: CallOptions): Promise<void>;

  /**
   * Sets status 'dead' so `claimInbound` never returns it again, recording `reason` for
   * operators; a non-existent or already-terminal row is left untouched.
   */
  deadLetter(id: string, reason: string, options?: CallOptions): Promise<void>;

  /**
   * Flips up to `limit` oldest 'dead' rows back to 'pending', resetting `attempts` to 0 and
   * clearing `reason`, and returns the revived rows. 'applied' rows never revive. Only queue
   * state changes, never the ledger: a revived row still applies through the normal drain under
   * its idempotency key, so a wrong revive costs work, not money.
   */
  reviveDead(
    limit: number,
    options?: CallOptions,
  ): Promise<ReadonlyArray<InboxMessage>>;
}

/**
 * Tracks each multi-step payout (a "saga") as it moves through its states. A background
 * sweep picks up sagas that are due and pushes each one to its next state.
 */
export interface SagaStore {
  /**
   * Upserts by `saga.id`. Called inside requestPayout's transaction with the reserve posting,
   * so an open saga without its reserve never survives.
   */
  open(saga: Saga, options?: CallOptions): Promise<void>;

  load(id: string, options?: CallOptions): Promise<Saga | null>;

  /** If more than one saga ever carried this provider reference, the newest `updatedAt` wins. */
  findByProviderRef(
    providerRef: string,
    options?: CallOptions,
  ): Promise<Saga | null>;

  /**
   * Every saga newest `updatedAt` first; ties on `updatedAt` break by `id` descending.
   * `states` narrows to exactly those states (an empty list yields nothing); the SQL engines
   * push the filter down.
   */
  list(
    options?: CallOptions & { states?: readonly SagaState[] },
  ): AsyncIterable<Saga>;

  /**
   * Grabs up to `limit` due sagas, each locked so concurrent sweeps take different ones. Only
   * RESERVED and SUBMITTED rows are candidates: a row still REQUESTED means its opening
   * transaction crashed partway, and the sweep skips it on purpose.
   */
  claimDue(
    now: number,
    limit: number,
    options?: CallOptions,
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
    options?: CallOptions,
  ): Promise<boolean>;

  /**
   * Sets the saga FAILED and records `reason`, whatever state it held — no compare-and-set, and
   * no posting. This is the operator door (exposed over the HTTP store adapter); the payout
   * sweep fails a saga via `advance` paired with the reserve-release posting in one transaction.
   * An unknown id changes nothing.
   */
  deadLetter(id: string, reason: string, options?: CallOptions): Promise<void>;

  /**
   * The max `updatedAt` over all of the user's sagas in any state, enforcing
   * config.payoutMinIntervalMs. `updatedAt` only advances, so the max never undershoots the
   * latest request; null when the user has no sagas, so a first request is always allowed.
   */
  lastPayoutAt(userId: string, options?: CallOptions): Promise<number | null>;
}

/** Tracks which users own which items or features (entitlements), keyed by SKU (the product code). */
export interface EntitlementStore {
  /**
   * Upserts (userId, sku): re-granting overwrites the attributes and clears an earlier revoke,
   * so re-buying after a refund restores ownership. Called inside the charge's transaction, so a
   * rolled-back purchase grants nothing.
   */
  grant(
    userId: string,
    sku: string,
    attrs: EntitlementAttributes,
    options?: CallOptions,
  ): Promise<void>;

  /**
   * Marks the grant revoked: `owns` turns false and `list` stops streaming it. An unknown or
   * already-revoked (userId, sku) changes nothing, and a later grant of the same sku restores
   * ownership.
   */
  revoke(userId: string, sku: string, options?: CallOptions): Promise<void>;

  /**
   * True while a non-revoked grant exists whose `expiresAt` is null or at/after the current
   * clock (the expiry check is inclusive).
   */
  owns(userId: string, sku: string, options?: CallOptions): Promise<boolean>;

  /**
   * Streams every non-revoked grant for the user, expired ones included, sorted by sku. Each row
   * carries the expiry `owns` applies at read time (null never lapses), so a caller can reproduce
   * the ownership decision.
   */
  list(userId: string, options?: CallOptions): AsyncIterable<EntitlementGrant>;
}

export interface EntitlementGrant {
  sku: string;

  /** Epoch ms the grant lapses (owned while now <= expiresAt), or null for a perpetual grant. */
  expiresAt: number | null;
}

/** Tracks recurring subscriptions and when each is next due to bill. */
export interface SubscriptionStore {
  /**
   * Upserts by `sub.id`. Called inside subscribe's first-charge transaction, so an open
   * subscription without its anchor posting never survives.
   */
  open(sub: Subscription, options?: CallOptions): Promise<void>;

  load(id: string, options?: CallOptions): Promise<Subscription | null>;

  /**
   * The one ACTIVE subscription for this (userId, sku, sellerId), or null; subscribe uses it to
   * refuse a second active subscription, which would double-bill.
   */
  activeFor(
    userId: string,
    sku: string,
    sellerId: string,
    options?: CallOptions,
  ): Promise<Subscription | null>;

  /**
   * Sets the row CANCELED whatever state it held; an unknown id changes nothing. Terminal: a
   * canceled subscription never claims due again.
   */
  cancel(id: string, options?: CallOptions): Promise<void>;

  /** Finds up to `limit` subscriptions whose next charge is due, for the renewal sweep. */
  claimDue(
    now: number,
    limit: number,
    options?: CallOptions,
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
    options?: CallOptions,
  ): Promise<boolean>;

  /**
   * Marks a subscription LAPSED because a renewal couldn't be paid — distinct from a
   * user-requested cancel; either way the sweep stops re-billing it.
   */
  markLapsed(id: string, options?: CallOptions): Promise<void>;
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
  open(grant: PromoGrant, options?: CallOptions): Promise<void>;

  /**
   * Grabs up to `limit` expired (`expiresAt <= now`), not-yet-reversed grants, oldest `expiresAt`
   * first; a reversed grant is never handed back, so a grant is reversed at most once across sweeps.
   */
  claimDue(
    now: number,
    limit: number,
    options?: CallOptions,
  ): Promise<ReadonlyArray<PromoGrant>>;

  /**
   * Marks a grant reversed so `claimDue` never returns it again; a missing or already-reversed
   * row is a no-op, so re-running the sweep is harmless.
   */
  markReversed(id: string, options?: CallOptions): Promise<void>;
}

/**
 * Tracks how much each subject has spent recently — the risk gate's input. Two views: the
 * store-level instance commits on its own connection, the {@link Unit} view writes inside the
 * money transaction, so every attempt is counted exactly once whether its operation commits or
 * rolls back.
 */
export interface TrustStore {
  /**
   * The subject's velocity over the trailing window ending now; attempts age out as the window
   * slides, with no fixed reset boundary. A subject with no live attempts reads as zero spent
   * and zero attempts, so new subjects need no seeding.
   */
  read(subject: string, options?: CallOptions): Promise<Velocity>;

  /** Idempotent on `attempt.idempotencyKey`, so a genuine retry doesn't double-count. */
  bump(subject: string, attempt: Attempt, options?: CallOptions): Promise<void>;

  /**
   * Records the attempt (idempotent on `attempt.idempotencyKey`) and returns the subject's
   * windowed velocity including it, in one atomic step serialized per subject — record-and-measure
   * must be one step (the velocity-limit TOCTOU; see screenRisk in economy.ts).
   */
  record(
    subject: string,
    attempt: Attempt,
    options?: CallOptions,
  ): Promise<Velocity>;
}

/** Bounds a {@link Ledger.lineage} walk; see the method for `sinceHash` semantics. */
export type LineageOptions = CallOptions & { sinceHash?: string };
/**
 * One sealed leaf `(account, head hash at seal, raw signed leg sum at seal)` — exactly a
 * {@link Ledger.headSums} row frozen at seal time. These are the leaves the sealed checkpoint's
 * Merkle root was built over, which is what makes a stored snapshot verifiable: re-derive the
 * root and check it against the already-signed checkpoint.
 */
export type SealHead = readonly [AccountRef, string, bigint];
/** Stores signed ledger snapshots. Written only by the background worker. */
export interface CheckpointStore {
  /**
   * Appends a sealed checkpoint. Runs outside any money transaction, so no rollback can delete
   * a recorded seal.
   */
  put(checkpoint: Checkpoint, options?: CallOptions): Promise<void>;

  /** The most recently written checkpoint, or null before the first seal. */
  latest(options?: CallOptions): Promise<Checkpoint | null>;
  /**
   * Optional incremental-seal snapshot: upserts leaves into the one-row-per-account sealed-head
   * table. The seal writes only the accounts that changed, so the table always mirrors the
   * latest checkpoint's full leaf set at O(dirty) cost. With `replaceAll`, rows absent from
   * `leaves` are removed first — the full-replay seal's rewrite, which purges any stray row a
   * corruption left behind so the fast path can return. Absent (with `sealHeads`), every seal
   * re-proves the whole chain.
   */
  putSealHeads?(
    leaves: ReadonlyArray<SealHead>,
    options?: CallOptions & { replaceAll?: boolean },
  ): Promise<void>;
  /** Every stored sealed head; empty before the first snapshotting seal. */
  sealHeads?(options?: CallOptions): Promise<ReadonlyArray<SealHead>>;
  /**
   * Optional rolling re-proof state (src/worker/reproof.ts): where the link walk stands and when
   * the last full rotation completed — the verified-through watermark that makes "how much of
   * stored history has been re-hashed, and how recently" a queryable fact instead of an
   * assumption. Null before the first sweep. Absent (with `putReproof`), the sweep is a no-op.
   */
  reproof?(options?: CallOptions): Promise<Reproof | null>;
  /** The write half of {@link CheckpointStore.reproof}: replaces the stored state whole. */
  putReproof?(state: Reproof, options?: CallOptions): Promise<void>;
}

/**
 * The rolling re-proof's persisted state. `cursor` is {@link Ledger.linksPage}'s resume token
 * (null between rotations); `rotatedAt` is when the last complete pass over every stored link
 * finished (null until the first completes). Every link recorded before `rotatedAt` has had its
 * hash re-derived from stored content since then; younger links are vouched by seals and balance
 * checks only — that boundary is the honest verification horizon.
 */
export type Reproof = {
  cursor: number | null;
  rotatedAt: number | null;
};
/**
 * Publishes a sealed checkpoint to a store outside the ledger's own database — an external log,
 * object store, or transparency service. The checkpoint table lives in the same database an
 * attacker who can rewrite the ledger controls, so only an externally anchored root proves
 * history against that attacker. Best-effort: the seal logs a failed publish and never blocks
 * on it.
 */
export interface Anchor {
  publish(checkpoint: Checkpoint, options?: CallOptions): Promise<void>;
}

/**
 * One accepted session movement: a balanced set of legs not yet posted to the ledger, made
 * ledger-final at settle. Sessions are economy-tier objects keyed by an opaque scope (a
 * game-world instance is one natural key; see src/netting.ts for the tier boundary).
 * `prevHash`/`hash` chain the session's movements and the settlement posting anchors the final
 * head, so tamper-evidence extends to every movement.
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
 * The append-only session-netting journal. A batch commits in one transaction (one fsync for N
 * movements), and journal rows carry no locks, chain links, or balance updates. A duplicate
 * idempotency key or (sessionId, seq) rejects the batch; the session splits and retries around
 * the poison row.
 */
export interface MovementJournal {
  append(
    movements: ReadonlyArray<Movement>,
    options?: CallOptions,
  ): Promise<void>;

  /** Streams a session's movements in seq order — the source of truth settle derives from. */
  bySession(sessionId: string, options?: CallOptions): AsyncIterable<Movement>;
}

/**
 * The shared cross-node reservation counter: one pending total per account, folded atomically.
 * `add` returns the post-add total, so accept screens are add-then-check — a concurrent add on
 * another node is either already in the returned total or arrives later and sees ours; totals
 * only drift conservative (at-or-after our add). Fail-closed by construction: an unreachable
 * counter throws, and the caller refuses the movement rather than accepting blind.
 */
export interface ReservationStore {
  /**
   * Folds `naturalDelta` — the movement leg's signed effect on the account's balance in minor
   * units (`balanceDelta`; a spend adds a negative delta) — into the account's pending total and
   * returns the post-add total. Atomic per account: two nodes adding concurrently both see a
   * total that includes at least their own delta.
   */
  add(
    account: AccountRef,
    naturalDelta: bigint,
    options?: CallOptions,
  ): Promise<bigint>;

  /** The account's current net pending total; 0n for an account with no row. */
  pending(account: AccountRef, options?: CallOptions): Promise<bigint>;

  /**
   * Streams every counter row — what `reconcileReservations` (src/worker/orphans.ts) walks to
   * repair leaked pending against the journal-derived truth during quiesced maintenance.
   */
  entries(options?: CallOptions): AsyncIterable<[AccountRef, bigint]>;
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

  /**
   * Correlation id of the request that enqueued this event, or null for worker-born events.
   * Transport provenance lives here because the relay reads the envelope in another process;
   * domain facts about the posting stay in its meta.
   */
  correlationId: string | null;
}

/** One stored inbox row: a verified inbound event mapped to the operation it applies (see InboxStore). */
export interface InboxMessage {
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
/** One of the payout saga's states, the union {@link SAGA_STATES} enumerates in lifecycle order. */
export type SagaState = (typeof SAGA_STATES)[number];

/** The stored state of one in-flight payout. */
export interface Saga {
  id: string;

  userId: string;

  /** The seller's earned credits, held in the payout-reserve account while this is in flight. */
  reserve: Amount;

  /** Names the exact CREDIT-to-USD rate this payout is locked to. */
  rateId: string;

  /**
   * The reserve posting this saga opened with — the anchor every money-moving step re-proves
   * before trusting a byte of this row: the posting's hashed metadata seals the saga id, rate,
   * and USD quote, and its earned-debit leg seals the reserve. Required, because the saga row is
   * unhashed and drives real USD out of the platform.
   */
  txnId: string;

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
   * The gross USD this payout disburses, priced once by requestPayout at the locked rate; the
   * worker submits it to the rail and settlePayout posts it out of trust unchanged. Null only
   * on rows opened before pricing-at-request, which convert at the current rate instead.
   */
  payoutUsd: Amount | null;
}

/**
 * The subscription lifecycle states. ACTIVE rows bill each period; CANCELED records a
 * user-requested stop and LAPSED an unpayable renewal at the attempt cap — both terminal, and
 * the renewal sweep claims neither.
 */
export const SUBSCRIPTION_STATES = ['ACTIVE', 'LAPSED', 'CANCELED'] as const;
/** One of the subscription lifecycle states {@link SUBSCRIPTION_STATES} enumerates. */
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/**
 * The stored state of one recurring subscription. The renewal sweep re-charges it every
 * `periodMs` from `nextDueAt` until it cancels or lapses.
 */
export interface Subscription {
  id: string;

  userId: string;
  sellerId: string;
  sku: string;

  /** What each renewal charges. */
  price: Amount;

  /**
   * The first-charge posting this subscription opened with, whose hashed metadata seals the
   * subscription id, user, seller, and price — the renewal sweep re-proves the row against it
   * before every charge, and a row that fails that proof faults instead of charging. Required,
   * because a nullable anchor would be an anchor the attacker can remove.
   */
  txnId: string;

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

  at: number;

  /**
   * How the operation resolved. Rejected attempts are recorded too and their amounts count
   * toward the window's `spent` — a burst of denials is itself a fraud signal.
   */
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

  /**
   * Identifier of the signing key that sealed this row ({@link Signer.kid}), or null on rows
   * from before kid stamping or from a signer without one. Audit metadata, not part of the
   * signed preimage: tampering with it only makes the row's signature fail to verify under the
   * named key, and verification still tries every configured key regardless.
   */
  kid: string | null;
}

/** A statement query's time range, in epoch milliseconds. Half-open: `from` is included, `to` is not. */
export interface Range {
  from: number;
  to: number;
}

/** One page of an account's entries. Paging is by narrowing the `Range`, window by window. */
export interface Statement {
  account: AccountRef;

  /**
   * In commit order; each amount is the leg's signed effect on the account's balance
   * (`balanceDelta`), not the raw debit-positive leg.
   */
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
