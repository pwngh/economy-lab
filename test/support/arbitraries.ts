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
 * Economy-specific generators for the property-based suite. A program is an array of abstract steps;
 * `runProgram` concretizes each one against the economy's *live* balances at replay time, so a spend
 * is always affordable-by-construction — even after the shrinker drops the top-up that funded it.
 * That is the one subtle correctness point: affordability is never baked into the generated value,
 * so a shrunk counterexample can't fail for the wrong reason.
 *
 * The `actor` field is what the seeded programs in scripts never varied: a spend can be issued by the
 * platform (`system`), by the account's owner (`self`), or by a different user (`other`) — the last
 * of which the ownership check must reject.
 */

import { makeEconomy } from '#test/support/economy.ts';
import { toAmount } from '#src/money.ts';
import { spendable, promo } from '#src/accounts.ts';
import { array, choice, int, record } from '#test/support/propcheck.ts';

import type { Arbitrary } from '#test/support/propcheck.ts';
import type { Economy, Principal, ProveReport } from '#src/contract.ts';

// Three buyers and one seller; a small pool so ownership and authorization collisions are reachable.
const BUYERS = 3;
const SELLER = 'usr_pbs';
// The economy config is fixed; only the program varies, so a failing program reproduces on replay.
const ECONOMY_SEED = 0x9f11;
const SYSTEM: Principal = { kind: 'system', service: 'propcheck' };

/** A user's spend can come from the platform, the account owner, or someone else. */
export type ActorChoice = 'system' | 'self' | 'other';
export type StepKind = 'topUp' | 'promo' | 'spend';

/** One abstract operation: what kind, whose account, how large, and who is asking. */
export type Step = {
  who: number;
  kind: StepKind;
  mag: number;
  actor: ActorChoice;
};

export const arbStep: Arbitrary<Step> = record<Step>({
  who: int(0, BUYERS - 1),
  kind: choice<StepKind>('topUp', 'promo', 'spend'),
  mag: int(1, 40),
  actor: choice<ActorChoice>('system', 'self', 'other'),
});

/** A program is up to 32 steps; the shrinker drops and shrinks them to a minimal failing core. */
export const arbProgram: Arbitrary<Step[]> = array(arbStep, 32);

type StepStatus =
  | 'committed'
  | 'duplicate'
  | 'rejected'
  | 'unauthorized'
  | 'error';
type StepResult = {
  kind: StepKind;
  actor: ActorChoice;
  status: StepStatus;
  detail?: string;
};

/** Names the single ledger law a run broke, the step it broke on, and enough to reproduce it. */
export type Violation = {
  law: string;
  step: number;
  detail: Record<string, unknown>;
};

const buyerId = (who: number): string => `usr_pb${who}`;
const magnitude = (mag: number) => toAmount('CREDIT', BigInt(mag) * 100n);

// Submits one step, concretized against the economy's live balances, and reports how it resolved.
// topUp and grantPromo are privileged, so they always run as the platform; only a spend carries the
// step's actor. A user acting on an account it does not own throws AUTH.UNAUTHORIZED before any money
// moves, which is caught here as its own status rather than an error.
async function applyStep(
  economy: Economy,
  step: Step,
  index: number,
): Promise<StepResult> {
  const buyer = buyerId(step.who);
  const idempotencyKey = `idem_pb_${index}`;
  try {
    if (step.kind === 'topUp') {
      await economy.submit({
        kind: 'topUp',
        idempotencyKey,
        actor: SYSTEM,
        userId: buyer,
        amount: magnitude(step.mag),
        source: 'card',
      });
      return { kind: step.kind, actor: step.actor, status: 'committed' };
    }
    if (step.kind === 'promo') {
      await economy.submit({
        kind: 'grantPromo',
        idempotencyKey,
        actor: SYSTEM,
        userId: buyer,
        amount: magnitude(step.mag),
        expiresAt: 86_400_000,
      });
      return { kind: step.kind, actor: step.actor, status: 'committed' };
    }
    const [free, granted] = await Promise.all([
      economy.read.balance(spendable(buyer)),
      economy.read.balance(promo(buyer)),
    ]);
    const wholeAvailable =
      free.minor + granted.minor - ((free.minor + granted.minor) % 100n);
    let priceMinor = BigInt(step.mag) * 100n;
    if (priceMinor > wholeAvailable) priceMinor = wholeAvailable;
    if (priceMinor < 100n) priceMinor = 100n;
    const actor: Principal =
      step.actor === 'self'
        ? { kind: 'user', userId: buyer }
        : step.actor === 'other'
          ? { kind: 'user', userId: buyerId((step.who + 1) % BUYERS) }
          : SYSTEM;
    const outcome = await economy.submit({
      kind: 'spend',
      idempotencyKey,
      actor,
      orderId: `ord_pb_${index}`,
      buyerId: buyer,
      sku: 'wrld_pass',
      price: toAmount('CREDIT', priceMinor),
      recipients: [{ sellerId: SELLER, shareBps: 10_000 }],
    });
    return { kind: step.kind, actor: step.actor, status: outcome.status };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'AUTH.UNAUTHORIZED') {
      return { kind: step.kind, actor: step.actor, status: 'unauthorized' };
    }
    return {
      kind: step.kind,
      actor: step.actor,
      status: 'error',
      detail: code ?? String(error),
    };
  }
}

