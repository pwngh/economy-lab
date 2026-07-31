/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import {
  credits,
  encodeAmount,
  idempotencyKey,
  inspectConfig,
  isRejection,
  memoryPorts,
  spend,
  spendable,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';
import type { Economy } from '@pwngh/economy-lab';
import { devAuthenticate, devTokens } from '@pwngh/economy-auth';
import { effectivePolicy, resolveEconomyModule } from './module.js';
import type {
  EconomyModule,
  PortsOverrides,
  ResolvedModule,
} from './module.js';

// The memory posture as ordinary port overrides: the memory store (sharing its clock and
// digest), the 'economy-dev' signer, the in-memory rail; cache and dispatcher declined, so
// a dev shell pointing at real infrastructure stays inert.
function devPortsOverrides(
  env: Record<string, string | undefined>,
  mod: EconomyModule,
): PortsOverrides {
  const bag = memoryPorts({
    signingKey: env.SIGNING_SECRET ?? 'economy-dev',
    config: inspectConfig(env, effectivePolicy(mod)),
  });
  return {
    clock: bag.clock,
    digest: bag.digest,
    store: bag.store,
    signer: bag.signer,
    processor: bag.processor,
    cache: false,
    dispatcher: false,
  };
}

/**
 * The dev posture as a pure decorator — createApp keeps one assembly path. Returns the
 * definition with, where the module states nothing of its own: `authenticate` filled by
 * the dev-token table, and `ports` filled with the memory posture (memory store sharing
 * its clock and digest, the 'economy-dev' signer unless SIGNING_SECRET is set, the
 * in-memory rail, cache and dispatcher declined). A stated posture or `ports` export is
 * never overridden, so applying it twice is a no-op.
 */
export function withDev(
  definition: EconomyModule | ResolvedModule | Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): ResolvedModule {
  const mod =
    'file' in definition && 'exports' in definition
      ? (definition as ResolvedModule)
      : resolveEconomyModule(definition as Record<string, unknown>);
  return Object.freeze({
    ...mod,
    authenticate: mod.authenticate ?? devAuthenticate(devTokens()),
    ports: mod.ports ?? devPortsOverrides(env, mod),
  });
}

/** The tutorial trio with fixed keys: a topUp, a spend, and an honest rejection. Replay-safe.
 *  Amounts sit under the dev velocity caps (VELOCITY_*_LIMIT_MINOR) — policy is real by default. */
export async function seedDemo(economy: Economy): Promise<string> {
  const actor = systemActor('demo');
  await economy.submit(
    topUp({
      idempotencyKey: idempotencyKey('demo', 'topup', 'ada'),
      actor,
      userId: 'usr_ada',
      amount: credits(400),
      source: 'demo',
    }),
  );
  await economy.submit(
    spend({
      idempotencyKey: idempotencyKey('demo', 'spend', 'ada'),
      actor: userActor('usr_ada'),
      orderId: 'ord_demo_1',
      buyerId: 'usr_ada',
      sku: 'starter-pack',
      price: credits(120),
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    }),
  );
  const rejected = await economy.submit(
    spend({
      idempotencyKey: idempotencyKey('demo', 'overdraft', 'ada'),
      actor: userActor('usr_ada'),
      orderId: 'ord_demo_2',
      buyerId: 'usr_ada',
      sku: 'yacht',
      price: credits(300),
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    }),
  );
  const balance = await economy.read.balance(spendable('usr_ada'));
  return `demo seeded — ada spendable ${encodeAmount(balance)}; overdraft ${
    isRejection(rejected)
      ? `rejected ${rejected.detail.reason}`
      : 'unexpectedly passed'
  }`;
}
