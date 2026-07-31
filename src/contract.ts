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

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { ChainBreak } from '#src/chain.ts';
import type {
  Anchor,
  Cache,
  Checkpoint,
  Clock,
  Digest,
  Ids,
  Leg,
  Logger,
  Meter,
  CallOptions,
  EntitlementGrant,
  PayeeDirectory,
  CatalogPort,
  Posting,
  Processor,
  Range,
  Rates,
  Saga,
  SagaState,
  Signer,
  Statement,
  StoredLink,
  Subscription,
  Unit,
  Ports,
} from '#src/ports.ts';
import { checkedConfig } from '#src/config.ts';

import type { CheckedConfig } from '#src/config.ts';

/** Optional details on an entitlement grant (a user owning an item or feature). */
export type EntitlementAttributes = {
  /** How many units the grant confers. When present it is a positive integer, validated at submit. */
  quantity?: number;

  /** The grant's version, for hosts that version their item definitions. */
  version?: number;

  /** When the entitlement lapses, in epoch milliseconds; null (or absent) means it never expires. */
  expiresAt?: number | null;

  /** Where the grant came from (a promotion, a bundle), recorded on the grant for the audit trail. */
  source?: string;
};

/**
 * Who is making a request, and what they are allowed to do.
 *
 * There are three kinds. A `user` may act only on their own accounts. A `system` service is a
 * trusted internal caller acting on the platform's behalf, and its writes keep working through a
 * maintenance pause. An `operator` is a human running a manual, fully-audited action — the only
 * kind allowed to run `adjust` and `reverse`.
 *
 * Build one with `userActor`, `systemActor`, or `operatorActor` rather than hand-writing the
 * tagged union.
 */
export type Principal =
  // An end user (id looks like usr_<uuid>). May only act on their own accounts.
  | { kind: 'user'; userId: string }
  // A trusted internal service calling on behalf of the platform.
  | { kind: 'system'; service: string }
  // A human operator running a manual, fully-audited action.
  | { kind: 'operator'; operatorId: string };

/**
 * One party who gets a cut of a sale. The platform's fee comes off the top (`platformFeeBps`).
 * `shareBps` is each recipient's basis points of the post-fee net (100 bps = 1%), and the shares
 * must sum to exactly 10,000 — the platform never keeps an unclaimed remainder.
 */
export type Recipient = {
  /** The seller this share belongs to; the sale credits their earned wallet. */
  sellerId: string;
  /** This recipient's basis points of the post-fee net (100 bps = 1%); all shares sum to 10,000. */
  shareBps: number;
};

/**
 * Every request a caller can submit. Each variant is one action tagged by `kind`, carrying an
 * `idempotencyKey` (a retried request runs at most once) and an `actor` (who is asking).
 */
