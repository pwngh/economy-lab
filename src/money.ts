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
 * Money for the ledger, implemented on the vendored @pwngh/money amalgamation
 * (money.vendored.ts). This file owns what is the lab's to own — the `Currency`
 * union, the `Amount` brand, the fault codes, and the strict canonical wire — and
 * delegates the semantics underneath: i64 range checks, strict decimal parsing,
 * locale-free formatting, and mode-named rounded division. The vendored copy is
 * pinned against drift by its embedded selfTest in test/money.vendored.test.ts.
 */

import { ERROR_CODES, fault } from '#src/errors.ts';
import { format, mulDiv, parse } from '#src/money.vendored.ts';

import type { Rate } from '#src/ports.ts';

// Re-exported so call sites that divide raw minor units (fee bps, rate math) name their
// rounding mode from the one pinned implementation instead of hand-rolling `/`.
export { mulDiv } from '#src/money.vendored.ts';
export type { Rounding } from '#src/money.vendored.ts';

/** The currencies the system handles: in-app CREDIT and real-world USD. */
export type Currency = 'CREDIT' | 'USD';

/**
 * A money value: a currency plus an amount in minor units (cents for dollars). `minor` is
 * a `bigint` so it stays exact for the large totals that platform accounts reach, beyond
 * the point where `number` loses precision.
 *
 * `__brand` makes a plain `{ currency, minor }` unassignable to `Amount`. That forces
 * every amount through `toAmount` or `decodeAmount`, so the rules here cannot be bypassed.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/money-model/ The money model} for
 *   the exact-integer minor-unit design.
 */
export type Amount = {
  readonly currency: Currency;
  readonly minor: bigint;
  readonly __brand: 'Amount';
};

const FRACTION_DIGITS = 2;

/**
 * Minor units per whole unit (100 cents = $1), exported so other code — fee rounding that
 * rounds up to a whole credit — shares this one factor.
 */
export const SCALE = 100n; // 10 ** FRACTION_DIGITS

// The i64 bounds every stored amount must fit (db/mysql-schema.sql declares the legs
// column BIGINT). The bounds come with the vendored arithmetic; this pair exists only
// for the fault below.
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * Builds an `Amount` from a currency and a minor-unit count. Throws AMOUNT_OVERFLOW when
 * the count falls outside the signed 64-bit range the ledger's BIGINT columns store, so
 * an unstorable amount fails at construction rather than at the database.
 */
export function toAmount(currency: Currency, minor: bigint): Amount {
  if (minor < I64_MIN || minor > I64_MAX) {
    throw fault(
      ERROR_CODES.AMOUNT_OVERFLOW,
      `Amount is outside the 64-bit range the ledger stores.`,
      { detail: { currency } },
    );
  }
  return { currency, minor, __brand: 'Amount' };
}

export function isAmount(value: unknown): value is Amount {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === 'Amount' &&
    typeof (value as { minor?: unknown }).minor === 'bigint'
  );
}

export function isZero(amount: Amount): boolean {
  return amount.minor === 0n;
}

export function isNegative(amount: Amount): boolean {
  return amount.minor < 0n;
}

/**
 * Adds two amounts of the same currency. Throws CURRENCY_MISMATCH across currencies and
 * AMOUNT_OVERFLOW when the sum leaves the 64-bit range.
 */
export function add(a: Amount, b: Amount): Amount {
  assertSameCurrency(a, b);
  return toAmount(a.currency, a.minor + b.minor);
}

export function neg(amount: Amount): Amount {
  return toAmount(amount.currency, -amount.minor);
}

/** Throws CURRENCY_MISMATCH across currencies. */
export function compare(a: Amount, b: Amount): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) {
    return -1;
  }
  if (a.minor > b.minor) {
    return 1;
  }
  return 0;
}

export function zero(currency: Currency): Amount {
  return toAmount(currency, 0n);
}

/**
 * Builds a CREDIT `Amount` from a whole number of credits: `credits(120)` is 12,000 minor
 * units. A fractional count throws INVALID_AMOUNT; sub-credit amounts take `toAmount` with
 * minor units. Distinct from the ledger's `credit()`, which builds a posting leg.
 */
export function credits(whole: number | bigint): Amount {
  if (typeof whole === 'number' && !Number.isSafeInteger(whole)) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      'credits() takes a whole number of credits.',
      { detail: { whole: String(whole) } },
    );
  }
  return toAmount('CREDIT', BigInt(whole) * SCALE);
}

/**
 * Encodes an amount as text, such as `'CREDIT:12.34'`, for anywhere it leaves the program
 * (JSON, events, traces, HTTP). The result is a string because `JSON.stringify` cannot
 * serialize the `bigint`. It uses a fixed two decimals so the same amount always renders
 * identically; posting metadata uses this form so the bytes hashed into the tamper-evident
 * chain stay stable across replays.
 */
export function encodeAmount(amount: Amount): string {
  return `${amount.currency}:${format(amount.minor, FRACTION_DIGITS, { group: '' })}`;
}

/**
 * Parses a decimal string such as `'12.34'` or `'-0.05'` into an `Amount`. A bad format,
 * more than two decimal places, digit grouping (the canonical wire is ungrouped), or a
 * value past the 64-bit range throws INVALID_AMOUNT rather than silently accepting it.
 */
