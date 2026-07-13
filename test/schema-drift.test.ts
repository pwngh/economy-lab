/// <reference types="node" />
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

/**
 * Guards that the debit-normal account set has a single source of truth: `isDebitNormal`
 * (src/accounts.ts) signs each leg app-side via `balanceDelta`, and neither SQL schema may
 * re-introduce a hand-copied `account_id IN (...)` sign list that could silently drift from it.
 * Reads the .sql files directly, so it runs everywhere, including CI's no-services check job.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function accountIdInListIds(relativePath: string): string[] {
  const path = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  const sql = readFileSync(path, 'utf8');
  const ids = new Set<string>();
  for (const list of sql.matchAll(/account_id in \(([\s\S]*?)\)/gi)) {
    for (const id of list[1]!.matchAll(/'(platform:[a-z_]+)'/g)) {
      ids.add(id[1]!);
    }
  }
  return [...ids].sort();
}

describe('Schema does not hand-copy the debit-normal set', () => {
  for (const schema of ['db/postgresql-schema.sql', 'db/mysql-schema.sql']) {
    test(`${schema} has no hand-copied debit-normal account_id IN (...) list`, () => {
      assert.deepEqual(
        accountIdInListIds(schema),
        [],
        `${schema} re-introduced an account_id IN (...) list of platform accounts. The signed ` +
          `running balance is computed app-side via balanceDelta (isDebitNormal, src/accounts.ts) ` +
          `and stored in chain_links.balance_after; the schema must not hand-copy the debit-normal ` +
          `set, or it can silently drift from isDebitNormal again.`,
      );
    });
  }
});