// A spend by a non-owner must be refused for ownership; a spend by the owner or the platform must
// never be refused for it. topUp and grantPromo run as the platform, so they never reach this check.
function checkAuthorization(
  result: StepResult,
  index: number,
): Violation | null {
  if (result.kind !== 'spend') return null;
  const byOther = result.actor === 'other';
  if (byOther && result.status !== 'unauthorized') {
    return {
      law: 'authorizationHonored',
      step: index,
      detail: { actor: 'other', expected: 'unauthorized', got: result.status },
    };
  }
  if (!byOther && result.status === 'unauthorized') {
    return {
      law: 'authorizationHonored',
      step: index,
      detail: { actor: result.actor, refusedForOwnership: true },
    };
  }
  return null;
}

// The five ProveReport flags, plus the two figures a regression could leave inconsistent with them.
function checkInvariants(report: ProveReport, index: number): Violation | null {
  const flags = [
    'conserved',
    'backed',
    'noOverdraft',
    'chainIntact',
    'consistent',
  ] as const;
  for (const flag of flags) {
    if (!report[flag]) return { law: flag, step: index, detail: {} };
  }
  if (report.drift.length > 0) {
    return {
      law: 'noDrift',
      step: index,
      detail: { rows: report.drift.length },
    };
  }
  if (report.shortfall.minor !== 0n) {
    return {
      law: 'noShortfall',
      step: index,
      detail: { shortfall: report.shortfall.minor.toString() },
    };
  }
  return null;
}

/**
 * Replays a program against a fresh economy, checking every law: no unexpected throw and
 * authorization honored after each step, the full ProveReport once at the end — proving per step
 * would make every run O(steps × postings). A failing end prove replays the program once more,
 * proving after every step, so the returned violation still names the first step that broke the
 * law. Returns the first violation, or null when every law held. A fresh economy per call keeps
 * runs and shrink candidates isolated.
 */
export async function runProgram(steps: Step[]): Promise<Violation | null> {
  return replay(steps, { proveEachStep: false });
}

async function replay(
  steps: Step[],
  mode: { proveEachStep: boolean },
): Promise<Violation | null> {
  const economy = makeEconomy(ECONOMY_SEED);
  try {
    for (let i = 0; i < steps.length; i += 1) {
      const result = await applyStep(economy, steps[i]!, i);
      if (result.status === 'error') {
        return {
          law: 'noUnexpectedThrow',
          step: i,
          detail: { code: result.detail },
        };
      }
      const authViolation = checkAuthorization(result, i);
      if (authViolation) return authViolation;
      if (mode.proveEachStep) {
        const violation = checkInvariants(await economy.read.health(), i);
        if (violation) return violation;
      }
    }
    if (!mode.proveEachStep) {
      const atEnd = checkInvariants(
        await economy.read.health(),
        steps.length - 1,
      );
      if (atEnd) {
        return (await replay(steps, { proveEachStep: true })) ?? atEnd;
      }
    }
    return null;
  } finally {
    await economy.close();
  }
}