export type Operation =
  | {
      kind: 'topUp';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      amount: Amount;
      source: string;
    }
  | {
      kind: 'spend';
      idempotencyKey: string;
      actor: Principal;
      orderId: string;
      buyerId: string;
      sku: string;
      price: Amount;
      recipients: Recipient[];
      ageRestricted?: boolean;
      /**
       * This marks a gift. The buyer pays and is screened as usual, but the SKU is granted to
       * this user id. No wallet-to-wallet credit or ownership transfer happens. Omitted (or equal
       * to `buyerId`) for a self-purchase.
       */
      giftTo?: string;
    }
  | {
      kind: 'refund';
      idempotencyKey: string;
      actor: Principal;
      orderId: string;
      reason?: string;
    }
  | {
      kind: 'clawback';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      amount: Amount;
      orderId?: string;
      key?: string;
      reason?: string;
    }
  | {
      kind: 'requestPayout';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      /**
       * amount is the seller's earned credits. It is set aside in the payout-reserve account
       * and ultimately paid out to them as real USD.
       */
      amount: Amount;
    }
  | {
      kind: 'subscribe';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      sellerId: string;
      sku: string;
      price: Amount;
      periodMs: number;
      // No `ageRestricted` field: age-gating is spend-only (see the spend variant).
    }
  | {
      kind: 'cancelSubscription';
      idempotencyKey: string;
      actor: Principal;
      subscriptionId: string;
    }
  | {
      kind: 'grantEntitlement';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      sku: string;
      attrs?: EntitlementAttributes;
    }
  | {
      kind: 'revokeEntitlement';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      sku: string;
      reason?: string;
    }
  | {
      kind: 'grantPromo';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      amount: Amount;
      expiresAt: number;
    }
  // A manual correction an operator posts by hand; ordinary users can't run it. The offsetting
  // entry goes to the opening-equity account so the books still balance.
  | {
      kind: 'adjust';
      idempotencyKey: string;
      actor: Principal;
      account: AccountRef;
      amount: Amount;
      reason: string;
    }
  // A manual undo an operator runs by hand; ordinary users can't run it. It posts the exact
  // opposite of the transaction named by txnId, canceling it out.
  | {
      kind: 'reverse';
      idempotencyKey: string;
      actor: Principal;
      txnId: string;
      reason: string;
    }
  // A privileged correction that undoes a not-yet-paid payout: an operator's manual undo, or the
  // verified payout-failed webhook's prompt reversal. It marks the saga FAILED and returns the
  // set-aside credits to the seller's earned account, but only if the payout is still pre-paid,
  // so two attempts can't both undo it. A payout that already disbursed real USD is refused.
  // `userId` names the seller (which account to lock). The operation is otherwise identified
  // only by sagaId.
  | {
      kind: 'reversePayout';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      sagaId: string;
      reason: string;
      /**
       * Server-set, and the wire contract does not carry it: a request body naming it answers
       * `OP.MALFORMED`. Only the verified payoutFailed webhook sets it, waiving the still-live
       * SUBMITTED refusal — the rail has said it will not settle, so returning the reserve
       * promptly cannot double-pay. An operator's manual reverse leaves it unset and stays gated
       * until the payout ages past `maxPayoutAgeMs`.
       */
      providerReported?: boolean;
    }
  // System- or operator-only (RESTRICTED_TO_PRIVILEGED in economy.ts). This is the SUBMITTED ->
  // SETTLED step that empties the seller's reserve into REVENUE and moves gross USD out of
  // trust. An end user must never settle their own payout. The operation is named only by
  // `sagaId`, and its postings touch platform accounts only.
  | {
      kind: 'settlePayout';
      idempotencyKey: string;
      actor: Principal;
      sagaId: string;
      /**
       * The provider's settlement reference for this payout (the rail's own id for the
       * disbursement), recorded for the audit trail. Carried from the inbound provider webhook that
       * drives the settle.
       */
      providerRef: string;
      /**
       * The USD amount the provider reported settling. It is recorded for audit/reconciliation
       * only. The figures actually posted are the rate-derived ones settlePayout computes (gross
       * USD from the reserve at the payout rate, less the rail fee), so the provider's report
       * never sets the posted amount. Absent when the rail's callback carries no figure (Tilia's
       * does not). The reconcile feed still checks amounts against the rail's settlement report.
       */
      providerAmount?: Amount;
    };

/**
 * Structured context on a rejection, discriminated by `reason` — each arm carries exactly the
 * fields that decline needs. Money fields are branded {@link Amount}s a caller can compare
 * directly (the HTTP service encodes them to decimal strings on the wire); times are epoch
 * milliseconds.
 */
export type RejectionDetail =
  | {
      readonly reason: 'INSUFFICIENT_FUNDS';
      readonly account: AccountRef;
      readonly need: Amount;
      readonly have: Amount;
    }
  | {
      readonly reason: 'FUNDS_IMMATURE';
      readonly source: string;
      readonly availableAt: number;
    }
  | {
      readonly reason: 'RISK_DENIED';
      readonly window: 'inflow' | 'outflow' | 'both';
      readonly limitMinor: bigint;
    }
  | { readonly reason: 'DUPLICATE_ORDER'; readonly orderId: string }
  | { readonly reason: 'UNKNOWN_ORDER'; readonly orderId: string }
  | {
      readonly reason: 'NOT_ENTITLED';
      readonly userId: string;
      readonly sku: string;
    }
  | {
      readonly reason: 'UNKNOWN_SUBSCRIPTION';
      readonly subscriptionId: string;
    }
  | {
      readonly reason: 'ALREADY_SUBSCRIBED';
      readonly userId: string;
      readonly sku: string;
    }
  | {
      readonly reason: 'BELOW_MINIMUM';
      readonly minimum: Amount;
      readonly amount: Amount;
    }
  | { readonly reason: 'PAYOUT_TOO_SOON'; readonly retryAt: number }
  | { readonly reason: 'PAYEE_UNVERIFIED'; readonly userId: string }
  | {
      readonly reason: 'ECONOMY_PAUSED';
      readonly resumesAt: number | null;
    }
  | {
      readonly reason: 'CATALOG_MISMATCH';
      readonly sku: string;
      /** Which part of the spend disagreed with the host catalog's offer. */
      readonly field: 'sku' | 'price' | 'recipients';
    };

