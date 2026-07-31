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
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installSecondCopy } from '#test/support/second-copy.ts';
import {
  ERROR_CODES,
  EconomyError,
  fault,
  normalizeError,
  normalizePortError,
  statusForError,
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

  test('publishes exactly this roster of fault codes', () => {
    // ERROR_CODES is a published surface a caller matches on, and the client rebuilds a wire
    // failure by testing membership of it. The pin is the whole table, name and string, so a code
    // cannot be added, renamed or dropped without this line being edited to say so.
    assert.deepEqual(Object.entries(ERROR_CODES), [
      ['MALFORMED_OPERATION', 'OP.MALFORMED'],
      ['INVALID_AMOUNT', 'MONEY.INVALID_AMOUNT'],
      ['AMOUNT_OVERFLOW', 'MONEY.OVERFLOW'],
      ['LEDGER_UNBALANCED', 'LEDGER.UNBALANCED'],
      ['UNKNOWN_ACCOUNT', 'LEDGER.UNKNOWN_ACCOUNT'],
      ['CURRENCY_MISMATCH', 'LEDGER.CURRENCY_MISMATCH'],
      ['OVERDRAFT', 'LEDGER.OVERDRAFT'],
      ['COMMINGLING', 'LEDGER.COMMINGLING'],
      ['INVALID_TRANSITION', 'SAGA.INVALID_TRANSITION'],
      ['SESSION_SETTLED', 'SESSION.SETTLED'],
      ['SESSION_MISROUTED', 'SESSION.MISROUTED'],
      ['UNAUTHORIZED', 'AUTH.UNAUTHORIZED'],
      ['INVALID_SIGNATURE', 'AUTH.INVALID_SIGNATURE'],
      ['STORE_FAILURE', 'STORE.FAILURE'],
      ['UNKNOWN_ROUTE', 'STORE.UNKNOWN_ROUTE'],
      ['UNKNOWN_SESSION', 'STORE.UNKNOWN_SESSION'],
      ['PROVIDER_FAILURE', 'PROVIDER.FAILURE'],
      ['CONFIG_INVALID', 'CONFIG.INVALID'],
      ['CHAIN_BROKEN', 'CHAIN.BROKEN'],
    ]);
    assert.equal(Object.keys(ERROR_CODES).length, 19);
  });

  test('builds the two routing faults as permanent, never retryable', () => {
    // The pair the store protocol raises. Both are deterministic: the route map is fixed at build
    // time and a transaction the server is not holding never comes back, so a caller that retries
    // on `retryable` would retry forever.
    for (const code of [
      ERROR_CODES.UNKNOWN_ROUTE,
      ERROR_CODES.UNKNOWN_SESSION,
    ]) {
      const error = fault(code, 'names what failed');
      assert.equal(error.retryable, false);
      assert.equal(statusForError(error), 400);
    }
  });
});

describe('normalizeError', () => {
  test('returns an existing EconomyError untouched', () => {
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
    // Deliberate, and the reason the routing faults are typed at their throw sites instead of
    // being left to this function: an unclassified throw out of a driver is usually transient,
    // and the workers below read this flag to decide between a retry and a dead-letter.
    assert.equal(normalized.retryable, true);
  });

  test('wraps a non-Error throw as a storage failure too', () => {
    const normalized = normalizeError('a bare string');

    assert.ok(normalized instanceof EconomyError);
    assert.equal(normalized.code, ERROR_CODES.STORE_FAILURE);
    assert.equal(normalized.cause, 'a bare string');
  });
});

