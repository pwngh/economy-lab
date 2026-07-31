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
 * The typed value face over a basis-point share: 100 bps is one percent, 10,000 bps is the
 * whole. Recipient shares and the platform fee rate are both spelled in these units.
 *
 * Malformed input throws `OP.MALFORMED`, the same code the ledger raises when a sale's shares
 * do not add up. A share is a field on an operation, so a bad one is a malformed request.
 *
 * The fraction itself is the ledger's `convertFloor` at scale 4, which is the same exact
 * multiply and the same floor the ledger applies when it divides a sale among sellers. The
 * platform fee is the ledger's `feeForPrice` and `revenueForSplit`, whole-credit rounding, price
 * cap, and residual included. This module chooses no rounding of its own.
 */

import {
  convertFloor as convertFloorAmount,
  EconomyError,
  ERROR_CODES,
  feeForPrice,
  revenueForSplit,
} from '@pwngh/economy-lab';

import { Money } from './money.js';
import type { MoneyValue } from './money.js';
import type { WireValue } from './wire-value.js';

// A basis point is a ten-thousandth, so the fraction is `bps / 10^4`. Handing that scale to the
// ledger's own converter is what makes this a delegation instead of a second implementation.
const BPS_SCALE = 4;

/** Initializer for a basis-point share. */
export interface BpsInit {
  /** The share in basis points: a whole number from 0 to 10,000. */
  bps: number;
}

/** Everything {@link Bps.from} accepts in place of a {@link Bps}. */
export type BpsValue = Bps | string | number | BpsInit;

/**
 * A share in basis points, such as the 1,530 bps (15.3%) a platform takes or the 10,000 bps a
 * lone seller holds.
 *
 * The value is a whole number, never a fraction of a percent expressed as a float, and applying
 * it rounds down — the direction the ledger uses so a split can never hand out more than it
 * divided.
 */
export class Bps implements WireValue {
  /**
   * The whole: 10,000 basis points is 100%. Recipient shares on a sale must sum to exactly
   * this.
   */
  static readonly WHOLE = 10_000;

  #bps: number = 0;

  constructor(init?: string | number | BpsInit) {
    // Absent, not falsy: `new Bps('')` would otherwise be zero where `Bps.from('')` throws.
    if (init !== undefined) return Bps.from(init);
  }

  get bps(): number {
    return this.#bps;
  }

