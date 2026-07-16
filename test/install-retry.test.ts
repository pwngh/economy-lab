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

import { installMoneyRetrying } from '#src/engines/sql-shared.ts';

describe('installMoneyRetrying', () => {
  test('retries a lost concurrent-install race until the install lands', async () => {
    let calls = 0;
    await installMoneyRetrying(async () => {
      calls += 1;
      if (calls === 1) throw new Error('tuple concurrently updated');
      if (calls === 2) {
        throw new Error(
          'duplicate key value violates unique constraint "pg_proc_proname_args_nsp_index"',
        );
      }
      if (calls === 3) {
        throw new Error('FUNCTION money_div_round already exists');
      }
    });
    assert.equal(calls, 4);
  });

  test('propagates a non-transient failure on the first throw', async () => {
    let calls = 0;
    await assert.rejects(
      installMoneyRetrying(async () => {
        calls += 1;
        throw new Error('syntax error at or near "create"');
      }),
      /syntax error/,
    );
    assert.equal(calls, 1);
  });

  test('gives up after five lost races rather than spinning forever', async () => {
    let calls = 0;
    await assert.rejects(
      installMoneyRetrying(async () => {
        calls += 1;
        throw new Error('tuple concurrently updated');
      }),
      /tuple concurrently updated/,
    );
    assert.equal(calls, 5);
  });
});
