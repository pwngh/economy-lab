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
import { hasCode } from '#test/support/capabilities.ts';

import { balanceDelta, credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';

import type { Store } from '#src/ports.ts';
import type { AccountRef } from '#src/accounts.ts';

function freshStore(): Store {
  return memoryStore();
}

describe('Ledger', () => {
  test('stores a debit as a positive amount and a credit as a negative amount', () => {
    const amount = toAmount('CREDIT', 500n);

    assert.deepEqual(
      debit(SYSTEM.REVENUE, amount).amount,
      toAmount('CREDIT', 500n),
    );
    assert.deepEqual(
      credit(spendable('usr_a'), amount).amount,
      toAmount('CREDIT', -500n),
    );
  });

  test('moves the balance in the direction the account increases on', () => {
    const amount = toAmount('CREDIT', 500n);

    assert.deepEqual(
      balanceDelta(credit(spendable('usr_a'), amount)),
      toAmount('CREDIT', 500n),
    );
    assert.deepEqual(
      balanceDelta(debit(SYSTEM.TRUST_CASH, toAmount('USD', 500n))),
      toAmount('USD', 500n),
    );
  });

  test('posts a balanced entry and updates the stored balance', async () => {
    const store = freshStore();
    const amount = toAmount('CREDIT', 300n);

    await store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'txn_ledger_balanced',
        legs: [
          credit(spendable('usr_a'), amount),
          debit(SYSTEM.REVENUE, amount),
        ],
        meta: { kind: 'test' },
      }),
    );

    assert.deepEqual(
      await store.ledger.balance(spendable('usr_a')),
      toAmount('CREDIT', 300n),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      toAmount('CREDIT', -300n),
    );
  });

  test('throws LEDGER.UNBALANCED when a posting does not sum to zero', async () => {
    const store = freshStore();
    await assert.rejects(
      store.transaction((unit) =>
        postEntry(unit.ledger, {
          txnId: 'txn_ledger_unbalanced',
          legs: [
            credit(spendable('usr_a'), toAmount('CREDIT', 300n)),
            debit(SYSTEM.REVENUE, toAmount('CREDIT', 200n)),
          ],
          meta: {},
        }),
      ),
      hasCode('LEDGER.UNBALANCED'),
    );
  });

  test('throws LEDGER.CURRENCY_MISMATCH when a line currency does not match its account', async () => {
    const store = freshStore();
    await assert.rejects(
      store.transaction((unit) =>
        postEntry(unit.ledger, {
          txnId: 'txn_ledger_currency',
          legs: [
            credit(spendable('usr_a'), toAmount('USD', 100n)),
            debit(SYSTEM.REVENUE, toAmount('USD', 100n)),
          ],
          meta: {},
        }),
      ),
      hasCode('LEDGER.CURRENCY_MISMATCH'),
    );
  });

  test('throws LEDGER.UNKNOWN_ACCOUNT for a line against an unregistered account', async () => {
    const store = freshStore();
    const amount = toAmount('CREDIT', 100n);

    await assert.rejects(
      store.transaction((unit) =>
        postEntry(unit.ledger, {
          txnId: 'txn_ledger_unknown',
          legs: [
            credit('usr_a:bogus' as AccountRef, amount),
            debit(SYSTEM.REVENUE, amount),
          ],
          meta: {},
        }),
      ),
      hasCode('LEDGER.UNKNOWN_ACCOUNT'),
    );
  });

  test('throws LEDGER.OVERDRAFT when a debit would push an account below zero', async () => {
    const store = freshStore();
    const amount = toAmount('CREDIT', 100n);

    // The funds check should already have rejected a short caller with INSUFFICIENT_FUNDS, so
    // hitting this backstop signals a bug — hence the separate code.
    await assert.rejects(
      store.transaction((unit) =>
        postEntry(unit.ledger, {
          txnId: 'txn_ledger_overdraft',
          legs: [
            debit(earned('usr_a'), amount),
            credit(SYSTEM.REVENUE, amount),
          ],
          meta: {},
        }),
      ),
      hasCode('LEDGER.OVERDRAFT'),
    );
  });
});
