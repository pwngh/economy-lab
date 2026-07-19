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
 * Replay determinism as a law: the same operations over the same seeded capabilities mint the
 * same outcomes, the same transaction ids, and the same final balances — first for two
 * identical live runs (any divergence means a hidden wall clock or RNG on the submit path),
 * then for a data replay of the first run's recorded operations (the docs↔console journal
 * handoff rests on exactly this property; here it becomes a library invariant).
 */

import { earned, promo, spendable } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { makeEconomy } from '#test/support/economy.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Economy, Operation, Principal } from '#src/contract.ts';
import type { Step, Violation } from '#test/support/arbitraries.ts';

const ECONOMY_SEED = 0x2e91;
const PLATFORM: Principal = { kind: 'system', service: 'replay' };
const BUYERS = 3;
const SELLER = 'usr_rs';

const buyerId = (who: number): string => `usr_rb${who}`;

type Applied = {
  op: Operation;
  outcome: string; // "committed:txn_…", "duplicate:txn_…", "rejected:CODE", or "threw:CODE"
};

// Mirrors the arbitraries' concretization: a spend is clamped to the live balance so it is
// affordable by construction, and the step's actor decides who submits it.
async function concretize(
  economy: Economy,
  step: Step,
  index: number,
): Promise<Operation> {
  const buyer = buyerId(step.who);
  const idempotencyKey = `idem_rp_${index}`;
  if (step.kind === 'topUp') {
    return {
      kind: 'topUp',
      idempotencyKey,
      actor: PLATFORM,
      userId: buyer,
      amount: toAmount('CREDIT', BigInt(step.mag) * 100n),
      source: 'card',
    };
  }
  if (step.kind === 'promo') {
    return {
      kind: 'grantPromo',
      idempotencyKey,
      actor: PLATFORM,
      userId: buyer,
      amount: toAmount('CREDIT', BigInt(step.mag) * 100n),
      expiresAt: 86_400_000,
    };
  }
  const [free, granted] = await Promise.all([
    economy.read.balance(spendable(buyer)),
    economy.read.balance(promo(buyer)),
  ]);
  const whole =
    free.minor + granted.minor - ((free.minor + granted.minor) % 100n);
  let priceMinor = BigInt(step.mag) * 100n;
  if (priceMinor > whole) priceMinor = whole;
  if (priceMinor < 100n) priceMinor = 100n;
  const actor: Principal =
    step.actor === 'self'
      ? { kind: 'user', userId: buyer }
      : step.actor === 'other'
        ? { kind: 'user', userId: buyerId((step.who + 1) % BUYERS) }
        : PLATFORM;
  return {
    kind: 'spend',
    idempotencyKey,
    actor,
    orderId: `ord_rp_${index}`,
    buyerId: buyer,
    sku: 'wrld_pass',
    price: toAmount('CREDIT', priceMinor),
    recipients: [{ sellerId: SELLER, shareBps: 10_000 }],
  };
}

async function submitTagged(economy: Economy, op: Operation): Promise<string> {
  try {
    const outcome = await economy.submit(op);
    if (outcome.status === 'rejected')
      return `rejected:${outcome.detail.reason}`;
    return `${outcome.status}:${outcome.transaction.id}`;
  } catch (error) {
    return `threw:${(error as { code?: string }).code ?? String(error)}`;
  }
}

async function liveRun(
  steps: Step[],
): Promise<{ applied: Applied[]; balances: string }> {
  const economy = makeEconomy(ECONOMY_SEED);
  try {
    const applied: Applied[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      const op = await concretize(economy, steps[i]!, i);
      applied.push({ op, outcome: await submitTagged(economy, op) });
    }
    return { applied, balances: await snapshot(economy) };
  } finally {
    await economy.close();
  }
}

async function dataReplay(
  ops: Operation[],
): Promise<{ outcomes: string[]; balances: string }> {
  const economy = makeEconomy(ECONOMY_SEED);
  try {
    const outcomes: string[] = [];
    for (const op of ops) outcomes.push(await submitTagged(economy, op));
    return { outcomes, balances: await snapshot(economy) };
  } finally {
    await economy.close();
  }
}

async function snapshot(economy: Economy): Promise<string> {
  const refs: AccountRef[] = [];
  for (let who = 0; who < BUYERS; who += 1) {
    refs.push(spendable(buyerId(who)), promo(buyerId(who)));
  }
  refs.push(earned(SELLER));
  const parts: string[] = [];
  for (const ref of refs) {
    parts.push(`${ref}=${(await economy.read.balance(ref)).minor}`);
  }
  return parts.join(' ');
}

/** The three-way determinism law over one generated program. */
export async function runReplayLaws(steps: Step[]): Promise<Violation | null> {
  const first = await liveRun(steps);
  const second = await liveRun(steps);
  for (let i = 0; i < steps.length; i += 1) {
    if (first.applied[i]!.outcome !== second.applied[i]!.outcome) {
      return {
        law: 'liveRunsDeterministic',
        step: i,
        detail: {
          first: first.applied[i]!.outcome,
          second: second.applied[i]!.outcome,
        },
      };
    }
  }
  if (first.balances !== second.balances) {
    return {
      law: 'liveRunsDeterministic',
      step: steps.length - 1,
      detail: { axis: 'balances' },
    };
  }

  const replay = await dataReplay(first.applied.map((a) => a.op));
  for (let i = 0; i < steps.length; i += 1) {
    if (replay.outcomes[i] !== first.applied[i]!.outcome) {
      return {
        law: 'dataReplayConverges',
        step: i,
        detail: { live: first.applied[i]!.outcome, replay: replay.outcomes[i] },
      };
    }
  }
  if (replay.balances !== first.balances) {
    return {
      law: 'dataReplayConverges',
      step: steps.length - 1,
      detail: {
        axis: 'balances',
        live: first.balances,
        replay: replay.balances,
      },
    };
  }
  return null;
}
