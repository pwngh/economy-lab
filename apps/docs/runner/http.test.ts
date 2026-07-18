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

// Every CallTabs HTTP snippet, POSTed for real at createServer over a fresh economy: the curl
// bytes a page shows are the bytes this file sends, so an example that stops committing fails
// CI. Ids a page cannot know ahead of time (a minted txn, saga, or subscription id) are the one
// substitution: the test asserts the page's placeholder value first, then swaps in the id the
// seeded session actually minted. The last test proves no snippet file escapes coverage.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { earned, spendable } from '#src/accounts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { economyFromCapabilities } from '#src/economy.ts';
import { workerCtxFrom } from '#src/index.ts';
import { toAmount } from '#src/money.ts';
import { createServer } from '#src/server.ts';
import { createWorker } from '#src/worker/index.ts';
import {
  defaultPricing,
  fakeProcessor,
  fixedClock,
  fixedRates,
  noopMeter,
  seededDigest,
  seededSigner,
  sequentialIds,
  testConfig,
  testLogger,
} from '#test/support/capabilities.ts';

import type { Economy, Operation, Principal } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';
import type { Worker } from '#src/worker/index.ts';

const DIR = fileURLToPath(new URL('../app/snippets/http/', import.meta.url));

// Same assembly as test/support makeEconomy, except the fixed clock sits at a real date instead
// of 0: pages print literal future timestamps (a promo expiry), and grantPromo bounds them
// relative to now.
const NOW = Date.UTC(2026, 6, 1);

function freshEconomy(): { economy: Economy; store: Store; worker: Worker } {
  const digest = seededDigest(1);
  const clock = fixedClock(NOW);
  const store = memoryStore({ digest, clock });
  const caps = {
    store,
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(1),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: testConfig(),
  };
  // The worker shares the economy's store and context, so a page whose example presumes a
  // sweep already ran (settle-payout needs a SUBMITTED saga) can run that sweep for real.
  return {
    economy: economyFromCapabilities(caps),
    store,
    worker: createWorker(store, workerCtxFrom(caps)),
  };
}

type Body = Record<string, unknown>;

const covered = new Set<string>();

function payload(name: string): Body {
  covered.add(name);
  const sh = readFileSync(`${DIR}${name}.sh`, 'utf8');
  const raw = sh.match(/-d '([\s\S]+)'\s*$/)?.[1];
  if (raw === undefined) throw new Error(`${name}.sh carries no -d '…' payload`);
  return JSON.parse(raw) as Body;
}

