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

// Previous-hash placeholder for the start of an account's chain: 32 zero bytes. An
// account's first posting links to this.
export let GENESIS: Uint8Array = new Uint8Array(32);

/**
 * Build a debit leg for one account. Stored positive: lowers credit-normal accounts
 * (e.g. a user's spendable balance), raises debit-normal ones.
 */
export function debit(account: AccountRef, amount: Amount): Leg {
  return { account, amount };
}

/**
 * Build a credit leg for one account. Stored negated: raises credit-normal accounts
 * (e.g. a user's spendable balance), lowers debit-normal ones.
 */
export function credit(account: AccountRef, amount: Amount): Leg {
  return { account, amount: toAmount(amount.currency, -amount.minor) };
}

/**
 * Signed amount a leg moves its account's balance. Leg amounts are debit-positive, so
 * flip the sign for credit-normal accounts and leave debit-normal ones as-is.
 */
export function balanceDelta(leg: Leg): Amount {
  let sign = isDebitNormal(leg.account) ? 1n : -1n;
  return toAmount(leg.amount.currency, leg.amount.minor * sign);
}

/**
 * Validate a posting, then write it. Four checks before the write: each leg's currency
 * matches its account, leg amounts sum to zero per currency, every account exists, and no
 * user account goes negative. The database enforces these too; these are a second line of
 * defense. Only the write advances each account's hash chain and updates running balances.
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
  let cleaned = dropZeroLegs(posting);
  assertSingleCurrencyPerLeg(cleaned);
  assertBalanced(cleaned);
  await assertKnownAccounts(ledger, cleaned, options);
  await assertNoOverdraft(ledger, cleaned, options);
  return ledger.append(cleaned, options);
}

// Return the posting with zero-amount legs removed (unchanged if it has none). Safe: a zero
// leg adds nothing to any currency total and moves no money.
function dropZeroLegs(posting: Posting): Posting {
  let legs = posting.legs.filter((leg) => leg.amount.minor !== 0n);
  if (legs.length === posting.legs.length) {
    return posting;
  }
  return { ...posting, legs };
}

/**
 * The account's current balance, in its own currency. Reads a stored running total, so
 * it's O(1) rather than re-summing history.
 */
export function balance(
  ledger: Ledger,
  account: AccountRef,
  options?: Options,
): Promise<Amount> {
  return ledger.balance(account, options);
}

/**
 * Build the bytes hashed to extend one account's chain. Each link's hash covers four parts:
 * the account's previous link hash, the transaction id, this account's legs in this posting,
 * and the posting metadata. `chain.ts` runs these bytes through the hash to get the new link.
 *
 * Layout is fixed so the same posting reproduces the same bytes (and hash) on later
 * verification: amounts via `encodeAmount`, metadata keys sorted, and the four parts joined so
 * their boundaries can't be confused (see `lengthPrefixed`).
 */
export function chainPreimage(input: {
  accountPrevHash: Uint8Array;
  txnId: string;
  account: AccountRef;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
}): Uint8Array {
  let frames: Uint8Array[] = [];
  frames.push(input.accountPrevHash);
  frames.push(utf8(input.txnId));
  // Only legs touching this account belong in its chain. Sort by encoded amount so the
  // bytes are order-independent.
  let own = input.legs
    .filter((leg) => leg.account === input.account)
    .map((leg) => encodeAmount(leg.amount))
    .sort();
  frames.push(utf8(own.join('\0')));
  frames.push(utf8(canonicalMeta(input.meta)));
  return lengthPrefixed(frames);
}

/**
 * Compute one account's new link hash as lowercase hex: bytes from `chainPreimage` run
 * through the supplied hash. The result is the account's chain head; `chain.ts` later
 * combines every head into one tamper-evident checkpoint.
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
// App-side input validation, not one of the engine-enforced ledger invariants: the schema's only
// currency constraint is the value-domain CHECK (currency IN ('CREDIT','USD')); it does not verify
// a leg's currency matches its account's currency, so this rule lives only here.
function assertSingleCurrencyPerLeg(posting: Posting): void {
  for (let leg of posting.legs) {
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

// A posting balances when leg amounts sum to zero per currency (debit-positive, so debits
// and credits cancel). Any nonzero currency total means it's unbalanced; reject.
//
// Courtesy pre-check, not the enforcer. Conservation is enforced by the database (PG: a deferred
// constraint trigger on legs; MySQL: the assert inside post_entry plus revoked direct DML — see
// db/*-schema.sql). The app never constructs an unbalanced posting, so this exists only to fail fast
// with a clear fault rather than a raw engine error. It cannot let through anything the engine would.
function assertBalanced(posting: Posting): void {
  let sums = new Map<Currency, bigint>();
  for (let leg of posting.legs) {
    sums.set(
      leg.amount.currency,
      (sums.get(leg.amount.currency) ?? 0n) + leg.amount.minor,
    );
  }
  for (let [legCurrency, total] of sums) {
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
  for (let leg of posting.legs) {
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
  let resulting = new Map<AccountRef, Amount>();
  for (let leg of posting.legs) {
    if (!isUserGuarded(leg.account)) {
      continue;
    }
    let current =
      resulting.get(leg.account) ??
      (await ledger.balance(leg.account, options));
    let delta = balanceDelta(leg);
    resulting.set(
      leg.account,
      toAmount(current.currency, current.minor + delta.minor),
    );
  }
  for (let [account, projected] of resulting) {
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
  let kind = classify(account);
  return (kind === 'custodial' || kind === 'excluded') && account.includes(':');
}

// --- Turning values into stable bytes for hashing ---------------------------------

let ENCODER: TextEncoder = new TextEncoder();
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
    let obj = value as Record<string, unknown>;
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
  let total = frames.reduce((n, f) => n + 4 + f.length, 0);
  let out = new Uint8Array(total);
  let offset = 0;
  for (let frame of frames) {
    out[offset] = (frame.length >>> 24) & 0xff;
    out[offset + 1] = (frame.length >>> 16) & 0xff;
    out[offset + 2] = (frame.length >>> 8) & 0xff;
    out[offset + 3] = frame.length & 0xff;
    out.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return out;
}
