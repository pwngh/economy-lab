/**
 * @pwngh/economy-money
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/**
 * The typed value face over the ledger's `CURRENCY:decimal` wire amount.
 *
 * Malformed input throws. A wire amount is written by this system, not typed by a client: one
 * that will not parse means code upstream built it wrong, so a `null` return would carry that
 * bug forward into whatever reads the money next. Every failure here is the lab's own
 * `EconomyError` under `MONEY.INVALID_AMOUNT`, so a caller catches one error vocabulary.
 *
 * The arithmetic belongs to `@pwngh/economy-lab`. This module parses no decimals, rounds
 * nothing, and checks no ranges of its own.
 */

import {
  add as addAmounts,
  compare as compareAmounts,
  decodeAmountWire,
  encodeAmount,
  EconomyError,
  ERROR_CODES,
  isZero as isZeroAmount,
  negate,
  toAmount,
  zero,
} from '@pwngh/economy-lab';
import type { Amount, Currency } from '@pwngh/economy-lab';

import type { WireValue } from './wire-value.js';

/**
 * The lab's amount constructors, verbatim. `credits(120)` builds an {@link Amount} for an
 * operation; {@link Money.from} parses one off the wire — different jobs, one name each.
 */
export { credits, usd } from '@pwngh/economy-lab';

/**
 * Initializer for a money value. A lab {@link Amount} satisfies it as it stands, so an amount
 * out of the ledger passes straight to {@link Money.from}.
 */
export interface MoneyInit {
  /**
   * The currency tag. Defaults to `CREDIT`, the in-app currency.
   */
  currency?: Currency;
  /**
   * The amount in minor units: hundredths of a credit, cents of a dollar.
   *
   * A `bigint` at run time as well as at compile time. A number is refused rather than read,
   * because it gives up digits inside the range the ledger stores.
   */
  minor?: bigint;
  /**
   * The amount as an ungrouped two-place decimal string.
   *
   * For example, `600.00`, `-0.05`. Give this or {@link MoneyInit.minor}, never both. A string
   * at run time as well as at compile time: a number carries no second place.
   */
  decimal?: string;
}

/** Everything {@link Money.from} and the arithmetic methods accept in place of a {@link Money}. */
export type MoneyValue = Money | string | MoneyInit;

/**
 * A money value on the wire, such as `CREDIT:600.00`.
 *
 * The currency tag is the part before the colon and the amount is a two-place decimal string
 * after it. The value itself is exact: `minor` is a `bigint`, so the totals a platform account
 * reaches stay precise past the point where `number` gives up digits.
 *
 * An instance is immutable and serializes itself, so it can be dropped into a JSON body or an
 * event payload where the wire expects a string.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/money-model/ The money model}
 *   for the currency tag and minor-unit design this puts a typed face on.
 */
export class Money implements WireValue {
  #amount: Amount = Object.freeze(zero('CREDIT'));
  #wire: string = encodeAmount(this.#amount);

  constructor(init?: string | MoneyInit) {
    // Absent, not falsy: '' is what an absent wire field arrives as, and from() refuses it.
    if (init !== undefined) return Money.from(init);
  }

  /**
   * The currency tag: `CREDIT` for the in-app currency, `USD` for the real-world one.
   */
  get currency(): Currency {
    return this.#amount.currency;
  }

  /**
   * The amount in minor units, exact at any size.
   *
   * @example
   * Money.from('CREDIT:600.00').minor // 60000n
   */
  get minor(): bigint {
    return this.#amount.minor;
  }

  /**
   * The amount without its currency tag, always two decimal places.
   *
   * @example
   * Money.from('USD:100.00').decimal // '100.00'
   */
  get decimal(): string {
    return this.#wire.slice(this.#wire.indexOf(':') + 1);
  }

  /**
   * The branded ledger amount inside, for handing back to the lab: a leg, an operation, a
   * balance comparison. Frozen, because it is the instance's own value and not a copy.
   */
  get amount(): Amount {
    return this.#amount;
  }

  /**
   * Returns the canonical wire form of the value.
   *
   * @returns The amount as a `CURRENCY:decimal` string
   */
  toString(): string {
    return this.#wire;
  }

  /**
   * Serializes to the same wire string under `JSON.stringify`, which cannot carry the `bigint`
   * that holds the exact value.
   *
   * @returns The amount as a `CURRENCY:decimal` string
   */
  toJSON(): string {
    return this.#wire;
  }

  /**
   * Adds another amount of the same currency. Throws `LEDGER.CURRENCY_MISMATCH` across
   * currencies and `MONEY.OVERFLOW` when the sum leaves the 64-bit range the ledger stores.
   *
   * @example
   * Money.from(credits(20_000)).add('CREDIT:600.00') // Money CREDIT:20600.00
   */
  add(other: MoneyValue): Money {
    return Money.#wrap(addAmounts(this.#amount, Money.from(other).#amount));
  }

  /**
   * Subtracts another amount of the same currency, throwing on the same two faults as
   * {@link Money.add}.
   *
   * @example
   * Money.from(credits(20_000)).subtract('CREDIT:600.00') // Money CREDIT:19400.00
   */
  subtract(other: MoneyValue): Money {
    return Money.#wrap(
      addAmounts(this.#amount, negate(Money.from(other).#amount)),
    );
  }

