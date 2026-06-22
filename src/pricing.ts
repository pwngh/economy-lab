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

// Fees and shares are measured in basis points, where 10000 bps means 100%. Both the
// share-percentage math and the "do the shares add up to a full 100%?" check read this
// same constant (one in plain number form, one as a bigint) so they can never disagree.
let BPS_TOTAL = 10_000;
let BPS_TOTAL_BIG = 10_000n;

/**
 * Fee policy that charges one fixed fee rate for every sale. It uses whatever fee rate the
 * caller passes in as `input.feeBps` (the spend handler passes the platform's configured
 * default, `config.platformFeeBps`).
 *
 * @example
 *   let policy = flatFee();
 *   let legs = policy({ price: toAmount('CREDIT', 1000n), feeBps: 3000,
 *     recipients: [{ sellerId: 'usr_seller', shareBps: 10000 }] });
 *   // On a price of 1000 with a 30% fee: the seller is credited 700 and the
 *   // platform's revenue is credited 300. Both lines are credits, which are stored
 *   // negative, so the line amounts add up to -1000 (the full price).
 */
export function flatFee(): FeePolicy {
  return (input) => splitLegs(input.price, input.recipients, input.feeBps);
}

// Splits a sale's price into ledger lines, used by the fee policy above. It takes the
// platform fee off the top, divides what is left among the recipients by their shares, and
// gives the platform's revenue both the fee and any rounding leftover so no unit of the price
// goes missing. Each recipient gets a credit to their earned account (money the platform owes
// them as a seller); the platform's revenue gets one credit for fee plus leftover.
//
// These are only the credit side. Credits are stored as negative amounts, so all the line
// amounts here add up to the negative of the price. The spend handler adds the matching debit
// that takes the price out of the buyer's balance, and that brings the posting to zero.
function splitLegs(
  price: Amount,
  recipients: ReadonlyArray<Recipient>,
  feeBps: number,
): Leg[] {
  assertShareSum(recipients);
  let fee = feeForPrice(price.minor, feeBps);
  let net = price.minor - fee;

  let legs: Leg[] = [];
  let distributed = 0n;
  for (let recipient of recipients) {
    let share = applyBps(net, recipient.shareBps);
    distributed += share;
    legs.push(
      credit(earned(recipient.sellerId), toAmount(price.currency, share)),
    );
  }

  // The platform's revenue gets the fee plus the leftover that rounding each recipient's share
  // down left behind. With this, the recipients' shares + fee + leftover always equal the full
  // price, so nothing is lost or invented.
  let residual = net - distributed;
  legs.push(credit(SYSTEM.REVENUE, toAmount(price.currency, fee + residual)));
  return legs;
}

// Takes a basis-point fraction of an amount and rounds down: amount * bps / 10000. The math
// is done in bigint the whole way through, so even the platform's huge running totals stay
// exact instead of losing precision the way a regular JavaScript number would past about 2^53.
function applyBps(minor: bigint, bps: number): bigint {
  return (minor * BigInt(bps)) / BPS_TOTAL_BIG;
}

/**
 * The platform fee for a price, in minor units — rounded UP to a whole credit (VRChat's
 * documented rule). It takes the exact basis-point fee, rounds it up to the next whole credit,
 * then caps it at the price so the fee can never exceed what was paid. (That cap only matters for
 * a price below one whole credit; real listings are 100 or more whole credits.) Either way
 * nothing is lost: the leftover line in splitLegs absorbs the difference.
 *
 * This is the ONE place the transaction fee is computed. Every charge that takes the fee calls
 * it: a sale (`splitLegs` here, and `spend.saleOf` recording the SAME `Sale.fee`), the first
 * month of a subscription (`operations/subscribe.ts`), and each renewal
 * (`worker/subscriptions.ts`). Because they share this function they round identically — no
 * caller re-derives a floor that would disagree whenever the raw fee is not a whole credit.
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

// Checks that the recipients' shares add up to a full 100% (10000 bps), and throws if not. The
// spend handler already checks this before calling, so with everything wired correctly this
// never fires; it is a backstop so a wiring mistake fails loudly here rather than quietly
// crediting recipients too little and dumping the difference into platform revenue. A recipient
// list that is empty is allowed: with no shares to pay out, the whole net amount becomes the
// leftover and goes to revenue.
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
