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
// Imported for its type only. This file and contract.ts refer to each other, but a type-only
// import is erased when TypeScript compiles to JavaScript, so no circular import exists at runtime.
import type { Operation } from '#src/contract.ts';

/**
 * The three kinds of account a single user can have. This names a category of account,
 * not a currency — the currency of any money movement comes from the amount's own `Currency`.
 */
export type AccountKind = 'spendable' | 'earned' | 'promo';

/**
 * An account identifier string, "branded" so the type system won't let a plain string be
 * used as an account. The only way to get one is through the functions in this file and the
 * `SYSTEM` accounts below, so every account id is well-formed by construction.
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
 * The platform's own ("house") accounts. Each id starts with `vrchat:` to set it apart from
 * a real user's account. The comments note each account's currency and which side it grows on
 * ("debit-normal" = goes up when debited; "credit-normal" = goes up when credited).
 */
export const SYSTEM = {
  // The real USD the platform holds in trust on behalf of users. Debit-normal, in USD.
  TRUST_CASH: 'vrchat:trust_cash' as AccountRef,

  // The platform's earnings: fees plus the rounding leftover from splitting a sale. Credit-normal.
  // It must NEVER hold the offsetting entry for newly issued credits on a top-up (that goes to
  // STORED_VALUE instead).
  REVENUE: 'vrchat:revenue' as AccountRef,

  // A running count of all credits in circulation. When a user tops up, the newly issued credits
  // are recorded against this account as the offsetting entry. Debit-normal.
  STORED_VALUE: 'vrchat:stored_value' as AccountRef,

  // Money set aside in escrow for a pending payout, funded from sellers' earned balances.
  // Credit-normal.
  PAYOUT_RESERVE: 'vrchat:payout_reserve' as AccountRef,

  // A shortfall the platform is owed back — for example after reclaiming money from a user (a
  // "clawback") left that user's balance negative. Debit-normal.
  RECEIVABLE: 'vrchat:receivable' as AccountRef,

  // The offsetting entry for marketing grants in users' promo accounts. Debit-normal.
  PROMO_FLOAT: 'vrchat:promo_float' as AccountRef,

  // An external counter mirroring cash that has cleared in or out of TRUST_CASH. Debit-normal, in USD.
  USD_CLEARING: 'vrchat:usd_clearing' as AccountRef,

  // The platform's USD profit from the purchase spread: when a user buys credits, they pay the
  // buy rate (≈120 credits/USD) but each credit is only backed at its payout-floor value (the par
  // rate, ≈200 credits/USD). The difference — VRChat's documented ~40% "purchase fee", which is
  // really the buy-vs-payout exchange spread — is recognized here at top-up. It is the platform's
  // own money, NOT held in trust for users, so it is kept out of the backing total. Debit-normal,
  // in USD. (The external app-store cut and VAT are NOT modelled here — they happen at the
  // cash-in rail before VRChat's ledger sees the purchase; see docs/vrchat-grounding.md.)
  REVENUE_USD: 'vrchat:revenue_usd' as AccountRef,

  // The offsetting entry used when seeding starting balances on a fresh (cold-start) system.
  OPENING_EQUITY: 'vrchat:opening_equity' as AccountRef,
} as const;

/**
 * Whether `ref` is a user's spendable-style account rather than a platform ("house") account.
 * A user account id is `usr_…:<kind>` (it has a `:kind` suffix and does NOT start with the
 * `vrchat:` house prefix); every house account starts with `vrchat:`.
 *
 * This test guards against money laundering. Money put aside in escrow for a pending purchase
 * must come back out only by releasing or expiring the hold; turning that escrow directly into a
 * user's balance would create fresh, immediately-spendable money that skips the normal settlement
 * and the waiting period before earnings can be cashed out. So the code that manages escrow uses
 * this check to refuse moving held funds straight into a user account. `economy.ts` and
 * `integrity.ts` each have their own copy of this same user-vs-house test; new callers should
 * import this one instead of writing the rule again.
 */
export function isWalletAccount(ref: AccountRef): boolean {
  return ref.includes(':') && !ref.startsWith('vrchat:');
}

