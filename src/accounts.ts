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
 * The sole source of account ids: user wallets (`usr_...:spendable|earned|promo`), the platform's
 * SYSTEM accounts, and the shard routing that splits hot platform accounts across rows. Also owns
 * account classification (custodial vs house) and the per-operation lock sets.
 */

import type { Currency } from '#src/money.ts';
// Type-only, so the mutual reference with contract.ts is erased at compile time — no runtime
// circular import.
import type { Operation } from '#src/contract.ts';

/**
 * The kinds of account a single user can have. This is a category, not a currency. The
 * currency of any money movement comes from the amount's own `Currency`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/
 *   Accounts & double-entry} for how these accounts and their normal sides balance.
 */
export type AccountKind = 'spendable' | 'earned' | 'promo' | 'escrow';

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
 * A session escrow account: the prefund lane's crash-safe attribution. The account key is the
 * (user, session) pair, so recovery derives the unspent remainder from durable postings plus
 * the journal — no session-memory truth anywhere. Funded from `spendable` at session first
 * touch, drained by the session settlement, remainder refunded to `spendable` at close (see
 * src/instance.ts prefund).
 */
export function sessionEscrow(userId: string, sessionId: string): AccountRef {
  return `${userId}:${sessionId}:escrow` as AccountRef;
}

/**
 * Parses a session-escrow id back into its (user, session) pair, or null for any other account —
 * what the orphan-escrow sweep uses to find each remainder's owner.
 */
export function escrowPartsOf(
  ref: AccountRef,
): { userId: string; sessionId: string } | null {
  if (walletKindOf(ref) !== 'escrow') {
    return null;
  }
  const first = ref.indexOf(':');
  const last = ref.lastIndexOf(':');
  if (first < 0 || last <= first) {
    return null;
  }
  return { userId: ref.slice(0, first), sessionId: ref.slice(first + 1, last) };
}

/**
 * A user's earned account: revenue owed to them as a seller, which the platform must pay out.
 * Cashing out goes through `requestPayout`, which moves earned money into the payout reserve;
 * earned balances class as `excluded` in the backing check, so only the custodial spendable
 * side raises the required trust cash.
 */
export function earned(userId: string): AccountRef {
  return `${userId}:earned` as AccountRef;
}

/**
 * A user's promo account: a marketing grant that expires. Its offsetting entry sits in
 * `SYSTEM.PROMO_FLOAT`, and promo balances class as `excluded` in the backing check — granted
 * credits are the platform's marketing spend, not user money held in trust.
 */
export function promo(userId: string): AccountRef {
  return `${userId}:promo` as AccountRef;
}

/**
 * The platform's own ("house") accounts; every id starts with `platform:`. A debit-normal account
 * goes up when debited, a credit-normal one when credited.
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

  // The pass-through counterparty a session settlement clears its chunks against (see
  // src/netting.ts): each chunk posts a bounded set of participant legs against this account, and
  // the final chunk returns it to zero, so it holds money only mid-settlement. Credit-normal.
  NETTING_CLEARING: 'platform:netting_clearing' as AccountRef,

  // Sellers' sale shares parked between a spend and the accrual drain (config.accrualDrain): the
  // spend credits a shard here instead of each seller's earned row, and the drain sweep moves the
  // pooled shares on. Holds exactly the pending accrual rows' total. Credit-normal.
  SETTLEMENT_ACCRUAL: 'platform:settlement_accrual' as AccountRef,
} as const;

// --- Platform-account sharding ------------------------------------------------------
//
// Splitting each hot account into `platformShards` rows (bare id + `id#1`...`id#S-1`) lets
// concurrent postings run in parallel; readers sum the shards. Shard 0 keeps the bare id, so
// shards=1 (the default) changes nothing.

// The accounts worth sharding. RECEIVABLE and OPENING_EQUITY move too rarely to matter.
const SHARDED: ReadonlySet<AccountRef> = new Set([
  SYSTEM.REVENUE,
  SYSTEM.PROMO_FLOAT,
  SYSTEM.STORED_VALUE,
  SYSTEM.TRUST_CASH,
  SYSTEM.USD_CLEARING,
  SYSTEM.REVENUE_USD,
  SYSTEM.PAYOUT_RESERVE,
  SYSTEM.SETTLEMENT_ACCRUAL,
]);

/**
 * Strips a shard suffix: `platform:revenue#3` -> `platform:revenue`. The identity functions below
 * normalize through this, so a shard behaves exactly like its parent.
 */
