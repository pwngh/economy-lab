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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEconomyModule } from '../src/module.js';
import { createApp } from '../src/app.js';
import { openTestEconomy } from '@pwngh/economy-test';
import { credits } from '@pwngh/economy-money';
import type { EconomyEvent } from '@pwngh/economy-lab';

test('after: handlers resolve, ride the outbox relay, and see the committed event', async () => {
  const seen: EconomyEvent[] = [];
  const mod = resolveEconomyModule({
    authenticate: false,
    after: {
      'economy.credits.topped_up': (event: EconomyEvent) =>
        void seen.push(event),
    },
  });
  assert.deepEqual(mod.exports, ['authenticate', 'after']);

  const t = await openTestEconomy(mod);
  await t.fund('ada', credits(200));
  assert.equal(seen.length, 0, 'nothing delivered before the relay runs');
  await t.worker.tick();
  assert.equal(seen.length, 1, 'the relay delivered the committed event');
  assert.equal(seen[0]!.type, 'economy.credits.topped_up');
  assert.equal(seen[0]!.subject, 'usr_ada');
  await t.worker.tick();
  assert.equal(seen.length, 1, 'a relayed row is not redelivered');
  await t.close();
});

test('after: a throwing handler retries to maxOutboxAttempts, then dead-letters', async () => {
  let calls = 0;
  // Only the second delivery attempt ever succeeds; every other one throws.
  const t = await openTestEconomy({
    authenticate: false,
    policy: { maxOutboxAttempts: 2 },
    after: {
      'economy.credits.topped_up': () => {
        calls += 1;
        if (calls !== 2) throw new Error('flaky consumer');
      },
    },
  });
  await t.fund('ada', credits(100));
  await t.worker.tick();
  await t.worker.tick();
  assert.equal(calls, 2, 'the failed attempt was retried once');
  await t.worker.tick();
  assert.equal(calls, 2, 'the delivered row stays delivered');

  await t.fund('ben', credits(100));
  await t.worker.tick();
  await t.worker.tick();
  await t.worker.tick();
  assert.equal(calls, 4, 'two attempts, then the row is dead-lettered');
  await t.close();
});

test('after: refusals — unknown event, non-function, ports that already carry a dispatcher', async () => {
  assert.throws(
    () => resolveEconomyModule({ after: { 'economy.big.bang': () => {} } }),
    /UNKNOWN_EVENT.*fourteen events/s,
  );
  assert.throws(
    () => resolveEconomyModule({ after: { 'economy.sale.completed': 'yes' } }),
    /SEAM_SHAPE.*after/s,
  );

  // Both doors to a dispatcher conflict with `after`: a module ports override, and a
  // caller-supplied portsBag.
  const { memoryPorts } = await import('@pwngh/economy-lab');
  await assert.rejects(
    createApp(
      {
        authenticate: false,
        after: { 'economy.sale.completed': () => {} },
        ports: { dispatcher: async () => {} },
      },
      { env: {} },
    ),
    /ROLE_CONFLICT.*one owner per seam/s,
  );
  await assert.rejects(
    createApp(
      {
        authenticate: false,
        after: { 'economy.sale.completed': () => {} },
      },
      {
        env: {},
        portsBag: {
          ...memoryPorts({ signingKey: 'k' }),
          dispatcher: async () => {},
        },
      },
    ),
    /ROLE_CONFLICT.*one owner per seam/s,
  );

  const ok = await createApp(
    {
      authenticate: false,
      after: { 'economy.sale.completed': () => {} },
    },
    { env: {}, portsBag: memoryPorts({ signingKey: 'k' }) },
  );
  await ok.close();
});

// The after-seam desugar print is asserted in economy-cli's render suite.
