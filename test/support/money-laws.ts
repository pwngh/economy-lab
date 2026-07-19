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
 * Money-movement laws over generated inputs: a committed sale's value lands entirely on its
 * recipients and the platform (split conservation), a committed operation resubmitted under its
 * key replays as the same transaction and moves nothing (exactly-once), and the velocity gate's
 * observable outcomes match an external reconstruction of the window (ceiling law) — every
 * screened attempt that commits fit under the limit, every RISK_DENIED crossed it.
 */

import { SYSTEM, earned, promo, spendable } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { array, int, record } from '#test/support/propcheck.ts';

import type { Economy, Operation, Principal } from '#src/contract.ts';
import type { Arbitrary } from '#test/support/propcheck.ts';
import type { Step, Violation } from '#test/support/arbitraries.ts';

const PLATFORM: Principal = { kind: 'system', service: 'money-laws' };

// ---- split conservation -------------------------------------------------------------------

/** A sale: a whole-credit price and up to four positive weights that become the bps split. */
export type SplitCase = { priceMag: number; weights: number[] };

export const arbSplit: Arbitrary<SplitCase> = record<SplitCase>({
  priceMag: int(1, 300),
  weights: array(int(1, 9), 3),
});

// Weights → a shareBps composition summing exactly 10,000, every part ≥ 1.
function toShares(weights: number[]): number[] {
  const parts = [1, ...weights]; // at least one recipient
  const total = parts.reduce((a, b) => a + b, 0);
  const bps = parts.map((w) => Math.floor((10_000 * w) / total));
  bps[0]! += 10_000 - bps.reduce((a, b) => a + b, 0);
  return bps;
}

export async function runSplitLaw(c: SplitCase): Promise<Violation | null> {
  const economy = makeEconomy(0x5197);
  try {
    const buyer = 'usr_mb';
    const price = toAmount('CREDIT', BigInt(c.priceMag) * 100n);
    await economy.submit({
      kind: 'topUp',
      idempotencyKey: 'idem_ms_fund',
      actor: PLATFORM,
      userId: buyer,
      amount: price,
      source: 'card',
    });

    const shares = toShares(c.weights);
    const sellers = shares.map((_, i) => `usr_msell${i}`);
    const outcome = await economy.submit({
      kind: 'spend',
      idempotencyKey: 'idem_ms_sale',
      actor: { kind: 'user', userId: buyer },
      orderId: 'ord_ms',
      buyerId: buyer,
      sku: 'wrld_pass',
      price,
      recipients: sellers.map((sellerId, i) => ({
        sellerId,
        shareBps: shares[i]!,
      })),
    });
    if (outcome.status !== 'committed') {
      return {
        law: 'affordableSaleCommits',
        step: 0,
        detail: { status: outcome.status, shares },
      };
    }

    // The legs of the posting itself balance to zero.
    const legSum = outcome.transaction.legs.reduce(
      (sum, leg) => sum + leg.amount.minor,
      0n,
    );
    if (legSum !== 0n) {
      return {
        law: 'legsBalance',
        step: 0,
        detail: { legSum: legSum.toString() },
      };
    }

    // Every minor unit of the price lands on a seller or the platform; no seller loses money.
    let landed = (await economy.read.balance(SYSTEM.REVENUE)).minor;
    for (const sellerId of sellers) {
      const cut = (await economy.read.balance(earned(sellerId))).minor;
      if (cut < 0n) {
        return { law: 'noNegativeCut', step: 0, detail: { sellerId } };
      }
      landed += cut;
    }
    if (landed !== price.minor) {
      return {
        law: 'splitConserves',
        step: 0,
        detail: {
          price: price.minor.toString(),
          landed: landed.toString(),
          shares,
        },
      };
    }
    const wallet = (await economy.read.balance(spendable(buyer))).minor;
    if (wallet !== 0n) {
      return {
        law: 'buyerPaysExactly',
        step: 0,
        detail: { left: wallet.toString() },
      };
    }
    return null;
  } finally {
    await economy.close();
  }
}

// ---- exactly-once and the velocity ceiling -------------------------------------------------

// Tight limits so generated programs cross them often; the frozen test clock keeps every attempt
// inside one window, which is what makes the external reconstruction exact. The two ceilings
// differ so the law also proves the windows are independent: an inflow burst must trip only the
// inflow ceiling, and vice versa.
const OUTFLOW_LIMIT_MINOR = 5_000n;
const INFLOW_LIMIT_MINOR = 8_000n;

const buyerId = (who: number): string => `usr_vb${who}`;

type TaggedOp = {
  op: Operation;
  subject: string;
  amountMinor: bigint;
  outcome: string;
  txnId: string | null;
};

