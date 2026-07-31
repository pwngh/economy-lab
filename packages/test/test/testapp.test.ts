/**
 * @pwngh/economy-test
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
// testApp is the internal floor under openTestEconomy — reached by file, never by the
// package root; canonicalForm stays public.
import { testApp } from '../src/lib/testapp.js';
import { canonicalForm } from '../src/index.js';
import { isRejection, topUp, idempotencyKey } from '@pwngh/economy-core/ops';
import { credits } from '@pwngh/economy-money';
import { systemActor } from '@pwngh/economy-auth';

test('testApp is deterministic: fixed clock, sequential ids, identical runs', async () => {
  const run = async () => {
    const t = await testApp({ authenticate: false }, { now: 1_000 });
    const out = await t.economy.submit(
      topUp({
        idempotencyKey: idempotencyKey('t', 'det', '1'),
        actor: systemActor('test'),
        userId: 'usr_a',
        amount: credits(20),
        source: 'test',
      }),
    );
    assert.ok(!isRejection(out));
    const txnId = (out as { transaction: { id: string } }).transaction.id;
    const health = (await t.request('/healthz')).status;
    t.clock.advance(60_000);
    const swept = await t.tick();
    await t.close();
    return {
      txnId,
      health,
      now: t.clock.now(),
      jobs: Object.keys(swept.batch).length,
    };
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a, b, 'two runs produce the same rows');
  assert.equal(a.health, 200);
  assert.equal(a.now, 61_000);
  assert.equal(a.txnId, 'txn_1', "the lab's sequentialIds mint txn_1 first");
});

test('canonical form: stable keys, named functions, decimal bigints', async () => {
  const fn = async () => null;
  Object.defineProperty(fn, 'name', { value: 'myAuth' });
  const c = canonicalForm({ b: 1n, a: fn, z: [2n] }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(c), ['a', 'b', 'z']);
  assert.equal(c.a, '[fn myAuth]');
  assert.equal(c.b, '1');
  assert.deepEqual(c.z, ['2']);
  const t = await testApp({ authenticate: false });
  assert.equal(
    JSON.stringify(t.canonical()),
    JSON.stringify(t.canonical()),
    'snapshot-stable',
  );
  await t.close();
});
