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

// Leg `amount` is debit-positive, credit-negative everywhere. A posting balances when its
// leg amounts sum to zero per currency. For an account's own balance change, flip the sign
// on credit-normal accounts (see `balanceDelta`). The ledger keeps user balances non-negative
// and every posting single-currency.

import { ERROR_CODES, fault } from '#src/errors.ts';
import { encodeAmount, toAmount } from '#src/money.ts';
import { classify, currency, isDebitNormal } from '#src/accounts.ts';
import { toHex } from '#src/bytes.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Digest, Ledger, Leg, Options, Posting } from '#src/ports.ts';
import type { Transaction } from '#src/contract.ts';

/**
 * Previous-hash placeholder for the start of an account's chain: 32 zero bytes. An
 * account's first posting links to this.
 */
export const GENESIS: Uint8Array = new Uint8Array(32);

/**
 * Builds a debit leg for one account. The amount is stored positive. A debit lowers
 * credit-normal accounts, such as a user's spendable balance, and raises debit-normal ones.
 */
export function debit(account: AccountRef, amount: Amount): Leg {
  return { account, amount };
}

/**
 * Builds a credit leg for one account. The amount is stored negated. A credit raises
 * credit-normal accounts, such as a user's spendable balance, and lowers debit-normal ones.
 */
export function credit(account: AccountRef, amount: Amount): Leg {
  return { account, amount: toAmount(amount.currency, -amount.minor) };
}

/**
 * Returns the signed amount by which a leg moves its account's balance. Leg amounts are
 * debit-positive, so this flips the sign for credit-normal accounts and leaves debit-normal
 * ones unchanged.
 */
export function balanceDelta(leg: Leg): Amount {
  const sign = isDebitNormal(leg.account) ? 1n : -1n;
  return toAmount(leg.amount.currency, leg.amount.minor * sign);
}

/**
 * Takes the per-transaction lock on each of `accounts` in one global order. The order is
 * `.sort()` by id, which sorts by raw character code. That order is the same on every machine,
 * unlike a locale-aware comparison. The list is then de-duplicated. Two operations that share an
 * account acquire its lock in the same order, so neither can deadlock waiting on a lock the other
 * holds. Every lock-set goes through here, so the fixed-order discipline lives in one place rather
 * than being re-implemented, and possibly mis-ordered, at each call site.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/concurrency/ Concurrency} for the
 *   deadlock-free lock ordering and the no-fork constraint that backs it.
 */
export async function lockAll(
  ledger: Ledger,
  accounts: ReadonlyArray<AccountRef>,
  options?: Options,
): Promise<void> {
  const ordered = [...new Set(accounts)].sort();
  // An engine with `lockMany` grabs the whole set in one round trip (Postgres' ordered `for update`),
  // whose own ordering is what keeps it deadlock-free. Without it, lock one at a time in this same
  // global `.sort()` order — same discipline that keeps the loop deadlock-free.
  if (ledger.lockMany) {
    await ledger.lockMany(ordered, options);
    return;
  }
  for (const account of ordered) {
    await ledger.lock(account, options);
  }
}

/**
 * Validates a posting, then writes it. Four pre-write checks (currency match, balanced,
 * accounts exist, no user overdraft) are a redundant second line of defense; the database
 * enforces them too. Only the write advances each account's hash chain and running balances.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/
 *   Accounts & double-entry} for the posting model these checks enforce.
 */
export async function postEntry(
  ledger: Ledger,
  posting: Posting,
  options?: Options,
): Promise<Transaction> {
  // Drop zero-amount legs first. They're no-ops (don't change a balance, don't affect a
  // currency total, so removing them can't unbalance the posting), but the schema forbids the
  // row (`legs.amount <> 0`). They arise when a split rounds a share down to zero (e.g. a tiny
  // cut of a promo-funded sale). The in-memory store would keep one while SQL rejects it;
  // dropping it here, the one path every posting takes, keeps backends consistent.
  const cleaned = dropZeroLegs(posting);
  assertSingleCurrencyPerLeg(cleaned);
  assertBalanced(cleaned);
  await assertKnownAccounts(ledger, cleaned, options);
  await assertNoOverdraft(ledger, cleaned, options);
  return ledger.append(cleaned, options);
}

