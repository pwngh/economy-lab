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

import { ERROR_CODES, fault } from '#src/errors.ts';

/**
 * Currencies the system handles: in-app CREDIT and real-world USD. String union, not
 * an enum, so a new currency can be added here without touching call sites.
 */
export type Currency = 'CREDIT' | 'USD';

/**
 * A money value: currency plus amount in minor units (cents for dollars). `minor` is a
 * `bigint` to stay exact for the large totals platform accounts reach, past where
 * `number` loses precision.
 *
 * `__brand` makes a plain `{ currency, minor }` unassignable to `Amount`, forcing every
 * amount through `toAmount` / `decodeAmount` so the rules here can't be bypassed.
 */
export type Amount = {
  readonly currency: Currency;
  readonly minor: bigint;
  readonly __brand: 'Amount';
};

// How many decimal places a whole unit has (2, like dollars and cents).
const FRACTION_DIGITS = 2;

/**
 * Minor units per whole unit (100 cents = $1). Exported so other code (e.g. fee
 * rounding up to a whole credit) shares the factor; encode/decode both read it so they
 * can't disagree on scale.
 */
export const SCALE = 100n; // 10 ** FRACTION_DIGITS

/** Build an `Amount` from a currency and a minor-unit count. */
export function toAmount(currency: Currency, minor: bigint): Amount {
  return { currency, minor, __brand: 'Amount' };
}

/** Type guard: true when `value` is a real `Amount` (has the brand and a bigint minor). */
export function isAmount(value: unknown): value is Amount {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === 'Amount' &&
    typeof (value as { minor?: unknown }).minor === 'bigint'
  );
}

/** True when the amount is exactly zero. */
export function isZero(amount: Amount): boolean {
  return amount.minor === 0n;
}

/** True when the amount is less than zero. */
export function isNegative(amount: Amount): boolean {
  return amount.minor < 0n;
}

/** Add two amounts of the same currency; throws CURRENCY_MISMATCH across currencies. */
export function add(a: Amount, b: Amount): Amount {
  assertSameCurrency(a, b);
  return toAmount(a.currency, a.minor + b.minor);
}

/** Flip the sign of an amount. */
export function neg(amount: Amount): Amount {
  return toAmount(amount.currency, -amount.minor);
}

/**
 * Compare two amounts of the same currency: -1, 0, or 1. Throws CURRENCY_MISMATCH
 * across currencies.
 */
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

/** A zero amount in the given currency. */
export function zero(currency: Currency): Amount {
  return toAmount(currency, 0n);
}

/**
 * Encode an amount as text, e.g. `'CREDIT:12.34'`, for anywhere it leaves the program
 * (JSON, events, traces, HTTP). String because `JSON.stringify` can't serialize the
 * `bigint`; fixed two decimals so the same amount always renders identically.
 */
export function encodeAmount(amount: Amount): string {
  let negative = amount.minor < 0n;
  let abs = negative ? -amount.minor : amount.minor;
  let whole = abs / SCALE;
  let frac = abs % SCALE;
  let decimal = `${whole}.${frac.toString().padStart(FRACTION_DIGITS, '0')}`;
  return `${amount.currency}:${negative ? '-' : ''}${decimal}`;
}

/**
 * Parse a decimal string (`'12.34'`, `'-0.05'`) into an `Amount`. Bad format or more
 * than two decimal places throws INVALID_AMOUNT rather than dropping the extra digits.
 */
export function decodeAmount(decimal: string, currency: Currency): Amount {
  let match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(decimal);
  if (!match) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      `Not a ${FRACTION_DIGITS}-decimal money string: ${decimal}.`,
      { detail: { decimal, currency } },
    );
  }
  let sign = match[1] === '-' ? -1n : 1n;
  let whole = BigInt(match[2]!);
  let frac = BigInt((match[3] ?? '').padEnd(FRACTION_DIGITS, '0'));
  return toAmount(currency, sign * (whole * SCALE + frac));
}

// Throw CURRENCY_MISMATCH if the amounts are in different currencies; combining them is
// always a bug.
function assertSameCurrency(a: Amount, b: Amount): void {
  if (a.currency !== b.currency) {
    throw fault(
      ERROR_CODES.CURRENCY_MISMATCH,
      `Cannot combine ${a.currency} with ${b.currency}.`,
      { detail: { left: a.currency, right: b.currency } },
    );
  }
}
