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

// True when the thrown value is an Error carrying the given fault `code`.
function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && (error as { code?: string }).code === code;
}

// The submit pipeline turns away an operation that names a user wallet account with a blank owner
// — typically an empty user id from an unvalidated input — before any money work, so a malformed
// request can never create a phantom, ownerless wallet. See validateOperation in economy.ts.
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

  test('accepts a well-formed operation', async () => {
    const eco = makeEconomy();
    const outcome = await eco.submit(
      topUp({ userId: 'usr_alice', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');
  });
});

// The shared guard also requires a non-empty idempotency key and a sane money amount, so a
// malformed request can't collapse distinct operations into one "duplicate" or move a
// zero/negative/absurd amount. See validateOperation in economy.ts.
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
