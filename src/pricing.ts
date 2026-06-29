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
import { credit } from '#src/ledger.ts';
import { toAmount, SCALE } from '#src/money.ts';
import { earned, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { FeePolicy, Recipient } from '#src/contract.ts';
import type { Leg } from '#src/ports.ts';

// Fees and shares are in basis points (10000 bps = 100%). The share math and the
// 100%-sum check share this constant (number and bigint forms) so they can't disagree.
let BPS_TOTAL = 10_000;
let BPS_TOTAL_BIG = 10_000n;

/**
 * Fixed fee rate for every sale, taken from `input.feeBps` (the spend handler passes
 * `config.platformFeeBps`).
 *
 * @example
 *   let policy = flatFee();
 *   let legs = policy({ price: toAmount('CREDIT', 1000n), feeBps: 3000,
 *     recipients: [{ sellerId: 'usr_seller', shareBps: 10000 }] });
 *   // Price 1000, 30% fee: seller credited 700, revenue credited 300. Both are credits
 *   // (stored negative), so the lines sum to -1000 (the full price).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/pricing/ Pricing} for how fee policies split a sale into ledger lines.
 */
export function flatFee(): FeePolicy {
  return (input) => splitLegs(input.price, input.recipients, input.feeBps);
}

// Splits a sale's price into ledger lines for the fee policy above. Fee comes off the top,
// the rest is divided among recipients by share, and revenue gets fee plus any rounding
// leftover so no unit of price is lost. Each recipient gets a credit to their earned account
// (money owed to them as a seller); revenue gets one credit for fee + leftover.
//
// Credit side only. Credits are stored negative, so these lines sum to -price. The spend
// handler adds the matching debit against the buyer's balance, zeroing the posting.
function splitLegs(
  price: Amount,
  recipients: ReadonlyArray<Recipient>,
  feeBps: number,
): Leg[] {
  assertShareSum(recipients);
  let net = price.minor - feeForPrice(price.minor, feeBps);

  let legs: Leg[] = [];
  for (let recipient of recipients) {
    legs.push(
      credit(
        earned(recipient.sellerId),
        toAmount(price.currency, applyBps(net, recipient.shareBps)),
      ),
    );
  }

  // Revenue gets the fee plus the leftover from rounding each share down, so shares + revenue always
  // equal the full price. `revenueForSplit` computes exactly that amount — and Sale.fee records the
  // same call — so the posted REVENUE credit and the recorded fee can never disagree.
  legs.push(
    credit(
      SYSTEM.REVENUE,
      toAmount(price.currency, revenueForSplit(price, recipients, feeBps)),
    ),
  );
  return legs;
}

/**
 * The platform's actual revenue from splitting `price` among `recipients` at `feeBps`: the fee PLUS
 * the residual left by rounding each seller's share down — exactly the amount splitLegs credits to
 * REVENUE. spend.ts records this as `Sale.fee` (not the bare `feeForPrice`), so the recorded fee
 * equals what REVENUE actually kept even on an uneven split, where the residual is non-zero. On an
 * even split the residual is zero, so this is just the fee and the simple case is unchanged.
 */
export function revenueForSplit(
  price: Amount,
  recipients: ReadonlyArray<Recipient>,
  feeBps: number,
): bigint {
  let fee = feeForPrice(price.minor, feeBps);
  let net = price.minor - fee;
  let distributed = 0n;
  for (let recipient of recipients) {
    distributed += applyBps(net, recipient.shareBps);
  }
  return fee + (net - distributed);
}

// Basis-point fraction of an amount, rounded down: amount * bps / 10000. All-bigint math so
// large running totals stay exact rather than losing precision past 2^53 like a JS number.
function applyBps(minor: bigint, bps: number): bigint {
  return (minor * BigInt(bps)) / BPS_TOTAL_BIG;
}

/**
 * Platform fee for a price, in minor units, rounded up to a whole credit so the fee is always a
 * whole spendable unit. Takes the exact basis-point fee, rounds up to the next whole credit, then
 * caps at the price so the fee can't exceed what was paid. (The cap only matters below one whole
 * credit; real listings are 100+ credits.) The leftover line in splitLegs absorbs the difference.
 *
 * Single source for the transaction fee. Every charge that takes the fee calls it: a sale
 * (`splitLegs` here, plus `spend.saleOf` recording the same `Sale.fee`), the first month of a
 * subscription (`operations/subscribe.ts`), and each renewal (`worker/subscriptions.ts`).
 * Sharing this function makes them round identically, so no caller re-derives a floor that
 * would disagree when the raw fee isn't a whole credit.
 */
export function feeForPrice(minor: bigint, bps: number): bigint {
  let units = ceilDiv(minor * BigInt(bps), BPS_TOTAL_BIG * SCALE);
  let fee = units * SCALE;
  return fee > minor ? minor : fee;
}

// Divides two non-negative bigints and rounds the result up to the next whole number.
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

// Throws unless recipient shares sum to 100% (10000 bps). The spend handler already checks this,
// so when wired correctly it never fires; it's a backstop so a wiring mistake fails loudly here
// rather than under-crediting recipients and dumping the difference into revenue. Empty recipient
// list is allowed: with nothing to pay out, the whole net becomes leftover and goes to revenue.
function assertShareSum(recipients: ReadonlyArray<Recipient>): void {
  if (recipients.length === 0) {
    return;
  }
  let total = 0;
  for (let recipient of recipients) {
    total += recipient.shareBps;
  }
  if (total !== BPS_TOTAL) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'Recipient shareBps must sum to 10000.',
      { detail: { total, recipientCount: recipients.length } },
    );
  }
}