describe('normalizePortError', () => {
  // Each classified throw below is built the way @pwngh/economy-edge builds a Fault — extra
  // properties assigned onto a plain Error — without importing the edge. The shape, not the
  // class, is the contract: any provider SDK stating a string `code` beside a boolean
  // `retryable` has ruled on its own failure.

  test('keeps the verdict of a throw that classified itself non-retryable', () => {
    const raw = Object.assign(new Error('bad credentials'), {
      code: 'TILIA.AUTH_REJECTED',
      retryable: false,
      detail: {},
    });

    const normalized = normalizePortError(raw);

    assert.ok(normalized instanceof EconomyError);
    assert.equal(normalized.code, ERROR_CODES.PROVIDER_FAILURE);
    // The provider ruled this permanent. Wrapping it retryable would re-drive a call that can
    // never succeed until an attempt cap or age-out gave up for the wrong reason.
    assert.equal(normalized.retryable, false);
    assert.equal(normalized.cause, raw);
  });

  test('keeps the verdict of a throw that classified itself retryable', () => {
    const raw = Object.assign(new Error('slow down'), {
      code: 'TILIA.RATE_LIMITED',
      retryable: true,
      detail: {},
    });

    const normalized = normalizePortError(raw);

    assert.equal(normalized.code, ERROR_CODES.PROVIDER_FAILURE);
    assert.equal(normalized.retryable, true);
  });

  test('wraps a throw carrying no verdict as retryable, keeping the original as cause', () => {
    const raw = new Error('connection reset mid-call');

    const normalized = normalizePortError(raw);

    assert.ok(normalized instanceof EconomyError);
    assert.equal(normalized.code, ERROR_CODES.PROVIDER_FAILURE);
    // Unchanged from before verdicts were read: an unclassified throw out of a port is usually
    // transient, and the workers bound it with their attempt caps.
    assert.equal(normalized.retryable, true);
    assert.equal(normalized.cause, raw);
  });

  test('a verdict is the pair: a bare flag, a bare code, or a non-boolean flag is no signal', () => {
    // A `retryable` with no code names no failure; a code with no `retryable` states no verdict;
    // a non-boolean `retryable` is some other library's field. All three take the transient
    // default rather than being trusted as a classification.
    const flagOnly = Object.assign(new Error('x'), { retryable: false });
    const codeOnly = Object.assign(new Error('x'), {
      code: 'TILIA.AUTH_REJECTED',
    });
    const stringFlag = Object.assign(new Error('x'), {
      code: 'TILIA.AUTH_REJECTED',
      retryable: 'no',
    });

    for (const raw of [flagOnly, codeOnly, stringFlag]) {
      assert.equal(normalizePortError(raw).retryable, true);
    }
  });

  test('returns an existing EconomyError untouched, never re-reading its verdict', () => {
    const original = fault(ERROR_CODES.PROVIDER_FAILURE, 'provider timed out', {
      retryable: true,
    });

    assert.equal(normalizePortError(original), original);
    assert.equal(normalizePortError(original).retryable, true);
  });
});

const SOURCE = fileURLToPath(new URL('../src/errors.ts', import.meta.url));

describe('EconomyError.is across two copies of the module', () => {
  test('matches a branded error thrown by a second resolved copy', async () => {
    const copy = installSecondCopy({
      packageName: '@pwngh/economy-lab',
      sourcePath: SOURCE,
    });
    try {
      // The fixture is the real module, not a stand-in: it is compiled from src/errors.ts, and
      // it exports the same names this file's copy does.
      assert.equal(
        copy.sha,
        createHash('sha256').update(readFileSync(SOURCE, 'utf8')).digest('hex'),
      );
      const second = (await import(
        pathToFileURL(copy.consumer).href
      )) as typeof import('#src/errors.ts');
      const ours = await import('#src/errors.ts');
      assert.deepEqual(
        Object.keys(second).sort(),
        Object.keys(ours).sort(),
        'the second copy must export the whole module',
      );

      // Two class objects, or the rest of this test proves nothing.
      assert.notEqual(second.EconomyError, EconomyError);
      assert.equal(second.ERROR_CODES.CHAIN_BROKEN, ERROR_CODES.CHAIN_BROKEN);

      const theirs = second.fault(
        second.ERROR_CODES.CHAIN_BROKEN,
        'thrown by the other copy',
      );
      const mine = fault(ERROR_CODES.CHAIN_BROKEN, 'thrown by this copy');

      // The defect: the prototype chain does not cross the copy boundary.
      assert.equal(theirs instanceof EconomyError, false);
      assert.equal(mine instanceof second.EconomyError, false);

      // The brand does, in both directions.
      assert.equal(EconomyError.is(theirs), true);
      assert.equal(second.EconomyError.is(mine), true);
      assert.equal(EconomyError.is(mine), true);
      assert.equal(theirs.retryable, false);
      assert.equal(theirs.code, ERROR_CODES.CHAIN_BROKEN);
    } finally {
      rmSync(copy.dir, { recursive: true, force: true });
    }
  });

  test('normalizeError returns a second copy’s error untouched', async () => {
    const copy = installSecondCopy({
      packageName: '@pwngh/economy-lab',
      sourcePath: SOURCE,
    });
    try {
      const second = (await import(
        pathToFileURL(copy.consumer).href
      )) as typeof import('#src/errors.ts');
      const theirs = second.fault(
        second.ERROR_CODES.PROVIDER_FAILURE,
        'provider timed out',
        { retryable: true },
      );

      const normalized = normalizeError(theirs);

      // Re-wrapping would bury the code and flip retryable to true for the wrong reason.
      assert.equal(normalized, theirs);
      assert.equal(normalized.code, ERROR_CODES.PROVIDER_FAILURE);
      assert.equal(normalized.retryable, true);
    } finally {
      rmSync(copy.dir, { recursive: true, force: true });
    }
  });

  test('rejects non-errors and plain objects', () => {
    assert.equal(EconomyError.is(new Error('plain')), false);
    assert.equal(EconomyError.is({ code: 'CHAIN.BROKEN' }), false);
    assert.equal(EconomyError.is(null), false);
    assert.equal(EconomyError.is(undefined), false);
    assert.equal(EconomyError.is('CHAIN.BROKEN'), false);
  });
});
