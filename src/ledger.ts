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

// Every leg's `amount` is signed the same way across the whole codebase: positive for
// a debit, negative for a credit. With that one convention, a posting balances exactly
// when its leg amounts add up to zero in each currency. To get the amount the way it
// changed a specific account, flip the sign for accounts that grow on a credit (see
// `balanceDelta`). The ledger keeps each user's spendable balance from going negative,
// keeps every posting in a single currency, and never silently mixes two currencies.

import { ERROR_CODES, fault } from '#src/errors.ts';
import { encodeAmount, toAmount } from '#src/money.ts';
import { classify, currency, isDebitNormal } from '#src/accounts.ts';
import { toHex } from '#src/bytes.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Digest, Ledger, Leg, Options, Posting } from '#src/ports.ts';
import type { Transaction } from '#src/contract.ts';

// The stand-in "previous hash" used at the very start of an account's hash chain: 32
// zero bytes. An account's first posting has nothing before it, so it links to this.
export let GENESIS: Uint8Array = new Uint8Array(32);

/**
 * Build a debit line (a "leg") for one account. Stored with a positive amount. This
 * lowers accounts that grow on a credit (such as a user's spendable balance) and
 * raises accounts that grow on a debit.
 */
export function debit(account: AccountRef, amount: Amount): Leg {
  return { account, amount };
}

/**
 * Build a credit line (a "leg") for one account. Stored with a negated amount. This
 * raises accounts that grow on a credit (such as a user's spendable balance) and
 * lowers accounts that grow on a debit.
 */
export function credit(account: AccountRef, amount: Amount): Leg {
  return { account, amount: toAmount(amount.currency, -amount.minor) };
}

/**
 * How much a leg moves its account's balance, as a positive-or-negative amount.
 * Leg amounts are stored debit-positive; an account that grows on a credit uses the
 * opposite sign, so this flips the stored amount for those accounts and leaves it
 * as-is for accounts that grow on a debit.
 */
export function balanceDelta(leg: Leg): Amount {
  let sign = isDebitNormal(leg.account) ? 1n : -1n;
  return toAmount(leg.amount.currency, leg.amount.minor * sign);
}

/**
 * Check a posting and, if it passes, write it to the ledger. The four checks run
 * before the write: every leg's currency matches its account, the leg amounts add up
 * to zero in each currency (so the posting balances), every account already exists,
 * and no user account would be driven negative. The database enforces these too, so
 * the checks here are a second line of defense. Only the final write advances each
 * account's hash chain and updates the stored running balances.
 */
export async function postEntry(
  ledger: Ledger,
  posting: Posting,
  options?: Options,
): Promise<Transaction> {
  // First drop any leg that moves nothing (amount zero). A zero-amount leg is a no-op: it can't
  // change a balance and adds nothing to a currency's total, so removing it never unbalances the
  // posting. But it is still a row the store would try to write, and the schema forbids it
  // (`legs.amount <> 0`). Such a leg shows up when a split rounds a share down to zero — say a
  // recipient's tiny cut of a promo-funded sale. The in-memory store would keep it while a SQL
  // store rejects it, so the two would disagree; dropping it here, in the one place every posting
  // passes through, keeps every storage backend identical.
  let cleaned = dropZeroLegs(posting);
  assertSingleCurrencyPerLeg(cleaned);
  assertBalanced(cleaned);
  await assertKnownAccounts(ledger, cleaned, options);
  await assertNoOverdraft(ledger, cleaned, options);
  return ledger.append(cleaned, options);
}

// Return the posting with every zero-amount leg removed, or the same posting unchanged when it
// has none. Removing a zero leg is always safe: it adds nothing to any currency's total (so the
// posting still balances) and represents no actual movement of money.
function dropZeroLegs(posting: Posting): Posting {
  let legs = posting.legs.filter((leg) => leg.amount.minor !== 0n);
  if (legs.length === posting.legs.length) {
    return posting;
  }
  return { ...posting, legs };
}

/**
 * The account's current balance, in its own currency. This reads a stored running
 * total, so it returns in constant time rather than re-summing the account's history.
 */
export function balance(
  ledger: Ledger,
  account: AccountRef,
  options?: Options,
): Promise<Amount> {
  return ledger.balance(account, options);
}

