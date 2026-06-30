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

import type { Currency } from '#src/money.ts';
// Type-only import. This file and contract.ts reference each other, but type-only imports are
// erased at compile time, so there's no runtime circular import.
import type { Operation } from '#src/contract.ts';

/**
 * The three kinds of account a single user can have. This is a category, not a currency. The
 * currency of any money movement comes from the amount's own `Currency`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/ Accounts & double-entry} for how these accounts and their normal sides balance.
 */
export type AccountKind = 'spendable' | 'earned' | 'promo';

/**
 * A branded account identifier string, so a plain string can't be used as an account. The only
 * sources are the functions in this file and the `SYSTEM` accounts below, so every id is
 * well-formed by construction.
 */
export type AccountRef = string & { readonly __brand: 'AccountRef' };

/**
 * A user's spendable account: money they topped up and can spend. Backed by real USD held
 * in trust.
 */
export function spendable(userId: string): AccountRef {
  return `${userId}:spendable` as AccountRef;
}

/**
 * A user's earned account: revenue owed to them as a seller, which the platform must pay out.
 */
export function earned(userId: string): AccountRef {
  return `${userId}:earned` as AccountRef;
}

/**
 * A user's promo account: a marketing grant that expires.
 */
export function promo(userId: string): AccountRef {
  return `${userId}:promo` as AccountRef;
}

/**
 * The platform's own ("house") accounts. Each id starts with `platform:` to distinguish it from a
 * user account. Each account's comment notes its currency and its normal side. A debit-normal
 * account goes up when debited. A credit-normal account goes up when credited.
 */
export const SYSTEM = {
  // The real USD the platform holds in trust on behalf of users. Debit-normal, in USD.
  TRUST_CASH: 'platform:trust_cash' as AccountRef,

  // The platform's earnings: fees plus the rounding leftover from splitting a sale. Credit-normal.
  // Must not hold the offsetting entry for newly issued credits on a top-up (that goes to
  // STORED_VALUE instead).
  REVENUE: 'platform:revenue' as AccountRef,

  // Running count of all credits in circulation. On top-up, the newly issued credits post here as
  // the offsetting entry. Debit-normal.
  STORED_VALUE: 'platform:stored_value' as AccountRef,

  // Money set aside in escrow for a pending payout, funded from sellers' earned balances.
  // Credit-normal.
  PAYOUT_RESERVE: 'platform:payout_reserve' as AccountRef,

  // A shortfall the platform is owed back, e.g. after a clawback left a user's balance negative.
  // Debit-normal.
  RECEIVABLE: 'platform:receivable' as AccountRef,

  // The offsetting entry for marketing grants in users' promo accounts. Debit-normal.
  PROMO_FLOAT: 'platform:promo_float' as AccountRef,

  // An external counter mirroring cash that has cleared in or out of TRUST_CASH. Debit-normal, in USD.
  USD_CLEARING: 'platform:usd_clearing' as AccountRef,

  // The platform's USD profit from the buy-par spread (see {@link Rates}), recognized here at
  // top-up. It's the platform's own money, not held in trust, so it stays out of the backing
  // total. Debit-normal, in USD.
  REVENUE_USD: 'platform:revenue_usd' as AccountRef,

  // The offsetting entry used when seeding starting balances on a fresh (cold-start) system.
  OPENING_EQUITY: 'platform:opening_equity' as AccountRef,
} as const;

/**
 * Whether `ref` is a user wallet account rather than a platform ("house") account. A user id is
 * `usr_…:<kind>` (has a `:kind` suffix, no `platform:` prefix); every house account starts with
 * `platform:`.
 *
 * Guards against money laundering: escrow for a pending purchase must come back out only by
 * releasing or expiring the hold. Moving it straight into a user's balance would mint fresh,
 * immediately-spendable money that skips settlement and the payout waiting period, so the escrow
 * code uses this check to refuse such moves. This is the single user-vs-house test; `economy.ts`
 * and `integrity.ts` import it.
 */
export function isWalletAccount(ref: AccountRef): boolean {
  return ref.includes(':') && !ref.startsWith('platform:');
}