export function baseOf(ref: AccountRef): AccountRef {
  if (!ref.startsWith('platform:')) {
    return ref;
  }
  const hash = ref.indexOf('#');
  return hash < 0 ? ref : (ref.slice(0, hash) as AccountRef);
}

/** The id of shard `k`: the bare id for 0, `base#k` otherwise. */
export function shardRef(base: AccountRef, shard: number): AccountRef {
  return shard === 0 ? base : (`${base}#${shard}` as AccountRef);
}

/** All shard ids of `base`, bare id first. Readers sum these to get the logical balance. */
export function shardsOf(base: AccountRef, shards: number): AccountRef[] {
  const refs: AccountRef[] = [];
  for (let shard = 0; shard < Math.max(1, shards); shard += 1) {
    refs.push(shardRef(base, shard));
  }
  return refs;
}

/** Whether `ref` is the bare id of an account that shards, so a reader must sum its rows. */
export function isShardedBase(ref: AccountRef): boolean {
  return SHARDED.has(ref);
}

/**
 * Picks a posting's shard: hash the key, mod the count. Outside the sharded set, or shards < 2,
 * the bare id passes through. Ops key on their idempotency key (same shard on retry);
 * PAYOUT_RESERVE keys on the user id, so a settle or reverse — which only knows the saga — drains
 * the shard the request credited (the overdraft guard keeps every reserve row non-negative).
 */
export function platformShard(
  ref: AccountRef,
  key: string,
  shards: number,
): AccountRef {
  if (shards < 2 || !SHARDED.has(ref)) {
    return ref;
  }
  return shardRef(ref, fnv1a(key) % shards);
}

/**
 * Applies {@link platformShard} to every leg. Handlers wrap their finished legs, so legs built by
 * injected ports (the fee policy credits REVENUE) route without the port knowing about shards.
 */
export function routePlatformLegs<T extends { account: AccountRef }>(
  legs: T[],
  key: string,
  shards: number,
): T[] {
  if (shards < 2) {
    return legs;
  }
  return legs.map((leg) => {
    const routed = platformShard(leg.account, key, shards);
    return routed === leg.account ? leg : { ...leg, account: routed };
  });
}