/**
 * Build the exact bytes that get hashed to extend one account's hash chain. Each
 * account has a chain of postings, where each link's hash is computed from the bytes
 * below: the account's previous link hash, the transaction id, this account's legs in
 * this posting, and the posting's metadata, all joined together. `chain.ts` takes
 * these bytes and runs them through the hash function to produce the new link hash.
 *
 * The byte layout is fixed so the same posting always produces the same bytes (and
 * therefore the same hash) when it is verified later: amounts are encoded with
 * `encodeAmount`, metadata keys are sorted, and the four parts are joined so their
 * boundaries can't be confused (see `lengthPrefixed`).
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
  // Only the legs that touch this account belong in this account's chain. Sort them by
  // their encoded amount so the bytes come out the same no matter what order the legs
  // arrived in.
  let own = input.legs
    .filter((leg) => leg.account === input.account)
    .map((leg) => encodeAmount(leg.amount))
    .sort();
  frames.push(utf8(own.join('\0')));
  frames.push(utf8(canonicalMeta(input.meta)));
  return lengthPrefixed(frames);
}

/**
 * Compute the new link hash for one account's chain and return it as lowercase hex.
 * Builds the bytes with `chainPreimage`, then runs them through the supplied hash
 * function. The result becomes that account's latest chain hash ("head"); `chain.ts`
 * later combines every account's head into a single tamper-evident checkpoint.
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

// Each leg's amount must be in the same currency as the account it posts to. There are
// two currencies here, USD and the in-app CREDIT: a USD account only takes USD amounts,
// and a CREDIT account only takes CREDIT amounts. Putting a USD amount on a CREDIT
// account, or the reverse, would mix two currencies in one posting, so it is rejected
// with a CURRENCY_MISMATCH fault.
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

// A posting balances when its leg amounts add up to zero in each currency (amounts are
// stored debit-positive, so debits and credits cancel). If any currency's legs sum to
// something other than zero, the posting is unbalanced and is rejected.
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

// Every account named in the posting must already exist. A leg pointing at an account
// the ledger has never seen is rejected, so a typo can't quietly create a new account
// and strand a balance on it.
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

// Last-resort guard against driving a user's balance negative. By the time a posting
// reaches here, an up-front funds check (`screenFunds`) should already have turned away
// anyone short on money with an INSUFFICIENT_FUNDS rejection, so this should never
// trip. If it does, something earlier went wrong (typically a missing lock let two
// operations race), and we want that to be loud: it throws a separate OVERDRAFT fault
// rather than a quiet rejection. Only real user accounts are checked, since they are
// not allowed to go negative; the platform's own accounts may legitimately hold either
// sign and are skipped (see `isUserGuarded`).
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

// Whether this account is one the overdraft check protects. True for every real user
// account (spendable, earned, promo) and for the payout-reserve escrow account
// (PAYOUT_RESERVE) — none of these may go negative. False for the platform's
// asset and liability accounts, which are allowed to swing either way by design.
// `classify` (in accounts.ts) sorts every account into one of these groups.
function isUserGuarded(account: AccountRef): boolean {
  let kind = classify(account);
  return (kind === 'custodial' || kind === 'excluded') && account.includes(':');
}

// --- Turning values into stable bytes for hashing ---------------------------------

let ENCODER: TextEncoder = new TextEncoder();
function utf8(value: string): Uint8Array {
  return ENCODER.encode(value);
}

// Serialize a value to JSON with object keys always in sorted order. Sorting matters
// because the database does not preserve key order when it stores and reloads JSON, so
// without it the same metadata could serialize differently and produce a different hash
// on replay. Any money amounts inside the metadata must already be encoded as strings
// before they get here (a raw bigint is rejected below).
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
    // A raw bigint here means an amount was put into the metadata without first being
    // encoded to a string, which is a bug — reject it instead of guessing a format.
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

// Join several byte chunks into one, writing each chunk's length (as 4 bytes, most
// significant byte first) right before it. The length prefix records where each chunk
// ends, so the pieces can't run together: no chunk's contents can be mistaken for the
// start of the next one, which would otherwise let two different inputs hash the same.
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