// Concretizes a step so funds can never be the refusal: a spend is clamped to the live balance,
// and an unaffordable one becomes a 1-credit topUp. The only possible outcomes are committed and
// RISK_DENIED, which is exactly what the ceiling oracle needs.
async function applyScreened(
  economy: Economy,
  step: Step,
  index: number,
): Promise<TaggedOp> {
  const user = buyerId(step.who);
  const idempotencyKey = `idem_vl_${index}`;
  let op: Operation;
  // The oracle restates the subject rule independently: a spend fills the user's outflow
  // window, a topUp or promo grant the inflow one.
  let amountMinor: bigint;

  if (step.kind === 'spend') {
    const [free, granted] = await Promise.all([
      economy.read.balance(spendable(user)),
      economy.read.balance(promo(user)),
    ]);
    const whole =
      free.minor + granted.minor - ((free.minor + granted.minor) % 100n);
    if (whole >= 100n) {
      const priceMinor =
        BigInt(step.mag) * 100n > whole ? whole : BigInt(step.mag) * 100n;
      op = {
        kind: 'spend',
        idempotencyKey,
        actor: PLATFORM,
        orderId: `ord_vl_${index}`,
        buyerId: user,
        sku: 'wrld_pass',
        price: toAmount('CREDIT', priceMinor),
        recipients: [{ sellerId: 'usr_vsell', shareBps: 10_000 }],
      };
      amountMinor = priceMinor;
      const outcome = await economy.submit(op);
      return {
        op,
        subject: `out:${user}`,
        amountMinor,
        outcome:
          outcome.status === 'rejected'
            ? `rejected:${outcome.detail.reason}`
            : outcome.status,
        txnId: outcome.status === 'rejected' ? null : outcome.transaction.id,
      };
    }
  }
  const mag = step.kind === 'spend' ? 1 : step.mag;
  amountMinor = BigInt(mag) * 100n;
  if (step.kind === 'promo') {
    op = {
      kind: 'grantPromo',
      idempotencyKey,
      actor: PLATFORM,
      userId: user,
      amount: toAmount('CREDIT', amountMinor),
      expiresAt: 86_400_000,
    };
  } else {
    op = {
      kind: 'topUp',
      idempotencyKey,
      actor: PLATFORM,
      userId: user,
      amount: toAmount('CREDIT', amountMinor),
      source: 'card',
    };
  }
  const outcome = await economy.submit(op);
  return {
    op,
    subject: `in:${user}`,
    amountMinor,
    outcome:
      outcome.status === 'rejected'
        ? `rejected:${outcome.detail.reason}`
        : outcome.status,
    txnId: outcome.status === 'rejected' ? null : outcome.transaction.id,
  };
}

async function onceSnapshot(economy: Economy): Promise<string> {
  const parts: string[] = [];
  for (let who = 0; who < 3; who += 1) {
    parts.push(
      String((await economy.read.balance(spendable(buyerId(who)))).minor),
    );
    parts.push(String((await economy.read.balance(promo(buyerId(who)))).minor));
  }
  parts.push(String((await economy.read.balance(earned('usr_vsell'))).minor));
  parts.push(String((await economy.read.balance(SYSTEM.REVENUE)).minor));
  parts.push(String((await economy.read.balance(SYSTEM.STORED_VALUE)).minor));
  parts.push(String((await economy.read.balance(SYSTEM.PROMO_FLOAT)).minor));
  return parts.join(' ');
}

/**
 * Two laws over one generated program against per-class windows (50-credit outflow, 80-credit
 * inflow): the ceiling oracle (an attempt commits iff its class's externally reconstructed
 * window total, including itself, fits under that class's limit — and a denied attempt still
 * counts toward it) and exactly-once (every committed operation, resubmitted verbatim, replays
 * as `duplicate` with the same transaction id and moves no balance).
 */
export async function runVelocityAndOnce(
  steps: Step[],
): Promise<Violation | null> {
  const economy = makeEconomy(0x51ce, undefined, {
    velocityInflowLimitMinor: INFLOW_LIMIT_MINOR,
    velocityOutflowLimitMinor: OUTFLOW_LIMIT_MINOR,
  });
  try {
    const window = new Map<string, bigint>(); // class-prefixed subject → recorded attempt total
    const limitOf = (subject: string): bigint =>
      subject.startsWith('in:') ? INFLOW_LIMIT_MINOR : OUTFLOW_LIMIT_MINOR;
    const committed: TaggedOp[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      const tagged = await applyScreened(economy, steps[i]!, i);
      const withOwn = (window.get(tagged.subject) ?? 0n) + tagged.amountMinor;
      if (tagged.outcome === 'committed') {
        if (withOwn > limitOf(tagged.subject)) {
          return {
            law: 'velocityCeiling',
            step: i,
            detail: { subject: tagged.subject, withOwn: withOwn.toString() },
          };
        }
        window.set(tagged.subject, withOwn);
        committed.push(tagged);
      } else if (tagged.outcome === 'rejected:RISK_DENIED') {
        if (withOwn <= limitOf(tagged.subject)) {
          return {
            law: 'velocityCeilingConverse',
            step: i,
            detail: { subject: tagged.subject, withOwn: withOwn.toString() },
          };
        }
        window.set(tagged.subject, withOwn); // a denied attempt still fills the window
      } else {
        // Affordability is by construction, so nothing but the risk gate may refuse here.
        return {
          law: 'onlyRiskRefuses',
          step: i,
          detail: { outcome: tagged.outcome },
        };
      }
    }

    const before = await onceSnapshot(economy);
    for (let i = committed.length - 1; i >= 0; i -= 1) {
      const again = await economy.submit(committed[i]!.op);
      if (
        again.status !== 'duplicate' ||
        again.transaction.id !== committed[i]!.txnId
      ) {
        return {
          law: 'exactlyOnce',
          step: i,
          detail: {
            status: again.status,
            txn: again.status === 'rejected' ? null : again.transaction.id,
            original: committed[i]!.txnId,
          },
        };
      }
    }
    if ((await onceSnapshot(economy)) !== before) {
      return {
        law: 'exactlyOnceMovesNothing',
        step: committed.length,
        detail: {},
      };
    }
    return null;
  } finally {
    await economy.close();
  }
}