// FNV-1a 32-bit: tiny, deterministic, spreads keys evenly. Routing only, not crypto.
function fnv1a(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Whether `ref` is a user wallet account rather than a platform ("house") account — the single
 * user-vs-house test. Escrow code relies on it to refuse moving held money straight into a user's
 * balance, which would mint immediately-spendable money that skips settlement and the payout
 * waiting period.
 */
export function isWalletAccount(ref: AccountRef): boolean {
  return ref.includes(':') && !ref.startsWith('platform:');
}

/**
 * The user id a wallet account belongs to: the part before its `:kind` suffix. For
 * `usr_alice:spendable` this is `usr_alice`; for a malformed `:spendable` (empty user id) it's the
 * empty string, which the submit pipeline rejects. Only meaningful for the wallet accounts
 * {@link isWalletAccount} identifies. For a session escrow account this returns the
 * `<userId>:<sessionId>` prefix, not a user id; use `escrowPartsOf` for those.
 */
export function ownerOf(ref: AccountRef): string {
  const colon = ref.lastIndexOf(':');
  return colon < 0 ? ref : ref.slice(0, colon);
}

// Every SYSTEM account's identity in one row — its denomination, its normal side, and its class
// in the backing check. The three predicates below read this table, so reclassifying an account
// is a one-row edit that can never leave them disagreeing. PAYOUT_RESERVE is `excluded`, not
// `house-liability`, so it never raises the USD the platform must hold. An account absent here
// (every user wallet) is CREDIT, credit-normal, and classed by its wallet kind.
const SYSTEM_TRAITS = new Map<
  AccountRef,
  {
    currency: Currency;
    debitNormal: boolean;
    class: 'excluded' | 'house-asset' | 'house-liability';
  }
>([
  [
    SYSTEM.TRUST_CASH,
    { currency: 'USD', debitNormal: true, class: 'house-asset' },
  ],
  [
    SYSTEM.USD_CLEARING,
    { currency: 'USD', debitNormal: true, class: 'house-asset' },
  ],
  [
    SYSTEM.REVENUE_USD,
    { currency: 'USD', debitNormal: true, class: 'house-asset' },
  ],
  [
    SYSTEM.STORED_VALUE,
    { currency: 'CREDIT', debitNormal: true, class: 'house-asset' },
  ],
  [
    SYSTEM.RECEIVABLE,
    { currency: 'CREDIT', debitNormal: true, class: 'house-asset' },
  ],
  [
    SYSTEM.OPENING_EQUITY,
    { currency: 'CREDIT', debitNormal: true, class: 'house-asset' },
  ],
  [
    SYSTEM.PROMO_FLOAT,
    { currency: 'CREDIT', debitNormal: true, class: 'house-liability' },
  ],
  [
    SYSTEM.REVENUE,
    { currency: 'CREDIT', debitNormal: false, class: 'house-liability' },
  ],
  [
    SYSTEM.PAYOUT_RESERVE,
    { currency: 'CREDIT', debitNormal: false, class: 'excluded' },
  ],
  // Excluded like PAYOUT_RESERVE: parked seller shares are not custodial money, and the
  // overdraft guard covers it, so a short drain fails loudly instead of going negative.
  [
    SYSTEM.SETTLEMENT_ACCRUAL,
    { currency: 'CREDIT', debitNormal: false, class: 'excluded' },
  ],
]);

/** Everything is denominated in CREDIT except the USD accounts (see SYSTEM_TRAITS). */
export function currency(ref: AccountRef): Currency {
  // Looking up via baseOf means a shard inherits all its parent's traits, here and below.
  return SYSTEM_TRAITS.get(baseOf(ref))?.currency ?? 'CREDIT';
}

/**
 * Sorts every account into `custodial`, `excluded`, `house-asset`, or `house-liability`. Only
 * `custodial` (users' spendable) counts toward the trust total.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/
 *   Accounts & double-entry} for what each bucket holds and why only custodial raises the required
 *   cash.
 */
export function classify(
  ref: AccountRef,
): 'custodial' | 'excluded' | 'house-asset' | 'house-liability' {
  const traits = SYSTEM_TRAITS.get(baseOf(ref));
  if (traits) {
    return traits.class;
  }
  const kind = walletKindOf(ref);
  // Escrow holds a user's spendable money mid-session, so it stays custodial: the backing
  // requirement follows the money into escrow and back out.
  return kind === 'spendable' || kind === 'escrow' ? 'custodial' : 'excluded';
}

/**
 * Whether the account grows on a debit (true) rather than a credit (false). The ledger uses this
 * to sign a posted line; the no-negative-balance check uses it to read each balance right-way-up.
 */
export function isDebitNormal(ref: AccountRef): boolean {
  return SYSTEM_TRAITS.get(baseOf(ref))?.debitNormal ?? false;
}

/**
 * The accounts an operation might touch, locked before posting. A superset on purpose: extra locks
 * are harmless, too few would let operations interleave.
 *
 * `refund` and `reverse` return only the system accounts they always touch; the handler loads the
 * original transaction and adds its accounts before posting.
 */
export function accountsOf(
  operation: Operation,
  shards = 1,
  accrual = false,
): AccountRef[] {
  // TypeScript can't see that each LOCK_SETS builder reads only the fields valid for its own kind,
  // so widen the looked-up builder to a plain function via this cast. The LOCK_SETS type still
  // requires an entry per operation kind, so a forgotten kind is a compile error, not an empty
  // lock set that races the pre-check.
  const touched = LOCK_SETS[operation.kind] as (
    operation: Operation,
    shards: number,
    accrual: boolean,
  ) => AccountRef[];
  return touched(operation, shards, accrual);
}

const REVERSAL_CONTRAS: AccountRef[] = [
  SYSTEM.REVENUE,
  SYSTEM.PROMO_FLOAT,
  SYSTEM.RECEIVABLE,
];

// Per-kind lock sets. Hot kinds route shards with the same key their handler routes the legs with,
// so the lock covers the shard the posting will hit. `accrual` mirrors config.accrualDrain: under
// the accrual split, spend and subscribe park seller shares on a SETTLEMENT_ACCRUAL shard instead
// of locking each seller's earned row.
const LOCK_SETS: {
  [K in Operation['kind']]: (
    operation: Extract<Operation, { kind: K }>,
    shards: number,
    accrual: boolean,
  ) => AccountRef[];
} = {
  topUp: (o, s) => [
    spendable(o.userId),
    platformShard(SYSTEM.STORED_VALUE, o.idempotencyKey, s),
    platformShard(SYSTEM.TRUST_CASH, o.idempotencyKey, s),
    platformShard(SYSTEM.USD_CLEARING, o.idempotencyKey, s),
    // locking also plants its first-use shard row
    platformShard(SYSTEM.REVENUE_USD, o.idempotencyKey, s),
  ],
  spend: (o, s, accrual) => [
    promo(o.buyerId),
    spendable(o.buyerId),
    platformShard(SYSTEM.PROMO_FLOAT, o.idempotencyKey, s),
    platformShard(SYSTEM.REVENUE, o.idempotencyKey, s),
    ...(accrual
      ? [platformShard(SYSTEM.SETTLEMENT_ACCRUAL, o.idempotencyKey, s)]
      : (o.recipients ?? []).map((r) => earned(r.sellerId))),
  ],
  refund: () => [...REVERSAL_CONTRAS],
  clawback: (o) => [
    spendable(o.userId),
    // A chargeback cancels credits against STORED_VALUE, not REVENUE, the same way a top-up
    // issued them.
    SYSTEM.STORED_VALUE,
    SYSTEM.RECEIVABLE,
  ],
  requestPayout: (o, s) => [
    earned(o.userId),
    platformShard(SYSTEM.PAYOUT_RESERVE, o.userId, s),
  ],
  // Accrual mode also shard-routes subscribe's platform rows: without routing, every
  // subscription serializes on the two bare rows at any shard count.
  subscribe: (o, s, accrual) =>
    accrual
      ? [
          promo(o.userId),
          spendable(o.userId),
          platformShard(SYSTEM.PROMO_FLOAT, o.idempotencyKey, s),
          platformShard(SYSTEM.REVENUE, o.idempotencyKey, s),
          platformShard(SYSTEM.SETTLEMENT_ACCRUAL, o.idempotencyKey, s),
        ]
      : [
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
  // OPENING_EQUITY holds the offsetting entry.
  adjust: (o) => [o.account, SYSTEM.OPENING_EQUITY],
  reverse: () => [...REVERSAL_CONTRAS],
  // The same two accounts the payout worker touches when it gives up. The request names the seller
  // by `userId`, so this set is exact, and the reserve routes by that user id — the shard the
  // request credited.
  reversePayout: (o, s) => [
    platformShard(SYSTEM.PAYOUT_RESERVE, o.userId, s),
    earned(o.userId),
  ],
  // Settle touches no user wallet, so these four platform accounts are the full lock set. The
  // operation names only the `sagaId`; the reserve amount and seller come off the loaded saga.
  settlePayout: () => [
    SYSTEM.PAYOUT_RESERVE,
    SYSTEM.REVENUE,
    SYSTEM.USD_CLEARING,
    SYSTEM.TRUST_CASH,
  ],
};

/**
 * Pulls the wallet kind out of an id like `usr_123:spendable`. Returns null if there's no `:kind`
 * suffix or it isn't a known kind — the one parser for the shape, shared with the store adapters'
 * isKnownAccount checks.
 */
export function walletKindOf(ref: AccountRef): AccountKind | null {
  const colon = ref.lastIndexOf(':');
  if (colon < 0) {
    return null;
  }
  const suffix = ref.slice(colon + 1);
  if (
    suffix === 'spendable' ||
    suffix === 'earned' ||
    suffix === 'promo' ||
    suffix === 'escrow'
  ) {
    return suffix;
  }
  return null;
}
