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

import type { Rate } from '#src/ports.ts';

/**
 * The currencies the system handles: in-app CREDIT and real-world USD. This is a string
 * union rather than an enum so a new currency can be added here without touching call
 * sites.
 */
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

// How many decimal places a whole unit has (2, like dollars and cents).
const FRACTION_DIGITS = 2;

/**
 * The number of minor units per whole unit (100 cents = $1). It is exported so other code
 * shares this one factor, such as fee rounding that rounds up to a whole credit. Both
 * `encodeAmount` and `decodeAmount` read it, so they cannot disagree on the scale.
 */
export const SCALE = 100n; // 10 ** FRACTION_DIGITS

/** Builds an `Amount` from a currency and a minor-unit count. */
export function toAmount(currency: Currency, minor: bigint): Amount {
  return { currency, minor, __brand: 'Amount' };
}

/** Reports whether `value` is a real `Amount`, meaning it has the brand and a bigint minor. */
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

/** Adds two amounts of the same currency. Throws CURRENCY_MISMATCH across currencies. */
export function add(a: Amount, b: Amount): Amount {
  assertSameCurrency(a, b);
  return toAmount(a.currency, a.minor + b.minor);
}

/** Flips the sign of an amount. */
export function neg(amount: Amount): Amount {
  return toAmount(amount.currency, -amount.minor);
}

/**
 * Compares two amounts of the same currency and returns -1, 0, or 1. Throws
 * CURRENCY_MISMATCH across currencies.
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

/** Returns a zero amount in the given currency. */
export function zero(currency: Currency): Amount {
  return toAmount(currency, 0n);
}

/**
 * Encodes an amount as text, such as `'CREDIT:12.34'`, for anywhere it leaves the program
 * (JSON, events, traces, HTTP). The result is a string because `JSON.stringify` cannot
 * serialize the `bigint`. It uses a fixed two decimals so the same amount always renders
 * identically; posting metadata uses this form so the bytes hashed into the tamper-evident
 * chain stay stable across replays.
 */
export function encodeAmount(amount: Amount): string {
  const negative = amount.minor < 0n;
  const abs = negative ? -amount.minor : amount.minor;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  const decimal = `${whole}.${frac.toString().padStart(FRACTION_DIGITS, '0')}`;
  return `${amount.currency}:${negative ? '-' : ''}${decimal}`;
}

/**
 * Parses a decimal string such as `'12.34'` or `'-0.05'` into an `Amount`. A bad format,
 * or more than two decimal places, throws INVALID_AMOUNT rather than silently dropping the
 * extra digits.
 */
export function decodeAmount(decimal: string, currency: Currency): Amount {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(decimal);
  if (!match) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      `Not a ${FRACTION_DIGITS}-decimal money string: ${decimal}.`,
      { detail: { decimal, currency } },
    );
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]!);
  const frac = BigInt((match[3] ?? '').padEnd(FRACTION_DIGITS, '0'));
  return toAmount(currency, sign * (whole * SCALE + frac));
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
 * before the colon, and the decimal value the part after. This is the inverse of `encodeAmount`,
 * shared by every layer that stores or receives an amount as text: the cache, the HTTP wire, and the
 * SQL engines.
 */
export function decodeAmountWire(encoded: string): Amount {
  const colon = encoded.indexOf(':');
  const currency = encoded.slice(0, colon) as Currency;
  return decodeAmount(encoded.slice(colon + 1), currency);
}

/**
 * Converts an amount to another currency at `rate`, rounding down. A rate is an integer scaled by
 * `10^scale`, so the result is `floor(minor * rate / 10^scale)`. Use it where truncation is the safe
 * direction, such as paying a seller out.
 */
export function convertFloor(amount: Amount, rate: Rate, to: Currency): Amount {
  return toAmount(to, (amount.minor * rate.rate) / 10n ** BigInt(rate.scale));
}

/**
 * Converts an amount to another currency at `rate`, rounding up. It computes `ceil(minor * rate /
 * 10^scale)` by adding `denominator - 1` before the integer divide. Use it where rounding down would
 * under-cover, such as the USD a top-up must hold in trust.
 */
export function convertCeil(amount: Amount, rate: Rate, to: Currency): Amount {
  const denominator = 10n ** BigInt(rate.scale);
  return toAmount(
    to,
    (amount.minor * rate.rate + denominator - 1n) / denominator,
  );
}

// Throws CURRENCY_MISMATCH if the amounts are in different currencies. Combining two
// currencies is always a bug.
function assertSameCurrency(a: Amount, b: Amount): void {
  if (a.currency !== b.currency) {
    throw fault(
      ERROR_CODES.CURRENCY_MISMATCH,
      `Cannot combine ${a.currency} with ${b.currency}.`,
      { detail: { left: a.currency, right: b.currency } },
    );
  }
}