  /** True at exactly zero minor units, in either currency. */
  isZero(): boolean {
    return isZeroAmount(this.#amount);
  }

  /**
   * True when both the currency and the minor units match. Two different currencies are simply
   * unequal here — comparing a price to a payout is a question, not a bug, so this one method
   * answers instead of throwing the way {@link Money.compare} does.
   */
  equals(other: MoneyValue): boolean {
    const that = Money.from(other);
    return (
      that.currency === this.currency &&
      compareAmounts(this.#amount, that.#amount) === 0
    );
  }

  /**
   * Orders two amounts of the same currency, so it drops straight into `Array.sort`. Throws
   * `LEDGER.CURRENCY_MISMATCH` across currencies.
   *
   * @example
   * Money.from(credits(100)).compare('CREDIT:600.00') // -1
   */
  compare(other: MoneyValue): -1 | 0 | 1 {
    return compareAmounts(this.#amount, Money.from(other).#amount);
  }

  /**
   * Parses a wire amount.
   *
   * A string takes the full wire parse. An init object builds from minor units or from a
   * decimal string. `null` — an absent wire field — gives zero credits, the same value
   * `new Money()` builds. Only an absent value reads as zero: `''` is malformed like any other
   * unparseable string. Unlike {@link Rate.from}, an absent amount has a safe reading.
   *
   * Anything malformed throws `MONEY.INVALID_AMOUNT`: a currency the ledger does not handle,
   * more than two decimal places, digit grouping, a value past the 64-bit range, or a value
   * that is neither a wire string nor an init object.
   *
   * @param value The wire string, an init object, or null
   * @returns A Money instance (zero credits if null)
   */
  static from(value: string | MoneyInit | null): Money {
    // An instance is immutable, so handing the same one back is safe and saves the copy.
    if (value instanceof Money) {
      return value;
    }
    if (value === null) {
      return new Money();
    }
    if (typeof value === 'string') {
      return Money.#wrap(decodeAmountWire(value));
    }
    return Money.#wrap(fromInit(value));
  }

  static #wrap(amount: Amount): Money {
    const money = new Money();
    // Frozen because from() hands the same instance back: a writable amount would let one
    // holder rewrite a value every other holder is reading.
    money.#amount = Object.freeze(amount);
    money.#wire = encodeAmount(amount);
    return money;
  }
}

/**
 * Builds a {@link Money}, the factory form of `Money.from`. Called with nothing it gives zero
 * credits.
 *
 * @example
 * createMoney('USD:100.00'); // what 20,000 credits cash out to
 * createMoney({ currency: 'USD', minor: 999n }); // $9.99
 */
export function createMoney(value?: string | MoneyInit | null): Money {
  return Money.from(value ?? null);
}

function fromInit(init: MoneyInit): Amount {
  // Reading a number or a bigint through the init path would find no fields and answer zero,
  // which is a legal-looking amount of no money in place of the fault.
  if (init === null || typeof init !== 'object' || Array.isArray(init)) {
    throw new EconomyError(
      ERROR_CODES.INVALID_AMOUNT,
      `Money takes a CURRENCY:decimal string or an init object, not ${typeof init}.`,
      { detail: { value: String(init) } },
    );
  }
  const currency = init.currency ?? 'CREDIT';
  if (init.minor !== undefined && init.decimal !== undefined) {
    throw new EconomyError(
      ERROR_CODES.INVALID_AMOUNT,
      'Money takes minor units or a decimal string, not both.',
      { detail: { currency, decimal: init.decimal } },
    );
  }
  if (init.decimal !== undefined) {
    // The wire decoder, not the bare decimal one: it is the single door that checks the tag
    // against the currencies the ledger handles.
    return decodeAmountWire(`${currency}:${readDecimal(init.decimal)}`);
  }
  return viaWire(toAmount(currency, readMinor(init.minor)));
}

// A decoded JSON body arrives untyped, so the two value fields are checked here and not left
// to the compiler that never ran over the request.
function readMinor(minor: unknown): bigint {
  if (minor === undefined || minor === null) {
    return 0n;
  }
  if (typeof minor !== 'bigint') {
    throw new EconomyError(
      ERROR_CODES.INVALID_AMOUNT,
      `Money minor units must be a bigint, not a ${typeof minor}. A number gives up digits inside the range the ledger stores.`,
      { detail: { minor: String(minor) } },
    );
  }
  return minor;
}

function readDecimal(decimal: unknown): string {
  if (typeof decimal !== 'string') {
    throw new EconomyError(
      ERROR_CODES.INVALID_AMOUNT,
      `Money decimal must be a two-place decimal string, not a ${typeof decimal}.`,
      { detail: { decimal: String(decimal) } },
    );
  }
  return decimal;
}

// The lab owns the currency table, so this asks it: encode the amount, then decode it back. A
// tag the ledger does not handle fails that decode. A second copy of the currency union kept
// here would drift away from the one the ledger enforces.
function viaWire(amount: Amount): Amount {
  return decodeAmountWire(encodeAmount(amount));
}
