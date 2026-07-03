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
import type { RejectionCode } from '#src/errors.ts';
import type {
  Cache,
  Clock,
  Digest,
  Ids,
  Leg,
  Logger,
  Meter,
  Options,
  Posting,
  Processor,
  Range,
  Rates,
  Saga,
  Signer,
  Statement,
  Unit,
} from '#src/ports.ts';
import type { Config } from '#src/config.ts';

/**
 * Optional details on an entitlement grant (a user owning an item or feature). Lives here rather
 * than in the entitlements module because callers pass it in with an operation; entitlements
 * imports it back.
 */
export type EntitlementAttrs = {
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
 * One party who gets a cut of a sale. The price is split across all recipients (each taking
 * shareBps, in basis points: 100 bps = 1%) with the platform keeping the remaining fee.
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
      recipients?: Recipient[];
      ageRestricted?: boolean;
      /**
       * A gift. The buyer still pays and is screened for funds and velocity, but the SKU is granted
       * to this recipient user id instead of the buyer. A gift is modeled as an ordinary purchase
       * that carries a recipient, not a separate transaction type, with no wallet-to-wallet credit
       * or ownership transfer. Omitted (or equal to `buyerId`) for a self-purchase.
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
      // No `ageRestricted` field: age-gating is spend-only (see the spend variant). There is no
      // in-core age gate, only the spend-side audit tag.
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
      attrs?: EntitlementAttrs;
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
  // Operator-only correction to undo a not-yet-paid payout. Marks the saga FAILED and returns the
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
       * the posted amount.
       */
      providerAmount: Amount;
    };

/**
 * The result of submitting an operation: `committed`, `duplicate` (a repeat, earlier result
 * returned unchanged), or `rejected`. A rejection is a normal "no" returned as data; a genuine
 * fault is thrown instead.
 */
export type Outcome =
  | { status: 'committed'; transaction: Transaction }
  | { status: 'duplicate'; transaction: Transaction }
  | {
      status: 'rejected';
      reason: RejectionCode;
      detail?: Record<string, unknown>;
    };

/** A committed posting: the record of money that actually moved. */
export interface Transaction {
  /** Unique id, of the form txn_<uuid>. */
  id: string;

  /** When it committed, in epoch milliseconds. */
  postedAt: number;

  /** The individual debit and credit lines that posted. A refund reverses exactly these. */
  legs: ReadonlyArray<{ account: AccountRef; amount: Amount }>;

  /**
   * For each account this transaction touched, how its tamper-evident hash chain advanced:
   * prevHash was that account's latest hash before this posting, hash is the one after.
   */
  links: ReadonlyArray<{ account: AccountRef; prevHash: string; hash: string }>;
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
};

/**
 * Capabilities for the background worker. Payout settlement and periodic checkpoint jobs run on
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
};

/** A function that processes one operation, given an open transaction and its capabilities. */
export type Handler = (
  operation: Operation,
  tx: Unit,
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
 * the clock. `paused` is true only inside the window. `pauseStart` and `pauseEnd` are the configured
 * bounds in epoch ms, or null when no window is set. `resumesAt` is `pauseEnd` while paused, else
 * null. This is the readable side of the ECONOMY_PAUSED gate: a UI reads it to show a banner without
 * inferring the state from a declined write.
 */
export type EconomyStatus = {
  paused: boolean;
  pauseStart: number | null;
  pauseEnd: number | null;
  resumesAt: number | null;
};

/**
 * Public surface of a running economy: submit operations that change money, read balances and
 * statements, run the integrity check, shut down. Built by `createEconomy` in `economy.ts`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for the
 * submit/read/close surface and its construction.
 */
export interface Economy {
  submit(operation: Operation, options?: Options): Promise<Outcome>;
  read: {
    balance(account: AccountRef, options?: Options): Promise<Amount>;
    statement(
      account: AccountRef,
      range: Range,
      options?: Options,
    ): Promise<Statement>;
    /**
     * One committed posting by transaction id (its legs and meta), or null if unknown. Lets a reader
     * resolve a posting without reaching past `read` into the raw Store.
     */
    posting(txnId: string, options?: Options): Promise<Posting | null>;
    /**
     * One payout saga by id (state, provider ref, attempts), or null if unknown. The background
     * worker advances these; a UI reads them to render payout status.
     */
    saga(id: string, options?: Options): Promise<Saga | null>;
    /**
     * Whether a user currently owns an entitlement (a SKU: an item or feature), true or false.
     * Ownership is a record, not a balance, so it has its own reader. This is the readable side of
     * `grantEntitlement`/`revokeEntitlement` that a UI gates access on.
     */
    entitled(userId: string, sku: string, options?: Options): Promise<boolean>;
    /**
     * The economy's current pause state (see EconomyStatus): whether a maintenance window is in
     * effect right now, its configured bounds, and when writes resume. Derived from config + the
     * clock, not stored, so it always reflects the live window. Lets a UI render a maintenance banner
     * without inferring the state from an ECONOMY_PAUSED decline.
     */
    status(): EconomyStatus;
    /**
     * Every account that has a balance row, streamed. A real ledger can hold many, so iterate and
     * stop when you've seen enough rather than collecting them all. Lets a reader enumerate accounts
     * (and derive users) without tracking them itself. This is the prover's own enumeration.
     */
    accounts(options?: Options): AsyncIterable<AccountRef>;
    /**
     * Every payout saga, newest first, streamed (a busy economy can have many). Includes settled
     * and failed payouts, not only the due ones the worker claims. Lets a UI
     * render payout status without tracking minted payout ids itself. Delegates to `SagaStore.list`.
     */
    payouts(options?: Options): AsyncIterable<Saga>;
    /**
     * Every committed posting, newest first, streamed (a busy ledger can have many). Includes user
     * and worker postings alike, every account touched, not only the ones a given reader
     * minted. Each posting carries its full legs, so a UI renders a row without a second lookup.
     * Delegates to `Ledger.list`.
     */
    postings(options?: Options): AsyncIterable<Posting>;
    prove(options?: Options): Promise<ProveReport>;
  };
  close(): Promise<void>;
}

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
