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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ERROR_CODES,
  EconomyError,
  boot,
  createEconomy,
  memoryPorts,
  openPorts,
  spend,
  spendable,
  toAmount,
  topUp,
} from '#src/index.ts';
import { configuredRates, memoryProcessor } from '#src/adapters/index.ts';
import { silentLogger } from '#src/runtime.ts';
import type { Principal } from '#src/index.ts';

const SYSTEM_ACTOR: Principal = { kind: 'system', service: 'quickstart-test' };

test('boot() runs the quickstart end to end with no infrastructure', async () => {
  const { economy, worker } = await boot({}, { logger: silentLogger() });
  const outcome = await economy.submit(
    topUp({
      idempotencyKey: 'k1',
      actor: SYSTEM_ACTOR,
      userId: 'usr_1',
      amount: toAmount('CREDIT', 5_000n),
      source: 'card',
    }),
  );
  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await economy.read.balance(spendable('usr_1')),
    toAmount('CREDIT', 5_000n),
  );

  assert.ok(worker, 'boot() binds a worker by default');
  const run = await worker.sweep();
  assert.equal(run.batch.checkpoint.ok, true);

  const report = await economy.read.health();
  assert.equal(report.conserved, true);
  await economy.close();
});

test('createEconomy(memoryPorts(...)) lets a fresh topUp be spent immediately (dev horizon is 0)', async () => {
  const economy = createEconomy(
    memoryPorts({ signingKey: 'test-signing-key-32-bytes!!' }),
  );
  await economy.submit(
    topUp({
      idempotencyKey: 'k_fund',
      actor: SYSTEM_ACTOR,
      userId: 'usr_q',
      amount: toAmount('CREDIT', 1_000n),
      source: 'card',
    }),
  );

  const outcome = await economy.submit(
    spend({
      idempotencyKey: 'k_spend',
      actor: SYSTEM_ACTOR,
      orderId: 'ord_q1',
      buyerId: 'usr_q',
      sku: 'sku_q',
      price: toAmount('CREDIT', 400n),
      recipients: [{ sellerId: 'usr_q2', shareBps: 10_000 }],
    }),
  );
  assert.equal(outcome.status, 'committed');
  await economy.close();
});

test('operation builders set the kind and pass every field through', () => {
  const op = spend({
    idempotencyKey: 'k2',
    actor: SYSTEM_ACTOR,
    orderId: 'ord_1',
    buyerId: 'usr_1',
    sku: 'sku_1',
    price: toAmount('CREDIT', 100n),
    recipients: [{ sellerId: 'usr_2', shareBps: 10_000 }],
  });
  assert.equal(op.kind, 'spend');
  assert.equal(op.orderId, 'ord_1');
  assert.deepEqual(op.price, toAmount('CREDIT', 100n));
});

test('memoryProcessor answers a resend of one key with the same providerRef', async () => {
  const processor = memoryProcessor();
  const first = await processor.submitPayout({
    key: 'p1',
    userId: 'usr_1',
    amount: toAmount('USD', 100n),
  });
  const resend = await processor.submitPayout({
    key: 'p1',
    userId: 'usr_1',
    amount: toAmount('USD', 100n),
  });
  const other = await processor.submitPayout({
    key: 'p2',
    userId: 'usr_1',
    amount: toAmount('USD', 100n),
  });
  assert.equal(first.providerRef, resend.providerRef);
  assert.notEqual(first.providerRef, other.providerRef);
});

test('openPorts in production fails fast when the real externals are missing', async () => {
  await assert.rejects(
    openPorts({
      NODE_ENV: 'production',
      WEBHOOK_SECRET: 'x',
      SIGNING_SECRET: 'y',
    }),
    (error: unknown) =>
      error instanceof EconomyError &&
      error.code === ERROR_CODES.CONFIG_INVALID &&
      error.message.startsWith('Preflight failed:'),
  );
});

test('configuredRates rejects a config where payout exceeds par', () => {
  assert.throws(
    () =>
      configuredRates({
        buyRate: 1n,
        buyScale: 2,
        parRate: 5n,
        parScale: 3,
        payoutRate: 2n,
        payoutScale: 2,
      }),
    (error: unknown) =>
      error instanceof EconomyError &&
      error.code === ERROR_CODES.CONFIG_INVALID,
  );
});