// Returns the posting with zero-amount legs removed, or unchanged if it has none. This is safe
// because a zero leg adds nothing to any currency total and moves no money.
function dropZeroLegs(posting: Posting): Posting {
  const legs = posting.legs.filter((leg) => leg.amount.minor !== 0n);
  if (legs.length === posting.legs.length) {
    return posting;
  }
  return { ...posting, legs };
}

/**
 * Returns the account's current balance, in its own currency. Reads a stored running total,
 * so the call is O(1) rather than re-summing history.
 */
export function balance(
  ledger: Ledger,
  account: AccountRef,
  options?: Options,
): Promise<Amount> {
  return ledger.balance(account, options);
}

/**
 * Builds the bytes hashed to extend one account's chain. Each link commits to the account's prior
 * head, so altering a past entry stops the chain re-deriving. The hash covers four parts: the prior
 * link hash, the transaction id, this account's legs, and the posting metadata. The layout is fixed
 * (amounts via `encodeAmount`, metadata keys sorted, parts joined via `lengthPrefixed`) so the same
 * posting reproduces the same bytes, and hash, on later verification.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 *   hash-chain design.
 */
export function chainPreimage(input: {
  accountPrevHash: Uint8Array;
  txnId: string;
  account: AccountRef;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
}): Uint8Array {
  const frames: Uint8Array[] = [];
  frames.push(input.accountPrevHash);
  frames.push(utf8(input.txnId));
  // Only legs touching this account belong in its chain. Sort by encoded amount so the
  // bytes are order-independent.
  const own = input.legs
    .filter((leg) => leg.account === input.account)
    .map((leg) => encodeAmount(leg.amount))
    .sort();
  frames.push(utf8(own.join('\0')));
  frames.push(utf8(canonicalMeta(input.meta)));
  return lengthPrefixed(frames);
}

/**
 * Computes one account's new link hash as lowercase hex by running the bytes from
 * `chainPreimage` through the supplied hash. The result is the account's chain head, which
 * `chain.ts` later combines with every other head into one tamper-evident checkpoint.
 */
export async function chainHash(
  digest: Digest,
  input: {
    accountPrevHash: Uint8Array;
    txnId: string;
    account: AccountRef;
    legs: ReadonlyArray<Leg>;
    meta: Record<string, unknown>;
  },
): Promise<string> {
  return toHex(await digest.hash(chainPreimage(input)));
}

// --- Validation ------------------------------------------------------------------

// Each leg's amount must match its account's currency. Two currencies exist, USD and the
// in-app CREDIT; a USD amount on a CREDIT account (or vice versa) mixes currencies in one
// posting and is rejected with CURRENCY_MISMATCH.
//
// The SQL engines also enforce this natively: each leg carries a composite FK to
// (accounts.id, currency). This app-side check exists for the early, coded CURRENCY_MISMATCH
// fault and for the in-memory store, which has no FK.
function assertSingleCurrencyPerLeg(posting: Posting): void {
  for (const leg of posting.legs) {
    if (leg.amount.currency !== currency(leg.account)) {
      throw fault(
        ERROR_CODES.CURRENCY_MISMATCH,
        'A leg currency does not match its account.',
        {
          detail: {
            txnId: posting.txnId,
            account: leg.account,
            legCurrency: leg.amount.currency,
            accountCurrency: currency(leg.account),
          },
        },
      );
    }
  }
}

// A posting balances when leg amounts sum to zero per currency; any nonzero total is rejected.
//
// Redundant pre-check; not the enforcer. Conservation is enforced by the database (PG: a deferred
// constraint trigger on legs; MySQL: the assert inside post_entry plus revoked direct DML; see
// db/*-schema.sql). The app never constructs an unbalanced posting, so this exists only to fail fast
// with a clear fault rather than a raw engine error. It cannot let through anything the engine would.
function assertBalanced(posting: Posting): void {
  const sums = new Map<Currency, bigint>();
  for (const leg of posting.legs) {
    sums.set(
      leg.amount.currency,
      (sums.get(leg.amount.currency) ?? 0n) + leg.amount.minor,
    );
  }
  for (const [legCurrency, total] of sums) {
    if (total !== 0n) {
      throw fault(
        ERROR_CODES.LEDGER_UNBALANCED,
        'A posting does not balance.',
        {
          detail: {
            txnId: posting.txnId,
            currency: legCurrency,
            residual: encodeAmount(toAmount(legCurrency, total)),
          },
        },
      );
    }
  }
}

