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
  Capabilities,
  Clock,
  Digest,
  Ids,
  Logger,
  Meter,
  Options,
  Processor,
  Range,
  Rates,
  Signer,
  Statement,
  Unit,
} from '#src/ports.ts';
import type { Config } from '#src/config.ts';
import type { Leg } from '#src/ports.ts';

/**
 * Optional details attached to an entitlement grant (a user owning an item or feature).
 * Defined here, not in the entitlements module, because it is part of the data callers pass
 * in with an operation; the entitlements module imports it back.
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
 * Every kind of request a caller can submit. Each variant is one action, tagged by `kind`,
 * and every variant carries an `idempotencyKey` (so a retried request runs at most once) and
 * an `actor` (who is asking). This is the full set of things the economy can be told to do.
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
      // A gift: the buyer still pays and is the one screened for funds and velocity, but the
      // purchased SKU is granted to this recipient user id instead of the buyer. This mirrors
      // VRChat, where a gift is an ordinary purchase carrying an `isGift` flag (not a separate
      // transaction type) — there is no wallet-to-wallet credit or ownership transfer. Omitted
      // (or equal to `buyerId`) for an ordinary self-purchase.
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
      amount: Amount;
    } // amount is the seller's earned credits. It is set aside in the payout-reserve account
  // and ultimately paid out to them as real USD.
  | {
      kind: 'subscribe';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      sellerId: string;
      sku: string;
      price: Amount;
      periodMs: number;
    } // No `ageRestricted` field: age-gating is spend-only (see the spend variant). Subscribe
  // intentionally omits it — there is no in-core age gate, only the spend-side audit tag.
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
  | {
      kind: 'adjust';
      idempotencyKey: string;
      actor: Principal;
      account: AccountRef;
      amount: Amount;
      reason: string;
    } // A manual correction an operator posts by hand; ordinary users can't run it. The
  // offsetting entry goes to the opening-equity account so the books still balance.
  | {
      kind: 'reverse';
      idempotencyKey: string;
      actor: Principal;
      txnId: string;
      reason: string;
    } // A manual undo an operator runs by hand; ordinary users can't run it. It posts the
  // exact opposite of the transaction named by txnId, cancelling it out.
  | {
      kind: 'reversePayout';
      idempotencyKey: string;
      actor: Principal;
      userId: string;
      sagaId: string;
      reason: string;
    }; // A correction an operator runs by hand to undo a payout that has not paid out yet;
// ordinary users can't run it. It marks the multi-step payout (the "saga") as FAILED — but only
// if it is still in its pre-paid state, so two attempts can't both undo it — and returns the
// credits that were set aside back to the seller's earned account. A payout that has already
// disbursed real USD is refused. `userId` names the seller behind the payout so the engine knows
// which account to lock before changing it: the operation is identified only by its payout id and
// names no account directly.

/**
 * The result of submitting an operation. Either it went through (`committed`), it was a repeat
 * of one already done and the earlier result is returned unchanged (`duplicate`), or the
 * economy declined it for an ordinary business reason the caller can handle (`rejected`).
 * Note: rejection is a normal "no" returned as data; a genuine fault is thrown instead.
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
  // Unique id, of the form txn_<uuid>.
  id: string;

  // When it committed, in epoch milliseconds.
  postedAt: number;

  // The individual debit and credit lines that posted. A refund reverses exactly these.
  legs: ReadonlyArray<{ account: AccountRef; amount: Amount }>;

  // For each account this transaction touched, how its tamper-evident hash chain advanced:
  // prevHash was that account's latest hash before this posting, hash is the one after.
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
  // An optional read-through balance cache. Present only when a cache capability was
  // injected; when absent every balance read goes straight to the ledger, unchanged.
  cache?: Cache;
};

/**
 * The capabilities the background worker is given. Payout settlement and periodic checkpoint
 * jobs run on their own schedule rather than inside a caller's submit, so they get their own
 * bundle. It includes `rates` because settling a payout converts credits to USD.
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

/** Wraps a handler with extra behavior, returning a new handler that calls `next` inside it. */
export type Middleware = (next: Handler) => Handler;

/**
 * Splits a sale's `price` across the recipients and the platform, turning it into the set of
 * debit/credit lines (legs) to post. Every minor unit of the price is accounted for, with no
 * money lost to rounding: it takes the platform fee off the top (rounding down), gives each
 * recipient their rounded-down share of what is left, and posts any leftover penny from the
 * rounding to the platform's revenue. Implemented in `pricing.ts`.
 */
export type FeePolicy = (input: {
  price: Amount;
  recipients: ReadonlyArray<Recipient>;
  feeBps: number;
  buyerId?: string;
  sku?: string;
}) => ReadonlyArray<Leg>;

/**
 * The public surface of a running economy: submit operations that change money, read balances
 * and statements, run the integrity check, and shut down. Built by `createEconomy` in
 * `economy.ts`.
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
    prove(options?: Options): Promise<ProveReport>;
  };
  close(): Promise<void>;
}

/** The result of the integrity check: each flag is one property the ledger is supposed to hold. */
export interface ProveReport {
  // True when debits and credits cancel out within each currency, so no money was created or lost.
  conserved: boolean;

  // True when the real USD the platform holds in trust covers every credit it owes back to
  // users: the credits sitting in their spendable balances. Credits are converted to USD at the
  // peg, the fixed credits-to-USD rate.
  backed: boolean;

  // True when no user account has gone below zero.
  noOverdraft: boolean;

  // True when every account's hash chain recomputes to its recorded value, proving no posting
  // was tampered with after the fact.
  chainIntact: boolean;

  // True when, for every account, the running balance the store keeps as a cache still matches the
  // balance re-added from its individual debit and credit lines — i.e. `drift` is empty. The lines
  // are the source of truth; the cached figure can be wrong. A cached balance that diverged (a
  // mis-saved or directly-edited balance row) shows up here even when the books still balance.
  consistent: boolean;

  // Every account whose cached balance disagrees with the balance re-added from its debit and
  // credit lines; empty when `consistent` is true. Each entry names the account and both figures so
  // an operator can see the size and direction of the gap. This catches two cases: an account that
  // has real postings but whose cached total drifted away from them, and a leftover balance row
  // that has NO postings behind it at all (its lines say it should not exist, so any non-zero
  // cached figure is wrong — such a row is compared against a re-added balance of zero).
  drift: ReadonlyArray<{
    account: AccountRef;
    materialized: Amount;
    derived: Amount;
  }>;

  // How much USD backing is missing; zero when `backed` is true.
  shortfall: Amount;
}

/** Build a ready-to-use {@link Economy} from the full set of injected capabilities. */
export declare function createEconomy(capabilities: Capabilities): Economy;