/**
 * The result of submitting an operation: `committed`, `duplicate` (a repeat, earlier result
 * returned unchanged), or `rejected`.
 *
 * A rejection is a normal "no" returned as data; a genuine fault is thrown instead. The rejected
 * arm's sole discriminant is `detail.reason`. The HTTP wire additionally carries a derived
 * top-level `reason` for client stability.
 */
export type Outcome =
  | { readonly status: 'committed'; readonly transaction: Transaction }
  | { readonly status: 'duplicate'; readonly transaction: Transaction }
  | { readonly status: 'rejected'; readonly detail: RejectionDetail };

/**
 * One operation's slot in a {@link Economy.submitBatch} result, index-aligned with the input.
 * `ok: true` carries what `submit` would have returned. `ok: false` carries what `submit` would
 * have thrown. A fault never poisons its batch-mates; it comes back as data.
 */
export type BatchOutcome =
  | { readonly ok: true; readonly outcome: Outcome }
  | { readonly ok: false; readonly error: unknown };

/** The two outcomes that carry a committed transaction; `duplicate` is a success replayed. */
export type Success = Extract<Outcome, { status: 'committed' | 'duplicate' }>;

/** The outcome arm for a normal decline; its context rides in `detail`, discriminated by `detail.reason`. */
export type Rejection = Extract<Outcome, { status: 'rejected' }>;

/** A committed posting: the record of money that actually moved. */
export interface Transaction {
  /** Of the form txn_<uuid>. */
  id: string;

  /** When it committed, in epoch milliseconds. */
  postedAt: number;

  /**
   * The individual debit and credit lines that posted. A refund reverses exactly these.
   *
   * Amounts are debit-positive — the ledger's sign, not the account holder's, so a top-up's
   * wallet leg is negative. `balanceDelta` (from `/store-kit`) converts a leg to the signed
   * change in that account's balance.
   *
   * The array may be empty: a committed lifecycle operation (e.g. `cancelSubscription`) posts a
   * marker that moves no money.
   */
  legs: ReadonlyArray<{ account: AccountRef; amount: Amount }>;

  /**
   * For each account this transaction touched, how its tamper-evident hash chain advanced:
   * prevHash was that account's latest hash before this posting, hash is the one after.
   */
  links: ReadonlyArray<{ account: AccountRef; prevHash: string; hash: string }>;

  /**
   * The posting's metadata, as the handler recorded it: the operation `kind` plus kind-specific
   * fields. A `requestPayout` carries the opened saga's `sagaId`, so the caller can follow its
   * payout without scanning `read.payouts()`. Empty for a lifecycle marker that posted nothing.
   */
  meta: Record<string, unknown>;
}

/** The bundle of external capabilities a handler is given while processing one operation. */
export type Ctx = {
  clock: Clock;
  ids: Ids;
  digest: Digest;
  signer: Signer;
  processor: Processor;
  /** Bounds-checked: only `checkedConfig` mints one, so no door can hand a handler an unchecked
   *  knob. */
  config: CheckedConfig;
  pricing: FeePolicy;
  rates: Rates;
  logger: Logger;
  meter: Meter;
  /**
   * Optional read-through balance cache. Present only when a cache capability was injected.
   * When absent, every balance read goes straight to the ledger.
   */
  cache?: Cache;
  payees?: PayeeDirectory;
  /**
   * The host's listing store. Present makes a spend's price and split answerable against the
   * offer; absent leaves pricing the host's own concern.
   */
  catalog?: CatalogPort;
};

/**
 * Ports for the background worker. Payout settlement and periodic checkpoint jobs run on
 * their own schedule rather than inside a caller's submit, so they get their own bundle. Includes
 * `rates` because settling a payout converts credits to USD.
 */
