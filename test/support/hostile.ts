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
 * Generators and laws for hostile input: operations a buggy or malicious caller could produce,
 * including amounts smuggled past `toAmount` with a brand cast. The laws are that no hostile
 * operation ever commits, every refusal carries a known typed code (never a leaked TypeError),
 * a refusal leaves no trace on any balance or invariant, and a refused idempotency key is left
 * usable.
 */

import { spendable, earned, promo, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { choice, int, record } from '#test/support/propcheck.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Economy, Operation, Principal } from '#src/contract.ts';
import type { Amount } from '#src/money.ts';
import type { Arbitrary } from '#test/support/propcheck.ts';
import type { Violation } from '#test/support/arbitraries.ts';

const ECONOMY_SEED = 0x6057;
const PLATFORM: Principal = { kind: 'system', service: 'hostile' };
const BUYERS = 3;
const SELLER = 'usr_hs';

// Every way this battery knows to malform an operation. `smuggled*` casts a raw object to
// Amount, bypassing toAmount's construction guard — the pipeline must re-validate.
export const HOSTILE_KINDS = [
  'negativeTopUp',
  'zeroTopUp',
  'smuggledOverflow',
  'smuggledNegative',
  'blankKey',
  'whitespaceKey',
  'emptyUserId',
  'emptyBuyerId',
  'negativePrice',
  'sharesUnder',
  'sharesOver',
  'sharesNegativePair',
  'sharesDuplicateSeller',
  'spendByNonOwner',
  'unknownKind',
  'noRecipients',
  'emptyRecipients',
] as const;
export type HostileKind = (typeof HOSTILE_KINDS)[number];

export type HostileCase = { kind: HostileKind; mag: number; who: number };

export const arbHostile: Arbitrary<HostileCase> = record<HostileCase>({
  kind: choice<HostileKind>(...HOSTILE_KINDS),
  mag: int(1, 40),
  who: int(0, BUYERS - 1),
});

// Every code a refusal may legitimately carry. Anything outside this set — above all a raw
// TypeError — is a validation gap, not a refusal.
const KNOWN_REFUSALS = new Set([
  'MONEY.INVALID_AMOUNT',
  'MONEY.OVERFLOW',
  'OP.MALFORMED',
  'AUTH.UNAUTHORIZED',
]);

const buyerId = (who: number): string => `usr_hb${who}`;

// Fires one operation and tags how it resolved. `typed` is false only for a throw outside the
// known refusal set — the leak the refusalTyped law exists to catch.
async function fire(
  economy: Economy,
  op: Operation,
): Promise<{ status: string; typed: boolean }> {
  try {
    const outcome = await economy.submit(op);
    return {
      status:
        outcome.status === 'rejected'
          ? `rejected:${outcome.detail.reason}`
          : outcome.status,
      typed: true,
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      status: `threw:${code ?? String(error)}`,
      typed: code !== undefined && KNOWN_REFUSALS.has(code),
    };
  }
}
const credit = (mag: number): Amount => toAmount('CREDIT', BigInt(mag) * 100n);
const smuggle = (minor: bigint): Amount =>
  ({ currency: 'CREDIT', minor, __brand: 'Amount' }) as Amount;

// The hostile operation itself, split by the base op it malforms so each switch stays readable.
// Built as data so a shrunk case prints as the exact payload.
function hostileOp(c: HostileCase, key: string): Operation {
  if (c.kind === 'unknownKind') {
    return {
      kind: `bogus_${c.mag}`,
      idempotencyKey: key,
      actor: PLATFORM,
    } as never;
  }
  return hostileTopUp(c, key) ?? hostileSpend(c, key);
}

function hostileTopUp(c: HostileCase, key: string): Operation | null {
  const topUp = (over: Partial<Record<string, unknown>>): Operation =>
    ({
      kind: 'topUp',
      idempotencyKey: key,
      actor: PLATFORM,
      userId: buyerId(c.who),
      amount: credit(c.mag),
      source: 'card',
      ...over,
    }) as Operation;

  switch (c.kind) {
    case 'negativeTopUp':
      return topUp({ amount: smuggle(BigInt(-c.mag) * 100n) });
    case 'zeroTopUp':
      return topUp({ amount: smuggle(0n) });
    case 'smuggledOverflow':
      return topUp({ amount: smuggle(2n ** 63n + BigInt(c.mag)) });
    case 'smuggledNegative':
      return topUp({ amount: smuggle(-1n - BigInt(c.mag)) });
    case 'blankKey':
      return topUp({ idempotencyKey: '' });
    case 'whitespaceKey':
      return topUp({ idempotencyKey: ' '.repeat(1 + (c.mag % 4)) });
    case 'emptyUserId':
      return topUp({ userId: '' });
    default:
      return null;
  }
}

function hostileSpend(c: HostileCase, key: string): Operation {
  const spend = (over: Partial<Record<string, unknown>>): Operation =>
    ({
      kind: 'spend',
      idempotencyKey: key,
      actor: PLATFORM,
      orderId: key,
      buyerId: buyerId(c.who),
      sku: 'hostile_sku',
      price: credit(c.mag),
      recipients: [{ sellerId: SELLER, shareBps: 10_000 }],
      ...over,
    }) as Operation;

  switch (c.kind) {
    case 'negativePrice':
      return spend({ price: smuggle(BigInt(-c.mag) * 100n) });
    case 'sharesUnder':
      return spend({
        recipients: [{ sellerId: SELLER, shareBps: 10_000 - c.mag }],
      });
    case 'sharesOver':
      return spend({
        recipients: [{ sellerId: SELLER, shareBps: 10_000 + c.mag }],
      });
    case 'sharesNegativePair':
      return spend({
        recipients: [
          { sellerId: SELLER, shareBps: 10_000 + c.mag },
          { sellerId: 'usr_hs2', shareBps: -c.mag },
        ],
      });
    case 'sharesDuplicateSeller':
      return spend({
        recipients: [
          { sellerId: SELLER, shareBps: 5_000 },
          { sellerId: SELLER, shareBps: 5_000 },
        ],
      });
    case 'spendByNonOwner':
      return spend({
        actor: { kind: 'user', userId: buyerId((c.who + 1) % BUYERS) },
      });
    case 'noRecipients':
      return spend({ recipients: undefined as never });
    case 'emptyRecipients':
      return spend({ recipients: [] });
    default:
      return spend({ buyerId: '' }); // emptyBuyerId, the remaining spend case
  }
}

// Every balance a hostile operation could plausibly disturb.
function trackedAccounts(): AccountRef[] {
  const refs: AccountRef[] = [];
  for (let who = 0; who < BUYERS; who += 1) {
    refs.push(
      spendable(buyerId(who)),
      promo(buyerId(who)),
      earned(buyerId(who)),
    );
  }
  refs.push(earned(SELLER));
  refs.push(
    SYSTEM.REVENUE,
    SYSTEM.STORED_VALUE,
    SYSTEM.PROMO_FLOAT,
    SYSTEM.TRUST_CASH,
    SYSTEM.USD_CLEARING,
    SYSTEM.REVENUE_USD,
  );
  return refs;
}

async function snapshot(economy: Economy, refs: AccountRef[]): Promise<string> {
  const parts: string[] = [];
  for (const ref of refs) {
    const amount = await economy.read.balance(ref);
    parts.push(`${ref}=${amount.minor}`);
  }
  return parts.join(' ');
}

/**
 * The battery for one hostile case: fund a small world, snapshot it, fire the hostile
 * operation, and hold four laws — never committed, refusal typed, no trace on any balance or
 * invariant, and the key still usable by a valid operation afterward.
 */
export async function refusedCleanly(
  c: HostileCase,
): Promise<Violation | null> {
  const economy = makeEconomy(ECONOMY_SEED);
  try {
    for (let who = 0; who < BUYERS; who += 1) {
      await economy.submit({
        kind: 'topUp',
        idempotencyKey: `idem_hp_${who}`,
        actor: PLATFORM,
        userId: buyerId(who),
        amount: credit(50),
        source: 'card',
      });
    }
    const refs = trackedAccounts();
    const before = await snapshot(economy, refs);
    const key = 'idem_hostile';

    const fired = await fire(economy, hostileOp(c, key));
    if (!fired.typed) {
      return { law: 'refusalTyped', step: 0, detail: { got: fired.status } };
    }
    const status = fired.status;
    if (status === 'committed' || status === 'duplicate') {
      return { law: 'hostileNeverCommits', step: 0, detail: { status } };
    }

    const after = await snapshot(economy, refs);
    if (after !== before) {
      return { law: 'noTrace', step: 0, detail: { before, after } };
    }
    const report = await economy.read.health();
    if (
      !(
        report.conserved &&
        report.backed &&
        report.noOverdraft &&
        report.consistent
      )
    ) {
      return { law: 'proveGreenAfterRefusal', step: 0, detail: { status } };
    }

    // The refused key must still be claimable by a valid operation — a refusal that consumes
    // the key would strand the caller's retry.
    if (
      status.startsWith('threw:OP.MALFORMED') &&
      hostileOp(c, key).idempotencyKey !== key
    ) {
      return null; // blank/whitespace keys aren't reusable by construction; nothing to check
    }
    const retry = await economy.submit({
      kind: 'topUp',
      idempotencyKey: key,
      actor: PLATFORM,
      userId: buyerId(c.who),
      amount: credit(1),
      source: 'card',
    });
    if (retry.status !== 'committed') {
      return {
        law: 'keyReleasedOnRefusal',
        step: 0,
        detail: { retry: retry.status },
      };
    }
    return null;
  } finally {
    await economy.close();
  }
}