/**
 * The user id a wallet account belongs to: the part before its `:kind` suffix. For
 * `usr_alice:spendable` this is `usr_alice`; for a malformed `:spendable` (empty user id) it's the
 * empty string, which the submit pipeline rejects. Only meaningful for the wallet accounts
 * {@link isWalletAccount} identifies.
 */
export function ownerOf(ref: AccountRef): string {
  let colon = ref.lastIndexOf(':');
  return colon < 0 ? ref : ref.slice(0, colon);
}

/**
 * The currency an account is denominated in. Everything is in CREDIT except the two USD
 * accounts, TRUST_CASH and USD_CLEARING.
 */
export function currency(ref: AccountRef): Currency {
  if (
    ref === SYSTEM.TRUST_CASH ||
    ref === SYSTEM.USD_CLEARING ||
    ref === SYSTEM.REVENUE_USD
  ) {
    return 'USD';
  }
  return 'CREDIT';
}

/**
 * Sort every account into one of four classes. The DB schema and the USD-backing solvency check
 * both rely on these.
 *
 * - `custodial`: credits the platform must back with real USD (users' spendable balances). Only
 *   these count toward the trust total.
 * - `excluded`: platform obligations that need no USD backing (earned, promo, PAYOUT_RESERVE),
 *   kept out of the backing total so they can't raise the cash required.
 * - `house-asset`: value the platform holds or is owed.
 * - `house-liability`: value the platform owes out.
 */
export function classify(
  ref: AccountRef,
): 'custodial' | 'excluded' | 'house-asset' | 'house-liability' {
  if (
    ref === SYSTEM.TRUST_CASH ||
    ref === SYSTEM.USD_CLEARING ||
    ref === SYSTEM.REVENUE_USD ||
    ref === SYSTEM.STORED_VALUE ||
    ref === SYSTEM.RECEIVABLE ||
    ref === SYSTEM.OPENING_EQUITY
  ) {
    return 'house-asset';
  }
  if (
    ref === SYSTEM.REVENUE ||
    ref === SYSTEM.PROMO_FLOAT ||
    ref === SYSTEM.PAYOUT_RESERVE
  ) {
    // PAYOUT_RESERVE is `excluded`, not `house-liability`, so neither it nor promo ever enters the
    // backing total or raises the USD the platform must hold.
    return ref === SYSTEM.PAYOUT_RESERVE ? 'excluded' : 'house-liability';
  }
  if (kindOf(ref) === 'spendable') {
    return 'custodial';
  }
  return 'excluded';
}

/**
 * Whether the account grows on a debit (true) rather than a credit (false). The ledger uses this
 * to sign a posted line; the no-negative-balance check uses it to read each balance right-way-up.
 */
export function isDebitNormal(ref: AccountRef): boolean {
  return (
    ref === SYSTEM.TRUST_CASH ||
    ref === SYSTEM.USD_CLEARING ||
    ref === SYSTEM.REVENUE_USD ||
    ref === SYSTEM.STORED_VALUE ||
    ref === SYSTEM.RECEIVABLE ||
    ref === SYSTEM.PROMO_FLOAT ||
    ref === SYSTEM.OPENING_EQUITY
  );
}

/**
 * The accounts an operation might touch, which the middleware locks before posting so concurrent
 * operations can't race on the same balances.
 *
 * Returns a superset on purpose: a few extra locks are harmless, too few would let operations
 * interleave. Locking the full set up front gives the funds pre-check a consistent view and makes
 * the overdraft guard in `postEntry` a safety net that shouldn't fire.
 *
 * `refund` and `reverse`: the original transaction's accounts aren't in the request, so this
 * returns only the system accounts those operations always touch. The handler loads the original
 * transaction and adds its accounts before posting, covering everything the posting reads.
 */