export type WorkerCtx = {
  clock: Clock;
  ids: Ids;
  digest: Digest;
  signer: Signer;
  processor: Processor;
  rates: Rates;
  logger: Logger;
  meter: Meter;
  /** Bounds-checked, as {@link Ctx.config} is: the sweeps post too. */
  config: CheckedConfig;

  /** When present, every sealed checkpoint is also published to this external anchor. */
  anchor?: Anchor;
};

/**
 * A {@link Ports} whose config has cleared the bounds check, so it also satisfies
 * {@link WorkerCtx}. The worker's entry points take a plain `Ports` from the host and hand this
 * down, so one check at the door covers every job behind it.
 */
export type CheckedPorts = Omit<Ports, 'config'> & {
  readonly config: CheckedConfig;
};

/** Checks a host's `Ports` bag on the way into a worker entry point. */
export function checkedPorts(ports: Ports): CheckedPorts {
  return { ...ports, config: checkedConfig(ports.config) };
}

/** A function that processes one operation, given an open transaction and its capabilities. */
export type Handler = (
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
) => Promise<Outcome>;

/**
 * Splits a sale's `price` across recipients and the platform into the debit/credit lines (legs) to
 * post, accounting for every minor unit with no rounding loss. Implemented in `pricing.ts`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/pricing/ Pricing} for the fee-off-the-top,
 * rounded-down shares, and leftover-penny-to-revenue split.
 */
export type FeePolicy = (input: {
  price: Amount;
  recipients: ReadonlyArray<Recipient>;
  feeBps: number;
  buyerId?: string;
  sku?: string;
}) => ReadonlyArray<Leg>;

/**
 * The economy's pause state at a moment in time, derived from the configured maintenance window
 * and the clock.
 *
 * `maintenanceActive` is true only inside the window — distinct from the worker's own
 * `sweepsPaused`. `pauseStart` and `pauseEnd` are the configured bounds in epoch ms, or null when
 * no window is set. `resumesAt` is `pauseEnd` while paused, else null.
 *
 * This is the readable side of the ECONOMY_PAUSED gate: a UI reads it to show a banner without
 * inferring the state from a declined write.
 */
export type EconomyStatus = {
  readonly maintenanceActive: boolean;
  readonly pauseStart: number | null;
  readonly pauseEnd: number | null;
  readonly resumesAt: number | null;
};

/**
 * The capacity gauges behind the scale knobs, read live from the store. Every `null` means the
 * store does not offer that gauge. `advisories` are stated facts against
 * {@link CAPACITY_THRESHOLDS} (documented, not configurable per call): the system informs, the
 * host decides. No advisory ever changes behavior.
 */
export type CapacityReport = {
  /** Total postings (newest commit sequence) — the partitioning/archival signal. */
  readonly historySize: number | null;

  /** Rolling re-proof: the verified-through watermark and its age. Null before the first rotation. */
  readonly reproof: {
    readonly rotatedAt: number | null;
    readonly ageMs: number | null;
  };

  /** Latest sealed checkpoint: when, how many account heads, and its age. */
  readonly checkpoint: {
    readonly at: number | null;
    readonly count: number | null;
    readonly ageMs: number | null;
  };

  /** Accrual drain backlog: pending total (minor units, encoded) and oldest row age. */
  readonly accruals: {
    readonly pendingMinor: string;
    readonly oldestPendingAgeMs: number | null;
  };

  /** Netting journal footprint: distinct session ids, counted up to the cap (null = no gauge). */
  readonly sessions: {
    readonly count: number | null;
    readonly capped: boolean;
  };

  /** Shared reservation counter footprint: accounts with a row (null = no shared counter). */
  readonly reservations: {
    readonly accounts: number | null;
    readonly capped: boolean;
  };

  /**
   * Secondary-table row counts. Every value is null when the store offers no size gauge. These
   * are the unbounded growth surfaces the retention sweep and host policy govern.
   */
  readonly tables: {
    readonly movements: number | null;
    readonly idempotency: number | null;
    readonly sales: number | null;
    readonly outbox: number | null;
    readonly sagas: number | null;
    readonly accruals: number | null;
    readonly entitlements: number | null;
  };

  /** Stated facts (never actions) the thresholds below produced from the gauges. */
  readonly advisories: ReadonlyArray<string>;
};

