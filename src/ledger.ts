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
 * Leg `amount` is debit-positive, credit-negative everywhere. A posting balances when its leg
 * amounts sum to zero per currency. For an account's own balance change, flip the sign on
 * credit-normal accounts (see `balanceDelta`). The ledger keeps user balances non-negative and
 * every posting single-currency.
 */

import { ERROR_CODES, fault } from '#src/errors.ts';
import { encodeAmount, toAmount } from '#src/money.ts';
import { classify, currency, isDebitNormal } from '#src/accounts.ts';
import { toHex } from '#src/bytes.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Digest, Ledger, Leg, CallOptions, Posting } from '#src/ports.ts';
import type { Transaction } from '#src/contract.ts';

/**
 * Previous-hash placeholder for the start of an account's chain: 32 zero bytes. An
 * account's first posting links to this.
 */
export const GENESIS: Uint8Array = new Uint8Array(32);

/** {@link GENESIS} in lowercase hex — the one spelling every stored head compares against. */
export const GENESIS_HEX = '0'.repeat(64);

/**
 * Builds a debit leg for one account. Pass the amount positive; it is stored positive. A debit
 * lowers credit-normal accounts, such as a user's spendable balance, and raises debit-normal
 * ones. Pairing a debit with a {@link credit} of the same amount yields stored amounts that sum
 * to zero: a balanced posting.
 *
 * @example
 * const price = toAmount('CREDIT', 70_000n);
 * const legs = [
 *   debit(spendable('usr_buyer'), price),  // stored +70_000: buyer's balance falls
 *   credit(earned('usr_seller'), price),   // stored -70_000: seller's balance rises
 * ]; // sums to zero, so the posting balances
 */
export function debit(account: AccountRef, amount: Amount): Leg {
  return { account, amount };
}

/**
 * Builds a credit leg for one account. Pass the amount positive; it is stored negated, following
 * the ledger's debit-positive convention. A credit raises credit-normal accounts, such as a
 * user's spendable balance, and lowers debit-normal ones. See {@link debit} for the balanced-pair
 * example.
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
 * Locks each account in one global order: `.sort()` by raw character code, identical on every
 * machine unlike a locale-aware comparison. Two operations that share an account acquire its lock
 * in the same order, so neither can deadlock waiting on a lock the other holds. Every lock-set goes
 * through here, so the fixed-order discipline lives in one place.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/concurrency/ Concurrency} for the
 *   deadlock-free lock ordering and the no-fork constraint that backs it.
 */
export async function lockAll(
  ledger: Ledger,
  accounts: ReadonlyArray<AccountRef>,
  options?: CallOptions,
): Promise<void> {
  const ordered = [...new Set(accounts)].sort();
  // `lockMany` grabs the whole set in one round trip (Postgres' ordered `for update`); either path
  // acquires in the same global order.
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
  options?: CallOptions,
): Promise<Transaction> {
  // The schema forbids zero-amount legs (`legs.amount <> 0`); they arise when a split rounds a
  // share down to zero. Dropping them here, the one path every posting takes, keeps the in-memory
  // store and the SQL backends consistent.
  const cleaned = dropZeroLegs(posting);
  assertSingleCurrencyPerLeg(cleaned);
  assertBalanced(cleaned);
  await assertKnownAccounts(ledger, cleaned, options);
  await assertNoOverdraft(ledger, cleaned, options);
  return ledger.append(cleaned, options);
}

// Safe to drop: a zero leg adds nothing to any currency total, so removing it can't unbalance the
// posting.
function dropZeroLegs(posting: Posting): Posting {
  const legs = posting.legs.filter((leg) => leg.amount.minor !== 0n);
  if (legs.length === posting.legs.length) {
    return posting;
  }
  return { ...posting, legs };
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

/** The account's new chain head: the `chainPreimage` bytes through the digest, as lowercase hex. */
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

// Each leg's amount must match its account's currency; a mixed posting is rejected with
// CURRENCY_MISMATCH. The SQL engines enforce this natively via a composite FK to
// (accounts.id, currency); this app-side check gives the coded fault early and covers the
// in-memory store, which has no FK.
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

// A typo must not create a new account and strand a balance on it. `post_entry` legitimately
// creates first-use accounts from `p_new_accounts`; this guards an account that was neither
// pre-existing nor being created.
async function assertKnownAccounts(
  ledger: Ledger,
  posting: Posting,
  options?: CallOptions,
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

// `screenFunds` should already have rejected anyone short, so this backstop normally never trips;
// if it does, something earlier went wrong — typically a missing lock let two ops race — so it
// throws a distinct OVERDRAFT fault rather than quietly rejecting.
async function assertNoOverdraft(
  ledger: Ledger,
  posting: Posting,
  options?: CallOptions,
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

// The accounts this guard keeps non-negative: user wallets plus the `excluded`-class escrows
// (payout reserve, settlement accrual). Platform asset/liability accounts swing either way,
// so they are skipped.
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
