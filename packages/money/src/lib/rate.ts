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
 * The typed value face over a CREDIT-to-USD conversion rate.
 *
 * A rate is `rate / 10^scale` in exact integers, plus the `rateId` naming which rate priced a
 * transaction. The id is opaque here: it is minted by the ledger's rates port, recorded on
 * postings, and pinned by tests, so this module carries it through byte for byte and never
 * parses or rebuilds it.
 *
 * Malformed input throws `CONFIG.INVALID`, the same code the ledger raises for a misconfigured
 * rate. Unlike {@link Money}, an absent rate is not zero: there is no safe default rate, and
 * applying a missing one would silently price at one-for-one, so `Rate.from(null)` throws. No
 * field of one has a safe default either — an incomplete rate is refused field by field, because
 * a body that dropped its `scale` prices at the multiplier raw, 10^scale too high.
 *
 * The conversion itself belongs to `@pwngh/economy-lab`. This module rounds nothing.
 */

import {
  convertCeil as convertCeilAmount,
  convertFloor as convertFloorAmount,
  EconomyError,
  ERROR_CODES,
  rateGte,
} from '@pwngh/economy-lab';
import type { Currency } from '@pwngh/economy-lab';

import { Money } from './money.js';
import type { MoneyValue } from './money.js';
import type { WireValue } from './wire-value.js';

// Wider than any rate a deployment configures (real ones run at scale 3 to 6). The bound exists
// so a hostile wire value cannot ask the ledger for a million-digit power of ten.
const MAX_SCALE = 38;

/**
 * Initializer for a conversion rate, and the shape `GET /v1/rates` sends: the multiplier as a
 * decimal-integer string, the scale as a number, the id verbatim. A lab `Rate` satisfies it as
 * it stands, so a rate straight off the rates port passes to {@link Rate.from}.
 *
 * All three fields are required, matching that wire body, and each is refused when absent.
 */
export interface RateInit {
  /**
   * The multiplier, before the scale divides it. On the wire it is a string, because JSON
   * cannot carry the exact integer.
   */
  rate: bigint | string;
  /**
   * The power of ten the multiplier divides by: `rate / 10^scale`.
   *
   * Unset is refused rather than read as 0: at the payout rate's scale of 3, a dropped field
   * prices a credit at $5.00 instead of $0.005.
   */
  scale: number;
  /**
   * The ledger's name for this exact rate, such as `payout:CREDIT->USD:5/3`.
   *
   * Minted by the rates port and recorded on the transaction it priced. Pass it through
   * unchanged; never build one here.
   */
  rateId: string;
}

// What a decoded JSON body actually is. The readers below take this rather than a RateInit, so
// the compiler cannot vouch for a field that arrived off the wire with no types left on it.
type DecodedRate = { rate?: unknown; scale?: unknown; rateId?: unknown };

/** Everything {@link Rate.from} accepts in place of a {@link Rate}. */
export type RateValue = Rate | string | RateInit;

/**
 * A conversion rate as exact integers, such as `payout:CREDIT->USD:5/3` — $0.005 per credit, so
 * 20,000 credits cash out to $100.00.
 *
 * The multiplier is a `bigint` and the scale is a power of ten, so a conversion is one exact
 * multiply and one named rounding, never a float. Each conversion names its own direction: a
 * payout floors and a top-up ceils, which is why there is no single `apply`.
 *
 * The instance satisfies the lab's own `Rate` type, so it can be handed straight to any ledger
 * function that takes one.
 */
export class Rate implements WireValue {
  #rate: bigint;
  #scale: number;
  #rateId: string;

  /**
   * @param init The wire JSON or an init object. There is no blank rate to construct: an
   *   unnamed one would be 1/10^0, the silent one-for-one this class exists to refuse.
   */
  constructor(init: string | RateInit) {
    const parsed: unknown = typeof init === 'string' ? parseWire(init) : init;
    if (parsed === null || parsed === undefined) {
      throw invalidRate('A rate must be named; there is no default rate.', {});
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidRate('Not an encoded rate object.', { rate: String(init) });
    }
    const decoded = parsed as DecodedRate;
    this.#rate = readMultiplier(decoded);
    this.#scale = readScale(decoded);
    this.#rateId = readRateId(decoded);
  }

  get rate(): bigint {
    return this.#rate;
  }

  /** The power of ten the multiplier divides by. */
  get scale(): number {
    return this.#scale;
  }

  /**
   * The ledger's name for this exact rate, byte for byte as the rates port minted it.
   *
   * @example
   * Rate.from(body.payout).rateId // 'payout:CREDIT->USD:5/3'
   */
  get rateId(): string {
    return this.#rateId;
  }