async function commitOverHttp(economy: Economy, body: Body): Promise<void> {
  const server = createServer(economy);
  const response = await server(
    new Request('https://economy.example/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { status: string }).status).toBe('committed');
}

const system: Principal = { kind: 'system', service: 'seed' };

// In-process seeding for the state a page's example presumes; a rejected seed would silently
// invalidate the page's committed claim, so it throws instead.
async function seed(economy: Economy, operation: Operation) {
  const outcome = await economy.submit(operation);
  if (outcome.status !== 'committed') {
    throw new Error(`seed ${operation.kind}: ${outcome.status}`);
  }
  return outcome.transaction;
}

const seedTopUp = (userId: string, minor: bigint): Operation => ({
  kind: 'topUp',
  idempotencyKey: `seed_topup_${userId}`,
  actor: system,
  userId,
  amount: toAmount('CREDIT', minor),
  source: 'card',
});

// adjust takes an operator principal only, so the earned-balance seed carries one.
const operator: Principal = { kind: 'operator', operatorId: 'op_seed' };

const seedEarned = (userId: string, minor: bigint): Operation => ({
  kind: 'adjust',
  idempotencyKey: `seed_earned_${userId}`,
  actor: operator,
  account: earned(userId),
  amount: toAmount('CREDIT', minor),
  reason: 'seed: earned balance',
});

it('top-up commits as shown', async () => {
  await commitOverHttp(freshEconomy().economy, payload('top-up'));
});

it('grant-promo commits as shown', async () => {
  await commitOverHttp(freshEconomy().economy, payload('grant-promo'));
});

it('spend commits as shown, against a funded buyer', async () => {
  const { economy } = freshEconomy();
  await seed(economy, seedTopUp('usr_buyer', 5_000n));
  await commitOverHttp(economy, payload('spend'));
});

it('refund commits as shown, against the sale it names', async () => {
  const { economy } = freshEconomy();
  await seed(economy, seedTopUp('usr_buyer', 5_000n));
  await seed(economy, {
    kind: 'spend',
    idempotencyKey: 'seed_spend_ord_1',
    actor: { kind: 'user', userId: 'usr_buyer' },
    orderId: 'ord_1',
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: toAmount('CREDIT', 400n),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
  await commitOverHttp(economy, payload('refund'));
});

it('clawback commits as shown, against a funded user', async () => {
  const { economy } = freshEconomy();
  await seed(economy, seedTopUp('usr_a1', 5_000n));
  await commitOverHttp(economy, payload('clawback'));
});

it('request-payout commits as shown, against an earned balance', async () => {
  const { economy } = freshEconomy();
  await seed(economy, seedEarned('usr_a1', 2_500_000n));
  await commitOverHttp(economy, payload('request-payout'));
});

it('reverse-payout commits as shown, against the saga its page opened', async () => {
  const { economy } = freshEconomy();
  await seed(economy, seedEarned('usr_seller', 10_000n));
  const request = await seed(economy, {
    kind: 'requestPayout',
    idempotencyKey: 'seed_payout_usr_seller',
    actor: { kind: 'user', userId: 'usr_seller' },
    userId: 'usr_seller',
    amount: toAmount('CREDIT', 10_000n),
  });
  const body = payload('reverse-payout');
  expect(body.sagaId).toBe('pay_1');
  body.sagaId = request.meta.sagaId as string;
  await commitOverHttp(economy, body);
});

it('settle-payout commits as shown, against the saga the worker submitted', async () => {
  const { economy, worker } = freshEconomy();
  await seed(economy, seedEarned('usr_seller', 10_000n));
  const request = await seed(economy, {
    kind: 'requestPayout',
    idempotencyKey: 'seed_payout_usr_seller',
    actor: { kind: 'user', userId: 'usr_seller' },
    userId: 'usr_seller',
    amount: toAmount('CREDIT', 10_000n),
  });
  // The payouts sweep converts the reserve and calls the rail: RESERVED becomes SUBMITTED,
  // which is the state the settle example presumes.
  await worker.runOnce({ now: NOW + 60_000, limit: 10 });
  const sagaId = request.meta.sagaId as string;
  const saga = await economy.read.saga(sagaId);
  expect(saga?.state).toBe('SUBMITTED');

  const body = payload('settle-payout');
  expect(body.sagaId).toBe('pay_9f2c1b');
  body.sagaId = sagaId;
  await commitOverHttp(economy, body);
});

it('subscribe commits as shown, against a funded subscriber', async () => {
  const { economy } = freshEconomy();
  await seed(economy, seedTopUp('usr_a', 100_000n));
  await commitOverHttp(economy, payload('subscribe'));
});

it('cancel-subscription commits as shown, against the subscription its page opened', async () => {
  const { economy, store } = freshEconomy();
  await seed(economy, seedTopUp('usr_a', 100_000n));
  await seed(economy, {
    kind: 'subscribe',
    idempotencyKey: 'seed_subscribe_usr_a',
    actor: { kind: 'user', userId: 'usr_a' },
    userId: 'usr_a',
    sellerId: 'usr_s',
    sku: 'club_pass',
    price: toAmount('CREDIT', 50_000n),
    periodMs: 2_592_000_000,
  });
  const subscription = await store.subscriptions.activeFor('usr_a', 'club_pass', 'usr_s');
  if (subscription === null) throw new Error('seed subscribe left no active subscription');
  const body = payload('cancel-subscription');
  expect(body.subscriptionId).toBe('sub_abc');
  body.subscriptionId = subscription.id;
  await commitOverHttp(economy, body);
});

it('grant-entitlement commits as shown', async () => {
  await commitOverHttp(freshEconomy().economy, payload('grant-entitlement'));
});

it('revoke-entitlement commits as shown, against the grant it revokes', async () => {
  const { economy } = freshEconomy();
  await seed(economy, {
    kind: 'grantEntitlement',
    idempotencyKey: 'seed_grant_usr_owner',
    actor: system,
    userId: 'usr_owner',
    sku: 'wrld_pass',
  });
  await commitOverHttp(economy, payload('revoke-entitlement'));
});

it('adjust commits as shown', async () => {
  await commitOverHttp(freshEconomy().economy, payload('adjust'));
});

it('reverse commits as shown, against the posting its page names', async () => {
  const { economy } = freshEconomy();
  const adjusted = await seed(economy, {
    kind: 'adjust',
    idempotencyKey: 'seed_adjust_usr_alice',
    actor: operator,
    account: spendable('usr_alice'),
    amount: toAmount('CREDIT', 250n),
    reason: 'seed: posting to reverse',
  });
  const body = payload('reverse');
  expect(body.txnId).toBe('txn_1');
  body.txnId = adjusted.id;
  await commitOverHttp(economy, body);
});

it('every http snippet file is exercised above', () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sh'))
    .map((f) => f.replace(/\.sh$/, ''))
    .sort();
  expect(files).toEqual([...covered].sort());
});
