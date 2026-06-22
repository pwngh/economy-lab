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
 * The currencies the system handles: in-app CREDIT and real-world USD. This is a
 * plain string union rather than an enum so a new currency can be added here without
 * editing the places that use it.
 */
export type Currency = 'CREDIT' | 'USD';

/**
 * A money value: a currency plus an amount in minor units (the smallest whole unit,
 * like cents for dollars). The amount is a `bigint`, so it stays exact even for the
 * very large totals the platform's own accounts reach, well past the point where a
 * regular JavaScript `number` starts losing precision.
 *
 * The `__brand` field is a TypeScript trick: a plain `{ currency, minor }` object
 * can't be used where an `Amount` is expected, which forces every amount to be
 * created through `toAmount` or `decodeAmount` and keeps the rules in this file from
 * being bypassed.
 */
export type Amount = {
  readonly currency: Currency;
  readonly minor: bigint;
  readonly __brand: 'Amount';
};

// How many decimal places a whole unit has (2, like dollars and cents).
const FRACTION_DIGITS = 2;

/**
 * How many minor units make one whole unit (100 minor units = 1 whole, i.e. 100
 * cents = $1). It is exported because other code, such as the fee rounding that
 * rounds up to a whole credit, needs the same factor. Encoding and decoding both
 * read this single value so they can never disagree on the scale.
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

/**
 * Add two amounts of the same currency. Adding two different currencies makes no
 * sense, so it throws a CURRENCY_MISMATCH error instead of silently combining them.
 */
export function add(a: Amount, b: Amount): Amount {
  assertSameCurrency(a, b);
  return toAmount(a.currency, a.minor + b.minor);
}

/** Flip the sign of an amount (positive becomes negative and vice versa). */
export function neg(amount: Amount): Amount {
  return toAmount(amount.currency, -amount.minor);
}

/**
 * Compare two amounts of the same currency, returning -1, 0, or 1 (less, equal,
 * greater). Comparing across currencies is meaningless, so it throws a
 * CURRENCY_MISMATCH error.
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
 * Turn an amount into its text form, like `'CREDIT:12.34'`. This is used wherever an
 * amount leaves the program as text (JSON, events, traces, HTTP). Two reasons it has
 * to be a string: `JSON.stringify` can't serialize the `bigint` directly, and using
 * a fixed two decimal places means the same amount always produces the exact same
 * text on any machine.
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
 * Parse a decimal string such as `'12.34'` or `'-0.05'` into an `Amount` of the given
 * currency. Anything that isn't a valid amount — bad format, or more than two decimal
 * places — throws an INVALID_AMOUNT error rather than quietly dropping the extra
 * digits, so a malformed string can never turn into a wrong amount.
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

// Throw a CURRENCY_MISMATCH error if the two amounts are in different currencies.
// Combining two currencies in one operation is always a bug, so it fails loudly here.
function assertSameCurrency(a: Amount, b: Amount): void {
  if (a.currency !== b.currency) {
    throw fault(
      ERROR_CODES.CURRENCY_MISMATCH,
      `Cannot combine ${a.currency} with ${b.currency}.`,
      { detail: { left: a.currency, right: b.currency } },
    );
  }
}
