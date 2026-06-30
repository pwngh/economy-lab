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

import { balanceDelta, credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';

import type { Store } from '#src/ports.ts';
import type { AccountRef } from '#src/accounts.ts';

// Builds a fresh in-memory store for one test. Each test gets its own store so balances and
// history do not carry over between tests.
function freshStore(): Store {
  return memoryStore();
}

// Builds a predicate for assert.rejects. The predicate returns true when the thrown error's
// `code` field equals the given code.
function codeIs(code: string) {
  return (error: unknown): boolean =>
    (error as { code?: string }).code === code;
}

// --- Test cases: one behaviour each -----------------------------------------------

function signsDebitPositiveAndCreditNegative(): void {
  let amount = toAmount('CREDIT', 500n);

  assert.deepEqual(
    debit(SYSTEM.REVENUE, amount).amount,
    toAmount('CREDIT', 500n),
  );
  assert.deepEqual(
    credit(spendable('usr_a'), amount).amount,
    toAmount('CREDIT', -500n),
  );
}

function appliesNormalBalanceSign(): void {
  let amount = toAmount('CREDIT', 500n);

  // A spendable account grows on credit. Credits are stored negative (−500), but the balance
  // moves up by 500, so balanceDelta flips the stored sign back to +500.
  assert.deepEqual(
    balanceDelta(credit(spendable('usr_a'), amount)),
    toAmount('CREDIT', 500n),
  );
  // Trust-cash grows on debit. A debit is stored positive (+500), already matching its
  // balance direction, so balanceDelta leaves it +500.
  assert.deepEqual(
    balanceDelta(debit(SYSTEM.TRUST_CASH, toAmount('USD', 500n))),
    toAmount('USD', 500n),
  );
}

async function postsAndFoldsBalance(store: Store): Promise<void> {
  let amount = toAmount('CREDIT', 300n);

  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId: 'txn_ledger_balanced',
      legs: [credit(spendable('usr_a'), amount), debit(SYSTEM.REVENUE, amount)],
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
}

async function throwsUnbalanced(store: Store): Promise<void> {
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
    codeIs('LEDGER.UNBALANCED'),
  );
}

async function throwsCurrencyMismatch(store: Store): Promise<void> {
  await assert.rejects(
    store.transaction((unit) =>
      postEntry(unit.ledger, {
        // Each leg's currency must match its account's. Spendable is denominated in CREDIT,
        // so a USD amount is rejected.
        txnId: 'txn_ledger_currency',
        legs: [
          credit(spendable('usr_a'), toAmount('USD', 100n)),
          debit(SYSTEM.REVENUE, toAmount('USD', 100n)),
        ],
        meta: {},
      }),
    ),
    codeIs('LEDGER.CURRENCY_MISMATCH'),
  );
}

async function throwsUnknownAccount(store: Store): Promise<void> {
  let amount = toAmount('CREDIT', 100n);

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
    codeIs('LEDGER.UNKNOWN_ACCOUNT'),
  );
}

async function throwsOverdraftBackstop(store: Store): Promise<void> {
  let amount = toAmount('CREDIT', 100n);

  // Debiting a zero-balance user account would go negative, which the ledger refuses with
  // LEDGER.OVERDRAFT. An earlier funds check should already have rejected the short caller
  // with INSUFFICIENT_FUNDS, so hitting this backstop signals a bug; it's a separate error.
  await assert.rejects(
    store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'txn_ledger_overdraft',
        legs: [debit(earned('usr_a'), amount), credit(SYSTEM.REVENUE, amount)],
        meta: {},
      }),
    ),
    codeIs('LEDGER.OVERDRAFT'),
  );
}

describe('Ledger', () => {
  test('stores a debit as a positive amount and a credit as a negative amount', () =>
    signsDebitPositiveAndCreditNegative());
  test('moves the balance in the direction the account increases on', () =>
    appliesNormalBalanceSign());
  test('posts a balanced entry and updates the stored balance', () =>
    postsAndFoldsBalance(freshStore()));
  test('throws LEDGER.UNBALANCED when a posting does not sum to zero', () =>
    throwsUnbalanced(freshStore()));
  test('throws LEDGER.CURRENCY_MISMATCH when a line currency does not match its account', () =>
    throwsCurrencyMismatch(freshStore()));
  test('throws LEDGER.UNKNOWN_ACCOUNT for a line against an unregistered account', () =>
    throwsUnknownAccount(freshStore()));
  test('throws LEDGER.OVERDRAFT when a debit would push an account below zero', () =>
    throwsOverdraftBackstop(freshStore()));
});