/**
 * The documented crossover thresholds {@link CapacityReport.advisories} states facts against.
 * Crossing one changes nothing by itself. It is the signal to activate the corresponding knob
 * (partitioning DDL, archival mover, drain cadence, orphan sweep).
 */
export const CAPACITY_THRESHOLDS = {
  /** History size where partitioned DDL / the archival mover earn their provisioning cost. */
  historySizePostings: 10_000_000,
  /** A re-proof watermark older than this means rotation lags the coverage story. */
  reproofMaxAgeMs: 24 * 60 * 60_000,
  /** A sealed checkpoint older than this means the seal cadence stalled. */
  checkpointMaxAgeMs: 60 * 60_000,
  /** An accrual row pending longer than this means the drain lags its backlog. */
  accrualMaxPendingAgeMs: 60 * 60_000,
  /**
   * Secondary-table rows where growth needs a retention answer: the retention sweep's horizons
   * where one exists, a host policy where none does.
   */
  tableRows: 10_000_000,
  /** Gauge walks stop counting here; a capped count reports `>= cap`, never a made-up total. */
  enumerationCap: 10_000,
} as const;

/**
 * Public surface of a running economy: submit operations that change money, read balances and
 * statements, run the integrity check, shut down. Built by `createEconomy` in `economy.ts`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for the
 * submit/read/close surface and its construction.
 */
