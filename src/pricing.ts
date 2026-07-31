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
import { encodeAmount, mulDiv, toAmount, SCALE } from '#src/money.ts';
import { earned, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { FeePolicy, Recipient } from '#src/contract.ts';
import type { Leg } from '#src/ports.ts';

// Fees and shares are in basis points (10000 bps = 100%). The share math and the
// 100%-sum check share this constant in both number and bigint forms, so the two
// can never disagree.
const BPS_TOTAL = 10_000;
const BPS_TOTAL_BIG = 10_000n;

/**
 * The built-in {@link FeePolicy}: a fixed fee rate for every sale, taken from `input.feeBps`
 * (the spend handler passes `config.platformFeeBps`).
 *
 * The policy returns the credit side of the sale only; the spend handler adds the buyer's
 * matching debit, which zeroes the posting. The fee comes off the top, rounded up to a whole
 * credit and capped at the price. The net divides among `recipients` by `shareBps`, each share
 * rounded down, and the platform revenue credit takes the fee plus the rounding leftover, so
 * the legs always sum to the full price and no minor unit of the sale is lost. Recipient
 * shares must sum to 10000 basis points; any other total throws MALFORMED_OPERATION, and so
 * does a price that is not CREDIT. An empty recipient list is allowed and sends the whole net
 * to revenue.
 *
 * @example
 * const policy = flatFee();
 * const legs = policy({ price: toAmount('CREDIT', 1000n), feeBps: 3000,
 *   recipients: [{ sellerId: 'usr_seller', shareBps: 10000 }] });
 * // Price 1000 with a 30% fee credits the seller 700 and revenue 300. Both are
 * // credits, stored negative, so the lines sum to -1000, the full price.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/pricing/ Pricing} for how fee
 *   policies split a sale into ledger lines.
 */
export function flatFee(): FeePolicy {
  return (input) => splitLegs(input.price, input.recipients, input.feeBps);
}

// Credits are stored negative, so these lines sum to -price; the buyer's matching debit is the
// spend handler's, not this function's.
function splitLegs(
  price: Amount,
  recipients: ReadonlyArray<Recipient>,
  feeBps: number,
): Leg[] {
  assertShareSum(recipients);
  const net = price.minor - feeForPrice(price, feeBps);

  const legs: Leg[] = [];
  for (const recipient of recipients) {
    legs.push(
      credit(
        earned(recipient.sellerId),
        toAmount(price.currency, applyBps(net, recipient.shareBps)),
      ),
    );
  }

  legs.push(
    credit(
      SYSTEM.REVENUE,
      toAmount(price.currency, revenueForSplit(price, recipients, feeBps)),
    ),
  );
  return legs;
}

/**
 * Returns the platform's actual revenue from splitting `price` among `recipients` at `feeBps`.
 * That revenue is the fee plus the residual left by rounding each seller's share down, which is
 * exactly the amount splitLegs credits to REVENUE. spend.ts records this as `Sale.fee` rather
 * than the bare `feeForPrice`, so the recorded fee equals what REVENUE actually kept even on an
 * uneven split, where the residual is non-zero. On an even split the residual is zero, so the
 * result is just the fee.
 *
 * A price that is not CREDIT throws MALFORMED_OPERATION, the refusal feeForPrice makes.
 */
export function revenueForSplit(
  price: Amount,
  recipients: ReadonlyArray<Recipient>,
  feeBps: number,
): bigint {
  const fee = feeForPrice(price, feeBps);
  const net = price.minor - fee;
  let distributed = 0n;
  for (const recipient of recipients) {
    distributed += applyBps(net, recipient.shareBps);
  }
  return fee + (net - distributed);
}

// Returns the basis-point fraction of an amount, rounded down: amount * bps / 10000. The math
// stays all-bigint so large running totals remain exact, and the rounding mode is named at the
// division so no carrier of this split can disagree on direction.
function applyBps(minor: bigint, bps: number): bigint {
  return mulDiv(minor, BigInt(bps), BPS_TOTAL_BIG, 'floor');
}

/**
 * Returns the platform fee for a price, in minor units, rounded up to a whole credit, then capped at
 * the price so the fee never exceeds what was paid (the cap only matters below one whole credit). The
 * leftover line in splitLegs absorbs the difference between the exact and rounded fee.
 *
 * Rounding up to a whole credit is a rule about credits, so a price in any other currency throws
 * MALFORMED_OPERATION. Every currency here shares one 100-minor-unit scale, so the rounding cannot
 * read a different whole unit off a dollar: it would round a dollar fee up to a whole dollar, and
 * the price cap only fires above the price.
 *
 * This is the single source for the transaction fee, called by every charge that takes one (sale,
 * subscription first period, renewal), so no caller re-derives a floor that would disagree when the
 * raw fee is not a whole credit.
 */
export function feeForPrice(price: Amount, bps: number): bigint {
  if (price.currency !== 'CREDIT') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'feeForPrice.price must be CREDIT.',
      { detail: { amount: encodeAmount(price) } },
    );
  }
  const units = mulDiv(price.minor, BigInt(bps), BPS_TOTAL_BIG * SCALE, 'ceil');
  const fee = units * SCALE;
  return fee > price.minor ? price.minor : fee;
}

// Throws unless the recipient shares sum to 100% (10000 bps). The spend handler already checks
// this, so when the wiring is correct this never fires. It is a backstop: a wiring mistake fails
// loudly here rather than under-crediting recipients and silently dumping the difference into
// revenue. An empty recipient list is allowed. With nothing to pay out, the whole net becomes
// leftover and goes to revenue.
function assertShareSum(recipients: ReadonlyArray<Recipient>): void {
  if (recipients.length === 0) {
    return;
  }
  let total = 0;
  for (const recipient of recipients) {
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
