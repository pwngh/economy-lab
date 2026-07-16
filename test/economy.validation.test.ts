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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { topUp, spend, grantPromo, credit } from '#test/support/builders.ts';
import { hasCode } from '#test/support/capabilities.ts';

// Rejecting a blank owner before any money work stops a malformed request from creating an
// ownerless wallet. See validateOperation in economy.ts.
describe('Submit Input Validation', () => {
  test('rejects a topUp whose user id is blank', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit(topUp({ userId: '', amount: credit('10.00') })),
      hasCode('OP.MALFORMED'),
    );
  });

  test('rejects an operation whose user id is only whitespace', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit(grantPromo({ userId: '   ', amount: credit('5.00') })),
      hasCode('OP.MALFORMED'),
    );
  });

  test('rejects a spend whose buyer id is blank', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit(
        spend({
          buyerId: '',
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('rejects a spend whose seller id is blank', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit(
        spend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [{ sellerId: '', shareBps: 10_000 }],
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('rejects an unknown operation kind with a typed fault', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit({
        kind: 'mintGold',
        idempotencyKey: 'idem_unknown',
        actor: { kind: 'system', service: 'test' },
      } as never),
      hasCode('OP.MALFORMED'),
    );
  });

  test('accepts a well-formed operation', async () => {
    const eco = makeEconomy();
    const outcome = await eco.submit(
      topUp({ userId: 'usr_alice', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');
  });
});

// Without the key check, a malformed request could collapse distinct ops into one "duplicate".
// See validateOperation in economy.ts.
describe('Submit Idempotency-Key & Amount Guards', () => {
  test('rejects an operation with an empty idempotencyKey', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit({
        ...topUp({ userId: 'usr_alice', amount: credit('10.00') }),
        idempotencyKey: '',
      }),
      hasCode('OP.MALFORMED'),
    );
  });

  test('rejects a whitespace-only idempotencyKey', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit({
        ...topUp({ userId: 'usr_alice', amount: credit('10.00') }),
        idempotencyKey: '   ',
      }),
      hasCode('OP.MALFORMED'),
    );
  });

  test('rejects a non-positive amount', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit(topUp({ userId: 'usr_alice', amount: credit('0.00') })),
      hasCode('MONEY.INVALID_AMOUNT'),
    );
  });

  test('rejects an amount beyond the maximum', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit(
        topUp({ userId: 'usr_alice', amount: credit('20000000000000.00') }),
      ),
      hasCode('MONEY.INVALID_AMOUNT'),
    );
  });
});