export function accountsOf(operation: Operation): AccountRef[] {
  // TypeScript can't see that each LOCK_SETS builder reads only the fields valid for its own kind,
  // so widen the looked-up builder to a plain function via this cast. The LOCK_SETS type still
  // requires an entry per operation kind, so a forgotten kind is a compile error, not an empty
  // lock set that races the pre-check.
  let touched = LOCK_SETS[operation.kind] as (
    operation: Operation,
  ) => AccountRef[];
  return touched(operation);
}

// The system accounts that a refund or reversal always touches, regardless of the original
// transaction. The handler adds the original transaction's own accounts on top of these.
let REVERSAL_CONTRAS: AccountRef[] = [
  SYSTEM.REVENUE,
  SYSTEM.PROMO_FLOAT,
  SYSTEM.RECEIVABLE,
];

// For each operation kind, the accounts that operation may touch. `accountsOf` looks up the
// matching builder here and calls it.
let LOCK_SETS: {
  [K in Operation['kind']]: (
    operation: Extract<Operation, { kind: K }>,
  ) => AccountRef[];
} = {
  topUp: (o) => [
    spendable(o.userId),
    SYSTEM.STORED_VALUE, // offsetting entry for the newly issued credits
    SYSTEM.TRUST_CASH,
    SYSTEM.USD_CLEARING,
  ],
  spend: (o) => [
    promo(o.buyerId),
    spendable(o.buyerId),
    SYSTEM.PROMO_FLOAT,
    SYSTEM.REVENUE,
    ...(o.recipients ?? []).map((r) => earned(r.sellerId)),
  ],
  refund: () => [...REVERSAL_CONTRAS],
  clawback: (o) => [
    spendable(o.userId),
    SYSTEM.STORED_VALUE, // a chargeback cancels credits against STORED_VALUE, not REVENUE, the same way a top-up issued them
    SYSTEM.RECEIVABLE,
  ],
  requestPayout: (o) => [earned(o.userId), SYSTEM.PAYOUT_RESERVE],
  subscribe: (o) => [
    promo(o.userId),
    spendable(o.userId),
    SYSTEM.PROMO_FLOAT,
    SYSTEM.REVENUE,
    earned(o.sellerId),
  ],
  // These operations only change subscription or entitlement state. They post no money, so they
  // lock no accounts.
  cancelSubscription: () => [],
  grantEntitlement: () => [],
  revokeEntitlement: () => [],
  grantPromo: (o) => [promo(o.userId), SYSTEM.PROMO_FLOAT],
  // Lock the adjusted account plus OPENING_EQUITY, which holds the offsetting entry so the books
  // balance.
  adjust: (o) => [o.account, SYSTEM.OPENING_EQUITY],
  reverse: () => [...REVERSAL_CONTRAS],
  // Undoing a payout by hand reverses the original: debit PAYOUT_RESERVE, credit the seller's
  // earned account, the same two the background payout worker touches when it gives up. Those two
  // are the only locks. The request names the seller by `userId`, so these cover it exactly (not an
  // over-estimate).
  reversePayout: (o) => [SYSTEM.PAYOUT_RESERVE, earned(o.userId)],
  // Settling a payout posts two platform-only entries (the worker's settle): the credit side empties
  // PAYOUT_RESERVE into REVENUE, the USD side debits USD_CLEARING / credits TRUST_CASH. No user
  // wallet account is touched, so these four platform accounts are the full lock set. Named only by
  // `sagaId`; the reserve amount and seller come off the loaded saga inside the handler.
  settlePayout: () => [
    SYSTEM.PAYOUT_RESERVE,
    SYSTEM.REVENUE,
    SYSTEM.USD_CLEARING,
    SYSTEM.TRUST_CASH,
  ],
};

// Pull the account kind out of an id like `usr_123:spendable`. Returns null if there's no `:kind`
// suffix or it isn't a known kind. The only place that parses the raw `usr_…:<kind>` string shape.
function kindOf(ref: AccountRef): AccountKind | null {
  let colon = ref.lastIndexOf(':');
  if (colon < 0) {
    return null;
  }
  let suffix = ref.slice(colon + 1);
  if (suffix === 'spendable' || suffix === 'earned' || suffix === 'promo') {
    return suffix;
  }
  return null;
}
