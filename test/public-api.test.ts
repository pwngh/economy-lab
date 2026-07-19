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
  createEconomy,
  memoryPorts,
  operatorActor,
  preflight,
  spend,
  statusForError,
  systemActor,
  toAmount,
  topUp,
  userActor,
} from '#src/index.ts';
import { silentLogger, silentMeter } from '#src/runtime.ts';

test('actor factories build each Principal kind', () => {
  assert.deepEqual(userActor('usr_1'), { kind: 'user', userId: 'usr_1' });
  assert.deepEqual(systemActor('billing'), {
    kind: 'system',
    service: 'billing',
  });
  assert.deepEqual(operatorActor('op_1'), {
    kind: 'operator',
    operatorId: 'op_1',
  });
});

test('silentLogger and silentMeter accept every call and swallow it', async () => {
  silentLogger().log('info', 'x', {});
  silentMeter().count('c', 1);
  silentMeter().observe('o', 2);
  // and they plug into a Ports bag without complaint
  const economy = createEconomy({
    ...memoryPorts({ signingKey: 'test-signing-key-32-bytes!!' }),
    logger: silentLogger(),
    meter: silentMeter(),
  });
  await economy.close();
});

test('statusForError maps codes to the canonical HTTP status', () => {
  const status = (
    code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    retryable = false,
  ) => statusForError(new EconomyError(code, 'x', { retryable }));
  assert.equal(status(ERROR_CODES.UNAUTHORIZED), 401);
  assert.equal(status(ERROR_CODES.INVALID_SIGNATURE), 401);
  assert.equal(status(ERROR_CODES.MALFORMED_OPERATION), 400);
  assert.equal(status(ERROR_CODES.INVALID_AMOUNT), 400);
  assert.equal(status(ERROR_CODES.STORE_FAILURE, true), 503);
  assert.equal(status(ERROR_CODES.STORE_FAILURE, false), 500);
});

test('preflight has no errors for a complete env and lists every problem otherwise', () => {
  const errors = (env: Record<string, string>) =>
    preflight(env).filter((issue) => issue.severity === 'error');
  assert.deepEqual(errors({}), []);
  assert.ok(
    errors({ DATABASE_URL: 'mongodb://x' }).some(
      (issue) => issue.path === 'DATABASE_URL',
    ),
  );
  // Production with nothing set: secrets + rates + provider all reported at once.
  assert.ok(errors({ NODE_ENV: 'production' }).length >= 3);
  // Production, fully configured, each absent optional port declined: no problems.
  assert.deepEqual(
    errors({
      NODE_ENV: 'production',
      WEBHOOK_SECRET: 'w',
      SIGNING_SECRET: 's',
      CREDIT_BUY_RATE: '8333',
      CREDIT_BUY_SCALE: '6',
      CREDIT_PAR_RATE: '5',
      CREDIT_PAR_SCALE: '3',
      PAYOUT_RATE: '5',
      PAYOUT_SCALE: '3',
      PROCESSOR_URL: 'https://payouts.example',
      MATURITY_HORIZON_CARD_MS: '604800000',
      VELOCITY_LIMIT_MINOR: '5000000',
      DISPATCHER_DECLINED: '1',
      PAYEES_DECLINED: '1',
      ANCHOR_DECLINED: '1',
    }),
    [],
  );
});

test('a rejected outcome carries the typed RejectionDetail', async () => {
  const economy = createEconomy(
    memoryPorts({ signingKey: 'test-signing-key-32-bytes!!' }),
  );
  await economy.submit(
    topUp({
      idempotencyKey: 't1',
      actor: systemActor('billing'),
      userId: 'usr_1',
      amount: toAmount('CREDIT', 100n),
      source: 'card',
    }),
  );
  const outcome = await economy.submit(
    spend({
      idempotencyKey: 's1',
      actor: userActor('usr_1'),
      orderId: 'ord_1',
      buyerId: 'usr_1',
      sku: 'sku_1',
      price: toAmount('CREDIT', 999n),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    }),
  );
  assert.equal(outcome.status, 'rejected');
  if (
    outcome.status === 'rejected' &&
    outcome.detail.reason === 'INSUFFICIENT_FUNDS'
  ) {
    // The detail is typed (RejectionDetail): `need`/`have` are nameable, not `unknown`.
    assert.ok(outcome.detail.need !== undefined);
    assert.ok(outcome.detail.have !== undefined);
  } else {
    assert.fail('expected an INSUFFICIENT_FUNDS rejection');
  }
  await economy.close();
});
