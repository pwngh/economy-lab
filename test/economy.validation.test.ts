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
import {
  KINDS,
  SAMPLES,
  declaredFields,
} from '#test/support/operation-samples.ts';
import {
  OPERATION_FIELDS,
  assertOperationShape,
  hasWireShape,
} from '#src/wire-contract.ts';
import { earned, spendable } from '#src/accounts.ts';
import { encodeAmount } from '#src/money.ts';

import type { Operation } from '#src/contract.ts';
import type { BaseSpec, Spec } from '#src/wire-contract.ts';

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

// TypeScript stops a wrongly-typed field at compile time; nothing else did. A host calling from
// JavaScript, through an `as` cast, or with data off an untyped source reached the handlers with
// any value at all, and an account id is built by interpolation: a non-string `userId` became the
// account `[object Object]:spendable` and the posting committed. The gate runs at
// validateOperation, the one seam both submit and submitBatch pass.
//
// One wrong value per declared shape, each a legal JavaScript value the contract does not type
// that way. The amount row is the encoded wire spelling, which is exactly what a JSON-fed caller
// holds before the HTTP door converts it.
const WRONG_FOR: { readonly [T in BaseSpec]: unknown } = {
  string: {},
  int: '2592000000',
  boolean: 'true',
  amount: 'CREDIT:12.34',
  recipients: { sellerId: 'usr_creator', shareBps: 10_000 },
  object: 42,
};

const baseOf = (tag: Spec): BaseSpec =>
  (tag.endsWith('?') ? tag.slice(0, -1) : tag) as BaseSpec;

const COERCED = '[object Object]';

describe('Submit Field Shape Guards', () => {
  test('a non-string userId is refused, and credits no coerced account', async () => {
    const eco = makeEconomy();
    await assert.rejects(
      eco.submit({
        ...topUp({ userId: 'usr_alice', amount: credit('10.00') }),
        userId: {},
      } as unknown as Operation),
      (error: unknown) =>
        hasCode('OP.MALFORMED')(error) &&
        (error as Error).message === 'topUp.userId must be a non-empty string.',
    );
    assert.equal(
      encodeAmount(await eco.read.balance(spendable(COERCED))),
      'CREDIT:0.00',
    );
  });

  test('two distinct non-string ids cannot merge into one wallet', async () => {
    const eco = makeEconomy();
    for (const id of [{ a: 1 }, { b: 2 }]) {
      await assert.rejects(
        eco.submit({
          ...topUp({ userId: 'usr_alice', amount: credit('10.00') }),
          userId: id,
        } as unknown as Operation),
        hasCode('OP.MALFORMED'),
      );
    }
    const wallet = await eco.read.wallet(COERCED);
    assert.equal(encodeAmount(wallet.spendable), 'CREDIT:0.00');
  });

  // The one field on this list that moves money OUT: an earned balance is payable, so a coerced
  // seller id was a payout saga against an account nobody named.
  test('a non-string recipients[].sellerId earns nothing', async () => {
    const eco = makeEconomy();
    await eco.submit(topUp({ userId: 'usr_buyer', amount: credit('500.00') }));
    await assert.rejects(
      eco.submit({
        ...spend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('100.00'),
          recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
        }),
        actor: { kind: 'system', service: 'test' },
        recipients: [{ sellerId: {}, shareBps: 10_000 }],
      } as unknown as Operation),
      (error: unknown) =>
        hasCode('OP.MALFORMED')(error) &&
        (error as Error).message ===
          'spend.recipients must be an array of { sellerId: string, shareBps: integer }.',
    );
    assert.equal(
      encodeAmount(await eco.read.balance(earned(COERCED))),
      'CREDIT:0.00',
    );
  });

  // The roster is read off what submit REFUSED, then reconciled against the table, so a gate that
  // stopped covering a kind fails on the set rather than on a total that still adds up.
  test('every field the contract declares is refused through submit, named by field', async () => {
    const refused: string[] = [];
    for (const kind of KINDS) {
      for (const [field, tag] of Object.entries(
        OPERATION_FIELDS[kind] as Record<string, Spec>,
      )) {
        const eco = makeEconomy();
        const operation = {
          ...SAMPLES[kind],
          idempotencyKey: `q77_${kind}_${field}`,
          [field]: WRONG_FOR[baseOf(tag)],
        } as unknown as Operation;
        await assert.rejects(
          eco.submit(operation),
          (error: unknown) =>
            hasCode('OP.MALFORMED')(error) &&
            (error as Error).message.startsWith(`${kind}.${field} must be `),
          `${kind}.${field} (${tag}) was not refused by name`,
        );
        refused.push(`${kind}.${field}`);
      }
    }
    const declared = KINDS.flatMap((kind) =>
      declaredFields(kind).map((field) => `${kind}.${field}`),
    );
    assert.deepEqual(refused.sort(), [...declared].sort());
    assert.equal(refused.length, 46, `refused ${refused.length} fields`);
  });

  // A gate refusing everything would pass the roster above and reject every legitimate call, so
  // the well-formed sample of every kind runs through the same gate and must survive it.
  test('every well-formed field passes the same gate', () => {
    let examined = 0;
    for (const kind of KINDS) {
      assert.doesNotThrow(
        () => assertOperationShape(SAMPLES[kind]),
        `${kind}'s well-formed sample was refused`,
      );
      for (const [field, tag] of Object.entries(
        OPERATION_FIELDS[kind] as Record<string, Spec>,
      )) {
        const value = (SAMPLES[kind] as unknown as Record<string, unknown>)[
          field
        ];
        assert.ok(hasWireShape(tag, value), `${kind}.${field} (${tag})`);
        examined += 1;
      }
    }
    assert.equal(examined, 46, `examined ${examined} declared fields`);
  });

  test('an absent optional field passes and a present one is checked', () => {
    assert.ok(hasWireShape('string?', undefined));
    assert.ok(!hasWireShape('string?', 12));
    assert.ok(!hasWireShape('string', undefined));
  });

  test('submitBatch runs the gate on its own slot, not the batch', async () => {
    const eco = makeEconomy();
    const [good, bad] = await eco.submitBatch([
      topUp({ userId: 'usr_alice', amount: credit('10.00') }),
      {
        ...topUp({ userId: 'usr_bob', amount: credit('10.00') }),
        userId: {},
      } as unknown as Operation,
    ]);
    assert.equal(good!.ok, true);
    assert.equal(bad!.ok, false);
    assert.ok(hasCode('OP.MALFORMED')((bad as { error: unknown }).error));
    assert.equal(
      encodeAmount(await eco.read.balance(spendable(COERCED))),
      'CREDIT:0.00',
    );
  });
});
