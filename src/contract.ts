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

/**
 * The shared types between callers and the engine: the Operation union (every request a caller
 * can submit), the Outcome it resolves to, and the Economy interface. economy.ts implements what
 * this file declares.
 */

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
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
  PayeeDirectory,
  Posting,
  Processor,
  Range,
  Rates,
  Saga,
  SagaState,
  Signer,
  Statement,
  StoredLink,
  Unit,
} from '#src/ports.ts';
import type { Config } from '#src/config.ts';

/** Optional details on an entitlement grant (a user owning an item or feature). */
export type EntitlementAttributes = {
  quantity?: number;
  version?: number;
  expiresAt?: number | null;
  source?: string;
};

/** Who is making a request, and what they are allowed to do. */
export type Principal =
  // An end user (id looks like usr_<uuid>). May only act on their own accounts.
  | { kind: 'user'; userId: string }
  // A trusted internal service calling on behalf of the platform.
  | { kind: 'system'; service: string }
  // A human operator running a manual, fully-audited action.
  | { kind: 'operator'; operatorId: string };

/**
 * One party who gets a cut of a sale. The platform's fee comes off the top (`platformFeeBps`);
 * `shareBps` is each recipient's basis points of the post-fee net (100 bps = 1%), and the shares
 * must sum to exactly 10,000 — the platform never keeps an unclaimed remainder.
 */
export type Recipient = { sellerId: string; shareBps: number };

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
       * A gift: the buyer pays and is screened as usual, but the SKU is granted to this user id,
       * with no wallet-to-wallet credit or ownership transfer. Omitted (or equal to `buyerId`) for
       * a self-purchase.
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
  // Privileged correction to undo a not-yet-paid payout: an operator's manual undo, or the
  // verified payout-failed webhook's prompt reversal. Marks the saga FAILED and returns the
  // set-aside credits to the seller's earned account, but only if it is still pre-paid, so two
  // attempts can't both undo it; a payout that already disbursed real USD is refused. `userId`
  // names the seller (which account to lock); the operation is otherwise identified only by sagaId.
  | {
      kind: 'reversePayout';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      sagaId: string;
      reason: string;
      /**
       * True when the payout rail itself reported the disbursement failed (a verified payoutFailed
       * webhook). It waives the still-live SUBMITTED refusal: the provider has said it will not
       * settle this payout, so returning the reserve promptly cannot double-pay. An operator's
       * manual reverse leaves this unset and stays gated until the payout ages past
       * `maxPayoutAgeMs`.
       */
      providerReported?: boolean;
    }
  // System- or operator-only (RESTRICTED_TO_PRIVILEGED in economy.ts): the SUBMITTED -> SETTLED
  // step that empties the seller's reserve into REVENUE and moves gross USD out of trust. An end
  // user must never settle their own payout. Named only by `sagaId`; postings touch platform
  // accounts only.
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
       * The USD amount the provider reported settling. Recorded for audit/reconciliation only: the
       * figures actually posted are the rate-derived ones settlePayout computes (gross USD from
       * the reserve at the payout rate, less the rail fee), so the provider's report never sets
       * the posted amount. Absent when the rail's callback carries no figure (Tilia's does not);
       * the reconcile feed still checks amounts against the rail's settlement report.
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
    };

/**
 * The result of submitting an operation: `committed`, `duplicate` (a repeat, earlier result
 * returned unchanged), or `rejected`. A rejection is a normal "no" returned as data; a genuine
 * fault is thrown instead. The rejected arm's sole discriminant is `detail.reason`; the HTTP
 * wire additionally carries a derived top-level `reason` for client stability.
 */
export type Outcome =
  | { readonly status: 'committed'; readonly transaction: Transaction }
  | { readonly status: 'duplicate'; readonly transaction: Transaction }
  | { readonly status: 'rejected'; readonly detail: RejectionDetail };

/** The two outcomes that carry a committed transaction; `duplicate` is a success replayed. */
export type Success = Extract<Outcome, { status: 'committed' | 'duplicate' }>;

export type Rejection = Extract<Outcome, { status: 'rejected' }>;

/** A committed posting: the record of money that actually moved. */
export interface Transaction {
  /** Unique id, of the form txn_<uuid>. */
  id: string;

  /** When it committed, in epoch milliseconds. */
  postedAt: number;

  /**
   * The individual debit and credit lines that posted. A refund reverses exactly these. Amounts
   * are debit-positive — the ledger's sign, not the account holder's, so a top-up's wallet leg
   * is negative; `balanceDelta` (from `/store-kit`) converts a leg to the signed change in that
   * account's balance. May be empty: a committed lifecycle operation (e.g. `cancelSubscription`)
   * posts a marker that moves no money.
   */
  legs: ReadonlyArray<{ account: AccountRef; amount: Amount }>;

  /**
   * For each account this transaction touched, how its tamper-evident hash chain advanced:
   * prevHash was that account's latest hash before this posting, hash is the one after.
   */
  links: ReadonlyArray<{ account: AccountRef; prevHash: string; hash: string }>;

  /**
   * The posting's metadata, as the handler recorded it: the operation `kind` plus kind-specific
   * fields — a `requestPayout` carries the opened saga's `sagaId`, so the caller can follow its
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
  config: Config;
  pricing: FeePolicy;
  rates: Rates;
  logger: Logger;
  meter: Meter;
  /**
   * Optional read-through balance cache. Present only when a cache capability was injected;
   * when absent, every balance read goes straight to the ledger.
   */
  cache?: Cache;
  payees?: PayeeDirectory;
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
  config: Config;

  /** When present, every sealed checkpoint is also published to this external anchor. */
  anchor?: Anchor;
};

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
 * The economy's pause state at a moment in time, derived from the configured maintenance window and
 * the clock. `maintenanceActive` is true only inside the window — distinct from the worker's own
 * `sweepsPaused`. `pauseStart` and `pauseEnd` are the configured bounds in epoch ms, or null when
 * no window is set. `resumesAt` is `pauseEnd` while paused, else null. This is the readable side of
 * the ECONOMY_PAUSED gate: a UI reads it to show a banner without inferring the state from a
 * declined write.
 */
export type EconomyStatus = {
  readonly maintenanceActive: boolean;
  readonly pauseStart: number | null;
  readonly pauseEnd: number | null;
  readonly resumesAt: number | null;
};

/**
 * Public surface of a running economy: submit operations that change money, read balances and
 * statements, run the integrity check, shut down. Built by `createEconomy` in `economy.ts`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for the
 * submit/read/close surface and its construction.
 */
export interface Economy {
  submit(operation: Operation, options?: CallOptions): Promise<Outcome>;
  read: {
    balance(account: AccountRef, options?: CallOptions): Promise<Amount>;
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
      options?: CallOptions & { states?: readonly SagaState[] },
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
  close(): Promise<void>;
}

/** What `read.health()` reports — the same shape the thorough prover fills. */
export type HealthReport = ProveReport;

/** The result of the integrity check: each flag is one property the ledger is supposed to hold. */
export interface ProveReport {
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
   * True when every account's hash chain recomputes to its recorded value, proving no posting
   * was tampered with after the fact.
   */
  chainIntact: boolean;

  /**
   * True when, for every account, the cached running balance matches the balance re-added from its
   * debit and credit lines (i.e. `drift` is empty). The lines are the source of truth; the cached
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
