/// <reference types="node" />
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
 * The catalog port lives on the ports bag, so a spend must match the host's live offer whichever
 * door it arrived through, and the HTTP server has no catalog option of its own. With the port
 * absent, behavior is untouched.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '#src/server.ts';
import type { CatalogPort, FetchHandler, ServerOptions } from '#src/server.ts';
import { createEconomy, memoryPorts } from '#src/index.ts';
import type { Economy } from '#src/contract.ts';
import { credits } from '#src/money.ts';
import type { Amount } from '#src/money.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { fixedClock, silentMeter } from '#src/runtime.ts';
import {
  fixedRates,
  testConfig,
  testLogger,
  testSecrets,
} from '#test/support/capabilities.ts';

function makeServer(options: Partial<ServerOptions> = {}): FetchHandler {
  return createServer({
    economy: makeEconomy(),
    ports: {
      config: testConfig(),
      secrets: testSecrets(),
      clock: fixedClock(0),
      meter: silentMeter(),
      logger: testLogger(),
      rates: fixedRates(),
    },
    authenticate: false,
    ...options,
  });
}

const post = async (handler: FetchHandler, body: Record<string, unknown>) => {
  const response = await handler(
    new Request('https://economy.test/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return (await response.json()) as {
    status: string;
    detail: { reason: string; sku: string; field: string };
  };
};

const topUp = (userId: string) => ({
  kind: 'topUp',
  idempotencyKey: `idem_top_${userId}`,
  actor: { kind: 'system', service: 'test' },
  userId,
  amount: 'CREDIT:500.00',
  source: 'card',
});

const spend = (price: string, recipients: unknown[], n = 1) => ({
  kind: 'spend',
  idempotencyKey: `idem_spend_${n}`,
  actor: { kind: 'user', userId: 'usr_b' },
  orderId: `ord_${n}`,
  buyerId: 'usr_b',
  sku: 'sword',
  price,
  recipients,
});

const goodSplit = [{ sellerId: 'usr_s', shareBps: 10_000 }];

const catalog: CatalogPort = {
  lookup: async (sku) =>
    sku === 'sword' ? { price: credits(100), recipients: goodSplit } : null,
};

// `Ports.catalog` gates `submit`, which is what every door — HTTP, a package route, an in-process
// call — goes through. The server carries no catalog option beside it; one that did would gate its
// own handler and leave the others open.
describe('The Catalog Port On Ports Gates Submit Itself', () => {
  const withCatalog = (port?: CatalogPort) =>
    createEconomy({
      ...memoryPorts({ signingKey: 'k', config: testConfig() }),
      ...(port ? { catalog: port } : {}),
    });

  const buy = (economy: Economy, price: Amount, n: number) =>
    economy.submit({
      kind: 'spend',
      idempotencyKey: `idem_port_${n}`,
      actor: { kind: 'user', userId: 'usr_b' },
      orderId: `ord_port_${n}`,
      buyerId: 'usr_b',
      sku: 'sword',
      price,
      recipients: goodSplit,
    });

  const fund = (economy: Economy) =>
    economy.submit({
      kind: 'topUp',
      idempotencyKey: 'idem_port_fund',
      actor: { kind: 'system', service: 'test' },
      userId: 'usr_b',
      amount: credits(500),
      source: 'card',
    });

  test('a mispriced spend is refused with no server in front of it', async () => {
    const economy = withCatalog(catalog);
    assert.equal((await fund(economy)).status, 'committed');

    const wrong = await buy(economy, credits(1), 1);
    assert.equal(wrong.status, 'rejected');
    assert.deepEqual(wrong.status === 'rejected' ? wrong.detail : null, {
      reason: 'CATALOG_MISMATCH',
      sku: 'sword',
      field: 'price',
    });

    assert.equal((await buy(economy, credits(100), 2)).status, 'committed');
    await economy.close();
  });

  test('a server mounted over it inherits the gate with no catalog option of its own', async () => {
    const economy = withCatalog(catalog);
    const handler = makeServer({ economy });
    await post(handler, topUp('usr_b'));

    const out = await post(handler, spend('CREDIT:1.00', goodSplit, 11));
    assert.equal(out.status, 'rejected');
    assert.equal(out.detail.reason, 'CATALOG_MISMATCH');
    await economy.close();
  });

  test('with the slot empty the economy prices nothing', async () => {
    const economy = withCatalog();
    assert.equal((await fund(economy)).status, 'committed');
    assert.equal((await buy(economy, credits(1), 3)).status, 'committed');
    await economy.close();
  });

  // The server option is gone, so a host that reaches for it must fail at the compiler rather
  // than be handed a gate on one door. The runtime half is the half a type cannot state: the key
  // is inert, not honored, so a host cannot end up with edge-only enforcement by accident.
  test('the server has no catalog option, and a host that passes one gets nothing', async () => {
    const economy = withCatalog();
    const handler = makeServer({
      economy,
      // @ts-expect-error `ServerOptions` carries no catalog; the gate is on `Ports.catalog`.
      catalog,
    });
    await post(handler, topUp('usr_b'));

    const out = await post(handler, spend('CREDIT:1.00', goodSplit, 12));
    assert.equal(out.status, 'committed', 'the stray option gated nothing');
    await economy.close();
  });
});