// Every account named in the posting must already exist, so a typo can't create a new
// account and strand a balance on it.
//
// App-side input validation: the legs->accounts foreign key would also reject a leg on a
// truly-unknown account, but the app checks first to return a clear UNKNOWN_ACCOUNT fault rather
// than a raw FK error. `post_entry` legitimately creates first-use accounts from `p_new_accounts`;
// this guards a typo'd account that was neither pre-existing nor being created.
async function assertKnownAccounts(
  ledger: Ledger,
  posting: Posting,
  options?: Options,
): Promise<void> {
  for (const leg of posting.legs) {
    if (!(await ledger.hasAccount(leg.account, options))) {
      throw fault(
        ERROR_CODES.UNKNOWN_ACCOUNT,
        'A posting names an unknown account.',
        {
          detail: { txnId: posting.txnId, account: leg.account },
        },
      );
    }
  }
}

// Last-resort guard against a negative user balance. The database's per-user non-negative CHECK
// is the real enforcer; this app guard is a last-resort backstop that converts what would be a
// raw engine rejection into a distinct OVERDRAFT fault. An up-front funds check (`screenFunds`)
// should already have rejected anyone short with INSUFFICIENT_FUNDS, so this normally never
// trips. If it does, something earlier went wrong (typically a missing lock let two ops race);
// throw a distinct OVERDRAFT fault rather than a quiet rejection. Only user accounts are
// checked; platform accounts may hold either sign and are skipped (see `isUserGuarded`).
async function assertNoOverdraft(
  ledger: Ledger,
  posting: Posting,
  options?: Options,
): Promise<void> {
  const resulting = new Map<AccountRef, Amount>();
  for (const leg of posting.legs) {
    if (!isUserGuarded(leg.account)) {
      continue;
    }
    const current =
      resulting.get(leg.account) ??
      (await ledger.balance(leg.account, options));
    const delta = balanceDelta(leg);
    resulting.set(
      leg.account,
      toAmount(current.currency, current.minor + delta.minor),
    );
  }
  for (const [account, projected] of resulting) {
    if (projected.minor < 0n) {
      throw fault(
        ERROR_CODES.OVERDRAFT,
        'A posting would overdraw a user account.',
        {
          detail: { account, projected: encodeAmount(projected) },
        },
      );
    }
  }
}

// Whether the overdraft check protects this account. True for user accounts (spendable,
// earned, promo) and the payout-reserve escrow (PAYOUT_RESERVE), none of which may go
// negative. False for platform asset/liability accounts, which may swing either way.
// `classify` (accounts.ts) groups every account.
function isUserGuarded(account: AccountRef): boolean {
  const kind = classify(account);
  return (kind === 'custodial' || kind === 'excluded') && account.includes(':');
}

// --- Turning values into stable bytes for hashing ---------------------------------

const ENCODER: TextEncoder = new TextEncoder();
function utf8(value: string): Uint8Array {
  return ENCODER.encode(value);
}

// Serialize to JSON with object keys sorted. The database doesn't preserve key order across
// store/reload, so without sorting the same metadata could serialize differently and hash
// differently on replay. Money amounts must already be encoded as strings (raw bigint is
// rejected below).
function canonicalMeta(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalMeta).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalMeta(obj[k])}`)
      .join(',')}}`;
  }
  if (typeof value === 'bigint') {
    // A raw bigint here means an amount went into metadata unencoded, a bug. Reject rather
    // than guess a format.
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'A bigint reached canonical meta unencoded.',
      {
        detail: { value: value.toString() },
      },
    );
  }
  return JSON.stringify(value);
}

// Join byte chunks into one, each prefixed with its length (4 bytes, big-endian). The prefix
// marks where each chunk ends so chunks can't run together, which would otherwise let two
// different inputs hash the same.
function lengthPrefixed(frames: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = frames.reduce((n, f) => n + 4 + f.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    out[offset] = (frame.length >>> 24) & 0xff;
    out[offset + 1] = (frame.length >>> 16) & 0xff;
    out[offset + 2] = (frame.length >>> 8) & 0xff;
    out[offset + 3] = frame.length & 0xff;
    out.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return out;
}