  /**
   * Returns the canonical wire form: the whole number as text.
   *
   * @returns The share in basis points as a string
   */
  toString(): string {
    return String(this.#bps);
  }

  /**
   * Serializes to the plain integer, which is how `shareBps` and `platformFeeBps` ride on the
   * wire.
   *
   * @returns The share in basis points as a number
   */
  toJSON(): number {
    return this.#bps;
  }

  /** True at exactly zero basis points. */
  isZero(): boolean {
    return this.#bps === 0;
  }

  /** True at exactly 10,000 basis points, the whole. */
  isWhole(): boolean {
    return this.#bps === Bps.WHOLE;
  }

  /**
   * Takes this share of an amount, rounded down — the same exact multiply and the same floor
   * the ledger applies when it divides a sale's net among its sellers.
   *
   * @example
   * bps(3_000).share('CREDIT:1000.00') // Money CREDIT:300.00
   * bps(3_333).share('CREDIT:1000.00') // Money CREDIT:333.30, the remainder left behind
   */
  share(money: MoneyValue): Money {
    const amount = Money.from(money).amount;
    return Money.from(
      // The rate the ledger's own converter takes. `rateId` only ever reaches the detail of an
      // overflow fault; it is a local marker, never a rates-port id, and nothing records it.
      convertFloorAmount(
        amount,
        {
          rate: BigInt(this.#bps),
          scale: BPS_SCALE,
          rateId: `bps:${this.#bps}`,
        },
        amount.currency,
      ),
    );
  }

  /**
   * The platform fee on a price at this rate, exactly as the ledger charges it: rounded up to a
   * whole credit, then capped at the price. This is the ledger's own `feeForPrice`, so a fee
   * quoted before a sale is the fee the posting takes.
   *
   * Whole-credit rounding is a rule about credits, so the ledger refuses any other currency with
   * `OP.MALFORMED` and this door passes that refusal on. {@link Bps.share} takes any currency: a
   * fraction rounded down needs no whole unit.
   *
   * @example
   * bps(1_530).fee('CREDIT:1000.00') // Money CREDIT:153.00
   * bps(1_530).fee('CREDIT:1000.50') // Money CREDIT:154.00, rounded up to the whole credit
   * bps(1_530).fee('CREDIT:0.50') // Money CREDIT:0.50, capped: a fee never exceeds the price
   * bps(1_530).fee('USD:1.07') // throws OP.MALFORMED
   */
  fee(price: MoneyValue): Money {
    const amount = Money.from(price).amount;
    return Money.from({
      currency: amount.currency,
      minor: feeForPrice(amount, this.#bps),
    });
  }

  /**
   * What platform revenue keeps when a price is split among `shares` at this fee rate: the fee
   * plus the residual that rounding each share down leaves behind. This is the ledger's own
   * `revenueForSplit`, the figure it records as the sale's fee.
   *
   * On an even split the residual is zero and the answer is just {@link Bps.fee}, and the same
   * CREDIT-only refusal applies.
   *
   * @example
   * // 999.99 divided three uneven ways leaves one minor unit over
   * bps(1_530).revenue('CREDIT:999.99', [bps(3_333), bps(3_333), bps(3_334)])
   * // Money CREDIT:153.01
   */
  revenue(price: MoneyValue, shares: ReadonlyArray<BpsValue>): Money {
    const amount = Money.from(price).amount;
    // The split arithmetic reads only the share. Seller ids name the accounts the ledger
    // credits, and this computes a figure rather than crediting anyone.
    const recipients = shares.map((share) => ({
      sellerId: '',
      shareBps: Bps.from(share).bps,
    }));
    return Money.from({
      currency: amount.currency,
      minor: revenueForSplit(amount, recipients, this.#bps),
    });
  }

  /**
   * Parses a share.
   *
   * A string or number is the bare basis-point count. An object carries it under `bps`. `null`
   * is zero — a share of nothing, the same value `new Bps()` builds. Only an absent value reads
   * as zero.
   *
   * Anything that is not a whole number from 0 to 10,000 throws `OP.MALFORMED`, including a
   * value of the wrong type and an object carrying no readable `bps`: a share that read as
   * zero would pay a seller nothing in silence.
   *
   * @param value The basis-point count, an init object, or null
   * @returns A Bps instance (zero if null)
   */
  static from(value: string | number | BpsInit | null): Bps {
    // An instance is immutable, so handing the same one back is safe and saves the copy.
    if (value instanceof Bps) {
      return value;
    }
    const share = new Bps();
    if (value !== null) {
      share.#bps = readBps(value);
    }
    return share;
  }

  /**
   * Requires that recipient shares add up to the whole, and says so in the ledger's own words
   * when they do not. An empty list is allowed: with no one to pay, the whole net goes to
   * platform revenue.
   *
   * The ledger checks this too, at the posting. Checking here lets a request fail where it was
   * built rather than after it crossed the wire.
   */
  static assertShareSum(shares: ReadonlyArray<BpsValue>): void {
    if (!Array.isArray(shares)) {
      throw malformedBps('Recipient shareBps must be given as a list.', {
        shares: String(shares),
      });
    }
    if (shares.length === 0) {
      return;
    }
    let total = 0;
    for (const share of shares) {
      const one = Bps.from(share).bps;
      // A rate of zero is legitimate — a zero fee. A recipient *share* of zero is not: the
      // ledger refuses it at the posting, so accepting it here would let a split pass the check
      // whose whole purpose is to fail before the wire.
      if (one === 0) {
        throw malformedBps('Each recipient share must be more than 0.', {
          recipientCount: shares.length,
        });
      }
      total += one;
    }
    if (total !== Bps.WHOLE) {
      throw malformedBps(`Recipient shareBps must sum to ${Bps.WHOLE}.`, {
        total,
        recipientCount: shares.length,
      });
    }
  }
}

/**
 * Builds a {@link Bps}, the factory form of `Bps.from`.
 *
 * @example
 * createBps(1_530); // the default platform fee rate
 */
export function createBps(value?: string | number | BpsInit | null): Bps {
  return Bps.from(value ?? null);
}

/**
 * Builds a {@link Bps} from a bare basis-point count, the terse form for a share literal.
 *
 * @example
 * bps(10_000); // a lone seller's whole share
 * bps(2_500); // a quarter of the net
 */
export function bps(count: number): Bps {
  return Bps.from(count);
}

function readBps(value: string | number | BpsInit): number {
  const count = countOf(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > Bps.WHOLE) {
    throw malformedBps(
      `Basis points must be a whole number from 0 to ${Bps.WHOLE}.`,
      { bps: spell(value) },
    );
  }
  return count;
}

// `String({ sellerId, shareBps })` is `[object Object]`, and the message asks for a whole
// number, so a caller who spelled the key wrong is told their 5,000 is not a whole number.
// Naming the keys they did carry is what points at the object instead.
function spell(value: unknown): string {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? `{${Object.keys(value).join(', ')}}`
    : String(value);
}

// Zero is the one value that pays a seller nothing and still lets a split sum to the whole, so
// nothing reads as zero by default. An object spelled `shareBps` — the spelling an operation
// carries — finds no `bps` field, and that is a malformed share rather than a share of nothing.
function countOf(value: string | number | BpsInit): number {
  if (typeof value === 'string') return wholeNumber(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value.bps ?? Number.NaN;
  }
  return Number.NaN;
}

function wholeNumber(text: string): number {
  // Parsed, not coerced: `Number(' ')` is 0 and `Number('1e3')` is 1000, and neither is a
  // basis-point count anyone wrote.
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

function malformedBps(
  message: string,
  detail: Record<string, unknown>,
): EconomyError {
  return new EconomyError(ERROR_CODES.MALFORMED_OPERATION, message, { detail });
}