export interface Economy {
  /**
   * Runs one operation through the full pipeline: validate, authorize, then one all-or-nothing
   * transaction that claims the idempotency key, screens risk and funds, posts the legs, and
   * queues the outbound event.
   *
   * Resolves `committed`, `duplicate` (the idempotency key was seen before — the original
   * transaction returns unchanged, nothing posts twice), or `rejected` (a normal decline
   * returned as data). A genuine fault throws an `EconomyError` instead.
   *
   * A rejected operation commits nothing and leaves its idempotency key unclaimed — a
   * corrected retry under the same key can still succeed.
   *
   * @example
   * const outcome = await economy.submit(spend({
   *   idempotencyKey: idempotencyKey('order', 'ord_8821'),
   *   actor: userActor('usr_buyer'),
   *   orderId: 'ord_8821',
   *   buyerId: 'usr_buyer',
   *   sku: 'wrld_pass',
   *   price: toAmount('CREDIT', 40_000n), // 400 credits
   *   recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
   * }));
   * if (outcome.status === 'rejected') {
   *   if (outcome.detail.reason === 'INSUFFICIENT_FUNDS') {
   *     // typed fields: which account fell short, and by how much
   *     const { account, need, have } = outcome.detail;
   *   }
   * }
   */
  submit(operation: Operation, options?: CallOptions): Promise<Outcome>;
  /**
   * Submits several independent operations through the full pipeline for one database commit
   * (one fsync) on the clean path — the aggregate-throughput lever.
   *
   * Each operation keeps exactly `submit`'s semantics: a rejection or fault rolls back that
   * operation alone, and its batch-mates still commit. The isolation strategy is the store
   * engine's own (see {@link Store.batchTransaction}). On a store without batch support, this
   * degrades to sequential submits.
   *
   * Slots in the result are index-aligned with the input.
   *
   * A key repeated inside one batch replays: the later slot comes back `duplicate`.
   */
  submitBatch(
    operations: ReadonlyArray<Operation>,
    options?: CallOptions,
  ): Promise<ReadonlyArray<BatchOutcome>>;
  /**
   * The read surface: balances, statements, postings, sagas, entitlements, status, capacity,
   * the streamed enumerations, and the export. Reads never mutate. `balance` alone consults the
   * optional cache, and every other reader goes to the store.
   */
  read: {
    /**
     * The account's current balance in its own currency, from the maintained running total —
     * one read, not a sum over history. An account never posted to reads as zero.
     *
     * When a cache port is present this is a read-through, and any cache failure logs and falls
     * back to the ledger, so a degraded cache can never fail the read.
     *
     * A bare sharded platform account resolves to its logical balance: the sum over its shard
     * rows.
     */
    balance(account: AccountRef, options?: CallOptions): Promise<Amount>;
    /**
     * One page of the account's entries inside `range` (half-open, epoch milliseconds: `from`
     * included, `to` not). Paging is by narrowing the range window by window; the returned
     * cursor is reserved and always null.
     */
    statement(
      account: AccountRef,
      range: Range,
      options?: CallOptions,
    ): Promise<Statement>;
    /**
     * One committed posting by transaction id (its legs and meta), or null if unknown. Lets a reader
     * resolve a posting without reaching past `read` into the raw Store.
     */
    posting(txnId: string, options?: CallOptions): Promise<Posting | null>;
    /**
     * One payout saga by id (state, provider ref, attempts), or null if unknown. The background
     * worker advances these; a UI reads them to render payout status.
     */
    saga(id: string, options?: CallOptions): Promise<Saga | null>;
    /**
     * The user's three wallet balances plus `payableNow` — the earned portion whose maturity
     * horizon has passed, the amount a payout request could draw this instant. Zeros for a
     * user who never transacted; a wallet read never fails as unknown.
     */
    wallet(userId: string, options?: CallOptions): Promise<Wallet>;
    /**
     * The user's non-revoked entitlement grants, expired included, sorted by sku. Delegates
     * to `EntitlementStore.list`.
     */
    entitlements(
      userId: string,
      options?: CallOptions,
    ): AsyncIterable<EntitlementGrant>;
    /**
     * Every subscription the user holds, newest first, all states — canceled and lapsed rows
     * render too. Delegates to `SubscriptionStore.listFor`.
     */
    subscriptions(
      userId: string,
      options?: CallOptions,
    ): AsyncIterable<Subscription>;
    /**
     * Whether a user currently owns an entitlement (a SKU: an item or feature), true or false.
     * Ownership is a record, not a balance, so it has its own reader. This is the readable side of
     * `grantEntitlement`/`revokeEntitlement` that a UI gates access on.
     */
    entitled(
      userId: string,
      sku: string,
      options?: CallOptions,
    ): Promise<boolean>;
    /**
     * The economy's current pause state (see {@link EconomyStatus}). Derived from config + the
     * clock, not stored, so it always reflects the live window.
     */
    status(): EconomyStatus;
    /**
     * The capacity gauges (see {@link CapacityReport}), with advisories as stated facts.
     * Nothing here flips any behavior.
     */
    capacity(options?: CallOptions): Promise<CapacityReport>;
    /**
     * Every account that has a balance row, streamed. A real ledger can hold many, so iterate and
     * stop when you've seen enough rather than collecting them all. Lets a reader enumerate accounts
     * (and derive users) without tracking them itself. This is the prover's own enumeration.
     */
    accounts(options?: CallOptions): AsyncIterable<AccountRef>;
    /**
     * Every payout saga, newest first, streamed (a busy economy can have many). Includes settled
     * and failed payouts, not only the due ones the worker claims. Lets a UI
     * render payout status without tracking minted payout ids itself. Delegates to `SagaStore.list`.
     */
    payouts(
      options?: CallOptions & {
        states?: readonly SagaState[];
        userId?: string;
      },
    ): AsyncIterable<Saga>;
    /**
     * Every committed posting, newest first, streamed (a busy ledger can have many). Includes user
     * and worker postings alike, every account touched, not only the ones a given reader
     * minted. Each posting carries its full legs, so a UI renders a row without a second lookup.
     * Delegates to `Ledger.list`.
     */
    postings(options?: CallOptions): AsyncIterable<Posting>;
    /**
     * One account's hash chain, oldest first: every posting that touched it, each carrying the
     * head hash before and after, so a reader can walk the tamper-evident chain a link at a time.
     * The first link's `prevHash` is the fixed genesis; each later `prevHash` equals the prior
     * `hash`. Delegates to `Ledger.lineage`.
     */
    lineage(
      account: AccountRef,
      options?: CallOptions,
    ): AsyncIterable<StoredLink>;
    /**
     * Streams the ledger as canonical JSONL for offline verification: a header line, every
     * account's chain links in lineage order, then the latest checkpoint. `scripts/ledger-verify.ts`
     * re-proves the chain and checks the checkpoint signature from the file alone, with no
     * store access.
     */
    export(options?: CallOptions): AsyncIterable<string>;

    /**
     * The latest signed checkpoint (the Merkle root over all account heads, its signature, and the
     * count it covers), or null before the worker has sealed one. The read side of the periodic
     * seal a UI verifies against the live heads. Delegates to `CheckpointStore.latest`.
     */
    checkpoint(options?: CallOptions): Promise<Checkpoint | null>;
    /**
     * The light in-process snapshot for health pages and consoles; its chain check is
     * shape-only. CI and audits run the thorough `proveEconomy` instead.
     */
    health(options?: CallOptions): Promise<HealthReport>;
  };
  /**
   * Shuts the economy down by releasing every port in its bag that declares a `close` — the SQL
   * engines end their connection pools, a Redis cache drops its client. The optional ports go
   * first, the store last, so a port flushing on the way out still has one. A port with no
   * `close` is left alone, and an in-memory bag has nothing to release.
   *
   * Every port is closed even if an earlier one refuses; the refusals then surface together as
   * one PROVIDER.FAILURE naming them in `detail.ports`. Calling it again is safe and closes
   * nothing twice.
   *
   * Call it once, after in-flight submits and the worker's sweeps have finished; a submit
   * after close gets whatever the engine does on a closed pool.
   *
   * Ownership follows creation: this closes the bag handed to `createEconomy`. A port you built
   * yourself and mean to keep past the economy belongs to you — hand it to `createApp` as
   * `portsBag`, which never closes what it did not open.
   */
  close(): Promise<void>;
}

