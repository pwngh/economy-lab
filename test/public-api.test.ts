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
  checkEnv,
  createEconomy,
  noopLogger,
  noopMeter,
  operatorActor,
  spend,
  statusForError,
  systemActor,
  toAmount,
  topUp,
  userActor,
} from '#src/index.ts';

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

test('noopLogger and noopMeter accept every call and swallow it', async () => {
  noopLogger().log('info', 'x', {});
  noopMeter().count('c', 1);
  noopMeter().observe('o', 2);
  // and they plug into RuntimeDefaults without complaint
  const economy = await createEconomy({
    logger: noopLogger(),
    meter: noopMeter(),
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

test('checkEnv is empty for a complete env and lists every problem otherwise', () => {
  assert.deepEqual(checkEnv({}), []);
  assert.ok(
    checkEnv({ DATABASE_URL: 'mongodb://x' }).some((p) =>
      p.includes('DATABASE_URL'),
    ),
  );
  // Production with nothing set: secrets + rates + provider all reported at once.
  assert.ok(checkEnv({ NODE_ENV: 'production' }).length >= 3);
  // Production, fully configured: no problems.
  assert.deepEqual(
    checkEnv({
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
    }),
    [],
  );
});

test('a rejected outcome carries the typed RejectionDetail', async () => {
  const economy = await createEconomy();
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
  if (outcome.status === 'rejected') {
    assert.equal(outcome.reason, 'INSUFFICIENT_FUNDS');
    // The detail is typed (RejectionDetail): `required`/`available` are nameable, not `unknown`.
    assert.ok(outcome.detail?.required !== undefined);
    assert.ok(outcome.detail?.available !== undefined);
  }
  await economy.close();
});