/**
 * The user id a wallet account belongs to: the part before its `:kind` suffix. For
 * `usr_alice:spendable` this is `usr_alice`; for a malformed `:spendable` (built from an empty
 * user id) it is the empty string, which the submit pipeline rejects. Only meaningful for the
 * user wallet accounts {@link isWalletAccount} identifies.
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
 * Sort every account into one of four classes. The database schema and the check that proves the
 * platform holds enough real USD to cover what it owes users both rely on these classes.
 *
 * - `custodial` — credits the platform must back with real USD: users' spendable balances.
 *   Only these count toward the total USD the platform is required to hold in trust.
 * - `excluded` — platform obligations that do NOT need USD backing (earned, promo,
 *   PAYOUT_RESERVE), deliberately kept out of the backing total so they can't raise the
 *   amount of cash required.
 * - `house-asset` — accounts that represent value the platform holds or is owed.
 * - `house-liability` — accounts that represent value the platform owes out.
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
    // PAYOUT_RESERVE is marked `excluded`, not `house-liability`, so that neither it nor promo
    // ever enters the backing total and can never increase the USD the platform must hold.
    return ref === SYSTEM.PAYOUT_RESERVE ? 'excluded' : 'house-liability';
  }
  if (kindOf(ref) === 'spendable') {
    return 'custodial';
  }
  return 'excluded';
}

/**
 * Whether the account grows on a debit (true) rather than a credit (false). The ledger uses
 * this to give a posted line the right sign, and the check that no account goes negative uses
 * it to read each account's balance the right way up.
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
 * The set of accounts an operation might touch, which the middleware locks before posting so
 * concurrent operations can't race on the same balances.
 *
 * It returns a superset on purpose: locking a few extra accounts is harmless, but locking too
 * few would let two operations interleave. Because the full set is locked up front, the funds
 * pre-check sees a consistent view, and the overdraft guard deep in `postEntry` becomes a
 * safety net that should never actually trigger.
 *
 * `refund` and `reverse` are special: the accounts from the original transaction aren't in the
 * incoming request, so this returns only the system accounts those operations always touch.
 * The handler then loads the original transaction and adds its accounts to the lock set before
 * posting, so the locked set still covers everything the posting will read.
 */
export function accountsOf(operation: Operation): AccountRef[] {
  // TypeScript can't see that each builder in LOCK_SETS reads only the fields valid for its own
  // operation kind, so we widen the looked-up builder to a plain function via this cast. The
  // LOCK_SETS type still forces every operation kind to have an entry, so a forgotten kind is a
  // compile error rather than a silently empty lock set that would race the pre-check.
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
    SYSTEM.STORED_VALUE, // a chargeback cancels credits the same way a top-up issued them — against STORED_VALUE, not REVENUE
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
  // These operations only change subscription or entitlement state; they post no money, so
  // there are no accounts to lock.
  cancelSubscription: () => [],
  grantEntitlement: () => [],
  revokeEntitlement: () => [],
  grantPromo: (o) => [promo(o.userId), SYSTEM.PROMO_FLOAT],
  // The adjusted account plus OPENING_EQUITY, which holds the offsetting entry so the books balance.
  adjust: (o) => [o.account, SYSTEM.OPENING_EQUITY],
  reverse: () => [...REVERSAL_CONTRAS],
  // Undoing a payout by hand reverses the original payout: it debits PAYOUT_RESERVE and credits
  // the seller's earned account, the same two accounts the background payout worker touches when it
  // gives up on a payout. So those two are the only accounts to lock. The request identifies the
  // seller by `userId` rather than naming accounts directly, so these two cover it exactly rather
  // than being a deliberate over-estimate.
  reversePayout: (o) => [SYSTEM.PAYOUT_RESERVE, earned(o.userId)],
};

// Pull the account kind out of an id like `usr_123:spendable`. Returns null if the id has no
// `:kind` suffix or the suffix isn't a known kind. This is the only place that parses the raw
// `usr_…:<kind>` string shape.
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