/** What `read.wallet()` reports: the three balances plus the matured, payable-now portion. */
export type Wallet = {
  spendable: Amount;
  earned: Amount;
  promo: Amount;
  /** The earned portion past its maturity horizon — what a payout request could draw now. */
  payableNow: Amount;
};

/**
 * What `read.health()` reports — the thorough prover's shape, narrowed to the light prover. Its
 * `firstBreak` is `null` in the type as well as in the value: the light chain check reads each
 * account's newest head and never opens a link, so it has no link to name even when it answers
 * `chainIntact: false`.
 */
export type HealthReport = ProveReport & {
  prover: 'read.health';
  firstBreak: null;
};

/** The result of the integrity check: each flag is one property the ledger is supposed to hold. */
export interface ProveReport {
  /**
   * Which prover filled this report. The two answer `chainIntact` differently, so a report copied
   * into an audit trail, a trace or a bench artifact carries the answer with it rather than
   * depending on the reader knowing which call produced it.
   */
  prover: 'proveEconomy' | 'read.health';

  /**
   * True when debits and credits cancel out within each currency, so no money was created or lost.
   */
  conserved: boolean;

  /**
   * True when the real USD the platform holds in trust covers every credit it owes back to
   * users: the credits sitting in their spendable balances. Credits are converted to USD at the
   * peg, the fixed CREDIT-to-USD rate.
   */
  backed: boolean;

  /** True when no user account has gone below zero. */
  noOverdraft: boolean;

  /**
   * True when no posting was altered after it was recorded. `proveEconomy` answers that by
   * recomputing every account's hash chain. `read.health()` answers a weaker question — whether
   * each account's latest head is well-formed — so an edit behind a head leaves it true there.
   */
  chainIntact: boolean;

  /**
   * Which link broke, when one did: the account, the transaction that wrote it, whether the
   * contents were changed or the chain no longer joins, and the two hashes that disagree. Null
   * when `chainIntact` is true, and null on a `read.health()` report whatever `chainIntact` says
   * there — that prover checks the newest head's shape and opens no link, so it has nothing to
   * name. `prover` says which of the two filled the report.
   *
   * An operator reads this after an escalation has already latched containment, so a verdict that
   * carried only the boolean sent them to search the whole ledger for the posting the prover had
   * already found.
   */
  firstBreak: ChainBreak | null;

  /**
   * True when, for every account, the cached running balance matches the balance re-added from its
   * debit and credit lines (i.e. `drift` is empty). The lines are the source of truth. The cached
   * figure can be wrong. A diverged cached balance (mis-saved or directly-edited row) shows up here
   * even when the books still balance.
   */
  consistent: boolean;

  /**
   * Every account whose cached balance disagrees with the balance re-added from its debit and credit
   * lines; empty when `consistent` is true. Each entry names the account and both figures, so an
   * operator sees the gap's size and direction. Catches both a real account whose cached total
   * drifted and a leftover balance row with no postings (re-added to zero, so any cached figure is
   * wrong).
   */
  drift: ReadonlyArray<{
    account: AccountRef;
    materialized: Amount;
    derived: Amount;
  }>;

  /** How much USD backing is missing; zero when `backed` is true. */
  shortfall: Amount;
}
