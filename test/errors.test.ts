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

import {
  ERROR_CODES,
  EconomyError,
  fault,
  normalizeError,
} from '#src/errors.ts';

describe('Error Codes', () => {
  test('defines the chain-broken fault code', () => {
    assert.equal(ERROR_CODES.CHAIN_BROKEN, 'CHAIN.BROKEN');
  });

  test('defines the commingling fault code', () => {
    assert.equal(ERROR_CODES.COMMINGLING, 'LEDGER.COMMINGLING');
  });

  test('builds a throwable fault carrying the chain-broken code', () => {
    const error = fault(ERROR_CODES.CHAIN_BROKEN, 'chain tampered', {
      detail: { firstBreak: 'pst_2' },
    });

    assert.ok(error instanceof EconomyError);
    assert.equal(error.code, 'CHAIN.BROKEN');
    assert.equal(error.retryable, false);
    assert.deepEqual(error.detail, { firstBreak: 'pst_2' });
  });

  test('builds a throwable fault carrying the commingling code', () => {
    const error = fault(ERROR_CODES.COMMINGLING, 'custodial funds mixed');

    assert.ok(error instanceof EconomyError);
    assert.equal(error.code, 'LEDGER.COMMINGLING');
    assert.equal(error.retryable, false);
  });
});

describe('normalizeError', () => {
  test('returns an existing EconomyError untouched', () => {
    // An EconomyError already carries a specific code, so it passes through unchanged. Re-wrapping
    // would overwrite that code with a generic one. It could also flip a "do not retry" failure into
    // a "safe to retry" one.
    const original = fault(ERROR_CODES.OVERDRAFT, 'balance went negative', {
      cause: new Error('inner'),
      retryable: false,
      detail: { account: 'usr_a:spendable' },
    });

    const normalized = normalizeError(original);

    assert.equal(normalized, original);
    assert.equal(normalized.code, ERROR_CODES.OVERDRAFT);
    assert.equal(normalized.retryable, false);
    assert.deepEqual(normalized.detail, { account: 'usr_a:spendable' });
    assert.equal(normalized.cause, original.cause);
  });

  test('does not re-wrap or flip a retryable EconomyError', () => {
    const original = fault(ERROR_CODES.PROVIDER_FAILURE, 'provider timed out', {
      retryable: true,
    });

    const normalized = normalizeError(original);

    assert.equal(normalized, original);
    assert.equal(normalized.code, ERROR_CODES.PROVIDER_FAILURE);
    assert.equal(normalized.retryable, true);
  });

  test('wraps a non-EconomyError as a storage failure, keeping the original as cause', () => {
    const raw = new TypeError('something blew up');

    const normalized = normalizeError(raw);

    assert.ok(normalized instanceof EconomyError);
    assert.equal(normalized.code, ERROR_CODES.STORE_FAILURE);
    assert.equal(normalized.cause, raw);
    // The raw message and stack stay internal; only a generic message is exposed.
    assert.notEqual(normalized.message, raw.message);
  });

  test('wraps a non-Error throw as a storage failure too', () => {
    const normalized = normalizeError('a bare string');

    assert.ok(normalized instanceof EconomyError);
    assert.equal(normalized.code, ERROR_CODES.STORE_FAILURE);
    assert.equal(normalized.cause, 'a bare string');
  });
});