export function decodeAmount(decimal: string, currency: Currency): Amount {
  const minor = decimal.includes(',') ? null : parse(decimal, FRACTION_DIGITS);
  if (minor === null) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      `Not a ${FRACTION_DIGITS}-decimal money string: ${decimal}.`,
      { detail: { decimal, currency } },
    );
  }
  return toAmount(currency, minor);
}

/**
 * Requires a positive CREDIT amount and returns it unchanged. A wrong currency or a non-positive
 * amount is a malformed request, not a recoverable decline, so it throws a fault. `label` names the
 * offending field in the error.
 */
export function requirePositiveCredit(amount: Amount, label: string): Amount {
  if (amount.currency !== 'CREDIT') {
    throw fault(ERROR_CODES.MALFORMED_OPERATION, `${label} must be CREDIT.`, {
      detail: { label, amount: encodeAmount(amount) },
    });
  }
  if (amount.minor <= 0n) {
    throw fault(ERROR_CODES.INVALID_AMOUNT, `${label} must be positive.`, {
      detail: { label, amount: encodeAmount(amount) },
    });
  }
  return amount;
}

/**
 * Parses a wire amount such as `'CREDIT:12.34'` back into an `Amount`. The currency is the part
 * before the colon and must be one this system handles; anything else throws INVALID_AMOUNT, so a
 * string that merely contains a colon can never build an amount with a nonsense currency. This is
 * the inverse of `encodeAmount`, shared by every layer that stores or receives an amount as text:
 * the cache, the HTTP wire, and the SQL engines.
 */
export function decodeAmountWire(encoded: string): Amount {
  const colon = encoded.indexOf(':');
  const currency = colon > 0 ? encoded.slice(0, colon) : '';
  if (!isCurrency(currency)) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      `Not an encoded amount: ${encoded}.`,
      {
        detail: { encoded },
      },
    );
  }
  return decodeAmount(encoded.slice(colon + 1), currency);
}

/**
 * Converts an amount to another currency at `rate`, rounding down. A rate is an integer scaled by
 * `10^scale`, so the result is `floor(minor * rate / 10^scale)` — a true floor for either sign,
 * named as the mode at the division. Use it where rounding down is the safe direction, such as
 * paying a seller out.
 */
export function convertFloor(amount: Amount, rate: Rate, to: Currency): Amount {
  return toAmount(to, convertMinor(amount.minor, rate, 'floor'));
}

/**
 * Converts an amount to another currency at `rate`, rounding up: `ceil(minor * rate / 10^scale)`,
 * a true ceiling for either sign. Use it where rounding down would under-cover, such as the USD a
 * top-up must hold in trust.
 */
export function convertCeil(amount: Amount, rate: Rate, to: Currency): Amount {
  return toAmount(to, convertMinor(amount.minor, rate, 'ceil'));
}

// The one place conversion touches the vendored divider: minor * rate through an unbounded
// intermediate, one rounding of the named mode, result checked into i64 (re-thrown as the
// lab's overflow fault).
function convertMinor(
  minor: bigint,
  rate: Rate,
  mode: 'floor' | 'ceil',
): bigint {
  try {
    return mulDiv(minor, rate.rate, 10n ** BigInt(rate.scale), mode);
  } catch {
    throw fault(
      ERROR_CODES.AMOUNT_OVERFLOW,
      `Conversion result is outside the 64-bit range the ledger stores.`,
      { detail: { rateId: rate.rateId } },
    );
  }
}

function isCurrency(value: string): value is Currency {
  return value === 'CREDIT' || value === 'USD';
}

// Combining two currencies is always a bug, never a recoverable decline.
function assertSameCurrency(a: Amount, b: Amount): void {
  if (a.currency !== b.currency) {
    throw fault(
      ERROR_CODES.CURRENCY_MISMATCH,
      `Cannot combine ${a.currency} with ${b.currency}.`,
      { detail: { left: a.currency, right: b.currency } },
    );
  }
}

/**
 * Walks any JSON-shaped value and swaps every branded {@link Amount} for its `CREDIT:12.34` wire
 * string. The one Amount-brand walk: the SQL engines use it to store an Operation in a JSON
 * column, and the HTTP store adapter uses it for the same Operation on the wire. A per-kind
 * branch would drift as the Operation union grows; the walk cannot.
 */
export function encodeAmounts(value: unknown): unknown {
  if (isAmount(value)) {
    return encodeAmount(value);
  }
  if (Array.isArray(value)) {
    return value.map(encodeAmounts);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = encodeAmounts(inner);
    }
    return out;
  }
  return value;
}

/**
 * Reverse of {@link encodeAmounts}: every string that parses as `CURRENCY:decimal` becomes an
 * Amount again; any other string (an idempotencyKey, a sku, a source, ...) passes through
 * unchanged. A string is an encoded amount only when the whole `decodeAmountWire` parse succeeds.
 */
export function decodeAmounts(value: unknown): unknown {
  if (typeof value === 'string') {
    return tryDecodeAmountString(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeAmounts);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = decodeAmounts(inner);
    }
    return out;
  }
  return value;
}

function tryDecodeAmountString(wire: string): Amount | null {
  if (wire.indexOf(':') < 0) {
    return null;
  }
  try {
    return decodeAmountWire(wire);
  } catch {
    return null;
  }
}