  /**
   * Returns the canonical wire form: the JSON object `GET /v1/rates` sends.
   *
   * @returns The rate as JSON text
   */
  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  /**
   * Serializes to the wire object, with the multiplier as a string because JSON cannot carry
   * the exact integer.
   *
   * @returns The rate as a plain wire object
   */
  toJSON(): { rate: string; scale: number; rateId: string } {
    return {
      rate: this.#rate.toString(),
      scale: this.#scale,
      rateId: this.#rateId,
    };
  }

  /**
   * Converts an amount at this rate, rounding down. This is the payout direction: the sub-cent
   * remainder stays with the platform instead of being minted.
   *
   * @example
   * // 20,000 credits at $0.005 per credit
   * payoutRate.convertFloor('CREDIT:20000.00', 'USD') // Money USD:100.00
   */
  convertFloor(money: MoneyValue, to: Currency): Money {
    return Money.from(convertFloorAmount(Money.from(money).amount, this, to));
  }

  /**
   * Converts an amount at this rate, rounding up. This is the direction that must not
   * under-cover, such as the USD a top-up holds in trust.
   */
  convertCeil(money: MoneyValue, to: Currency): Money {
    return Money.from(convertCeilAmount(Money.from(money).amount, this, to));
  }

  /**
   * True when this rate is at least `other`. This is the ledger's own `rateGte`, which compares
   * across scales by cross-multiplying, so two spellings of one rate compare equal and no
   * division rounds the answer. The strict opposite is `!gte`.
   *
   * @example
   * // the ledger's own par check: a buy rate must not price a credit above a dollar
   * Rate.from({ rate: 1n, scale: 0, rateId: 'par' }).gte(buyRate) // true
   */
  gte(other: RateValue): boolean {
    return rateGte(this, Rate.from(other));
  }

  /**
   * Parses a rate.
   *
   * A string is the JSON wire form. An object is the decoded wire body or a lab `Rate`. `null`
   * throws: a missing rate has no safe reading, and treating it as one-for-one would price a
   * storefront at the wrong number in silence. {@link Money.from} answers zero for the same
   * `null` because an absent amount does have a safe reading.
   *
   * @param value The wire JSON, an init object, or null
   * @returns A Rate instance
   */
  static from(value: string | RateInit | null): Rate {
    // An instance is immutable, so handing the same one back is safe and saves the copy.
    if (value instanceof Rate) {
      return value;
    }
    if (value === null) {
      throw invalidRate('A rate must be named; there is no default rate.', {});
    }
    return new Rate(value);
  }
}

/**
 * Builds a {@link Rate}, the factory form of `Rate.from`.
 *
 * @example
 * createRate({ rate: '5', scale: 3, rateId: 'payout:CREDIT->USD:5/3' });
 */
export function createRate(value: string | RateInit): Rate {
  return Rate.from(value);
}

function parseWire(wire: string): DecodedRate {
  let decoded: unknown;
  try {
    decoded = JSON.parse(wire);
  } catch {
    decoded = null;
  }
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded)
  ) {
    throw invalidRate('Not an encoded rate object.', { wire });
  }
  return decoded as DecodedRate;
}

function readMultiplier(init: DecodedRate): bigint {
  const { rate } = init;
  if (typeof rate === 'bigint') {
    return nonNegative(rate);
  }
  if (typeof rate !== 'string' || !/^\d+$/.test(rate)) {
    throw invalidRate(
      'Rate multiplier must be a bigint or a string of digits; JSON cannot carry the exact integer.',
      { rate: String(rate) },
    );
  }
  return BigInt(rate);
}

function nonNegative(rate: bigint): bigint {
  if (rate < 0n) {
    throw invalidRate('Rate multiplier must not be negative.', {
      rate: rate.toString(),
    });
  }
  return rate;
}

function readScale(init: DecodedRate): number {
  const { scale } = init;
  if (scale === undefined || scale === null) {
    throw invalidRate(
      'A rate must carry the scale its multiplier divides by; there is no default scale.',
      {},
    );
  }
  if (
    typeof scale !== 'number' ||
    !Number.isSafeInteger(scale) ||
    scale < 0 ||
    scale > MAX_SCALE
  ) {
    throw invalidRate(
      `Rate scale must be a whole number from 0 to ${MAX_SCALE}.`,
      {
        scale: String(scale),
      },
    );
  }
  return scale;
}

function readRateId(init: DecodedRate): string {
  const { rateId } = init;
  if (typeof rateId !== 'string' || rateId.length === 0) {
    throw invalidRate(
      'A rate must carry the rateId the ledger minted for it.',
      {},
    );
  }
  return rateId;
}

function invalidRate(
  message: string,
  detail: Record<string, unknown>,
): EconomyError {
  return new EconomyError(ERROR_CODES.CONFIG_INVALID, message, { detail });
}
