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

// The seeded operation generator scripts/prove.ts and scripts/fuzz.ts share. A seed builds one
// fixed sequence of valid operations, and every id derives only from the step number and the
// caller's identity — so a replay produces byte-identical operations on every adapter and every
// JS runtime.

import { decodeAmount } from '#src/money.ts';

import type { Amount } from '#src/money.ts';
import type { Operation } from '#src/contract.ts';

/**
 * `prefix` marks every generated id so two scripts' rows can never collide; `service` names the
 * fixed system actor. `promo` (default on) keeps grantPromo in the mix — a promo-draw spend
 * posts two lines to one account, the hardest shape for an adapter to store.
 */
export type ProgramIdentity = {
  prefix: string;
  service: string;
  promo?: boolean;
};

type Identity = Required<ProgramIdentity>;

type Gen = { next: () => number; id: Identity };

// mulberry32: a seed yields the same [0, 1) sequence on every JS runtime.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Local tally of each user's balances, so the generator only produces affordable spends.
type Wallet = { spendable: bigint; promo: bigint };

// Formats minor units (cents) as the two-decimal string decodeAmount expects, like "12.34".
function dollars(minor: bigint): string {
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

function creditMinor(minor: bigint): Amount {
  return decodeAmount(dollars(minor), 'CREDIT');
}

function walletOf(wallets: Map<string, Wallet>, userId: string): Wallet {
  let wallet = wallets.get(userId);
  if (!wallet) {
    wallet = { spendable: 0n, promo: 0n };
    wallets.set(userId, wallet);
  }
  return wallet;
}

// Builds an affordable spend and drains the local tally promo-first, matching the real spend
// handler. Draining in any other order would let the tally drift from the economy's and start
// generating spends the user cannot afford.
function spendOperation(
  gen: Gen,
  step: number,
  userId: string,
  wallet: Wallet,
): Operation {
  const available = wallet.spendable + wallet.promo;
  let priceMinor =
    BigInt(1 + Math.floor(gen.next() * Number(available / 100n))) * 100n;
  if (priceMinor > available) {
    priceMinor = available;
  }
  const fromPromo = wallet.promo < priceMinor ? wallet.promo : priceMinor;
  wallet.promo -= fromPromo;
  wallet.spendable -= priceMinor - fromPromo;
  // The SQL adapters record every sale under a non-null, unique order key, so a generated spend
  // must carry one — memory has no such table and would mask the omission. Step-derived, like
  // every other id.
  return op('spend', step, gen.id, {
    orderId: `ord_${gen.id.prefix}_${step}`,
    buyerId: userId,
    sku: 'wrld_pass',
    price: creditMinor(priceMinor),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
}

// Ids come only from the step, so a re-run resubmits the exact request — what lets prove's
// replay check expect `duplicate`.
function nextOperation(
  gen: Gen,
  step: number,
  wallets: Map<string, Wallet>,
): Operation {
  const userId = `usr_${gen.id.prefix}${1 + Math.floor(gen.next() * 3)}`;
  const wallet = walletOf(wallets, userId);
  const roll = gen.next();

  if (roll < 0.45 || wallet.spendable + wallet.promo < 100n) {
    const minor = BigInt(1 + Math.floor(gen.next() * 50)) * 100n;
    wallet.spendable += minor;
    return op('topUp', step, gen.id, {
      userId,
      amount: creditMinor(minor),
      source: 'card',
    });
  }
  if (gen.id.promo && roll < 0.6) {
    const minor = BigInt(1 + Math.floor(gen.next() * 20)) * 100n;
    wallet.promo += minor;
    return op('grantPromo', step, gen.id, {
      userId,
      amount: creditMinor(minor),
      expiresAt: 86_400_000,
    });
  }
  return spendOperation(gen, step, userId, wallet);
}

// A fixed system actor: these runs check accounting, not authorization.
function op(
  kind: Operation['kind'],
  step: number,
  id: Identity,
  fields: Record<string, unknown>,
): Operation {
  return {
    kind,
    idempotencyKey: `idem_${id.prefix}_${step}`,
    actor: { kind: 'system', service: id.service },
    ...fields,
  } as Operation;
}

/** Builds the full fixed operation sequence for one seed. */
export function seededProgram(
  seed: number,
  length: number,
  identity: ProgramIdentity,
): Operation[] {
  const gen: Gen = {
    next: rng(seed),
    id: {
      prefix: identity.prefix,
      service: identity.service,
      promo: identity.promo ?? true,
    },
  };
  const wallets = new Map<string, Wallet>();
  const operations: Operation[] = [];
  for (let step = 0; step < length; step += 1) {
    operations.push(nextOperation(gen, step, wallets));
  }
  return operations;
}
