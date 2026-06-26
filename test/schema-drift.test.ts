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
 * The single-source guard for the debit-normal account set.
 *
 * `isDebitNormal` (src/accounts.ts) is the canonical answer to "which accounts grow on the debit
 * side." It signs each leg's balance delta in `balanceDelta` (src/ledger.ts), so the running total
 * that flows into `account_balances.balance` and `chain_links.balance_after` is already correctly
 * signed by the time it reaches the database. The balance-integrity trigger compares a cached
 * balance to the `balance_after` recorded at the account's head, so it no longer re-signs a legs
 * sum and no longer hand-copies the debit-normal set — the sign logic lives only in TypeScript.
 *
 * Earlier the trigger hand-copied that set into an `account_id IN (...)` CASE list to pick +SUM vs
 * -SUM, and this test asserted the copy matched `isDebitNormal`. That copy is gone (the trigger is
 * now an O(1) keyed read of `chain_links.balance_after`, computed app-side). This test now guards
 * the property that replaced it: neither schema re-introduces a hand-copied debit-normal set, so a
 * future regression that re-adds a drifting `account_id IN (...)` sign list is caught. It reads the
 * .sql files directly — no database — so it runs everywhere, including CI's no-services check job.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Account ids named in any `account_id IN (...)` list in the schema. Earlier this was the
// balance-integrity trigger's debit-normal CASE; the new trigger derives the signed balance
// app-side (balanceDelta) and stores it in chain_links.balance_after, so no such list should exist.
function accountIdInListIds(relativePath: string): string[] {
  let path = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  let sql = readFileSync(path, 'utf8');
  let ids = new Set<string>();
  for (let list of sql.matchAll(/account_id in \(([\s\S]*?)\)/gi)) {
    for (let id of list[1]!.matchAll(/'(platform:[a-z_]+)'/g)) {
      ids.add(id[1]!);
    }
  }
  return [...ids].sort();
}

describe('Schema does not hand-copy the debit-normal set', () => {
  for (let schema of ['db/postgresql-schema.sql', 'db/mysql-schema.sql']) {
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
