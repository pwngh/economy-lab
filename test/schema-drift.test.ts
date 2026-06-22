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
 * side." The balance-integrity trigger in each engine's schema hand-copies that set into a CASE
 * list to sign the legs sum (debit-normal: +SUM, else -SUM). If the two ever drift — someone adds a
 * system account on one side only — the engine starts rejecting correct postings for the mismatched
 * account, in production, with no test to catch it. (Drivers run only when a DB is reachable; a
 * wrong sign list is silent until then.)
 *
 * This test re-derives the canonical set from the TypeScript source and asserts
 * each schema's trigger lists exactly that set. It reads the .sql files directly — no database — so
 * it runs everywhere, including CI's no-services check job.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SYSTEM, isDebitNormal } from '#src/accounts.ts';

import type { AccountRef } from '#src/accounts.ts';

// The canonical debit-normal set, derived from the one source of truth. Sorted for a stable compare.
let canonical = (Object.values(SYSTEM) as AccountRef[])
  .filter((id) => isDebitNormal(id))
  .sort();

// Every account id named in an `account_id IN (...)` list in the schema — which is exactly the
// balance-integrity trigger's debit-normal CASE (the only IN-list on account_id; everything else compares with `=`).
// MySQL repeats it across the INSERT/UPDATE triggers; a Set folds the duplicates away.
function debitNormalIdsInSchema(relativePath: string): string[] {
  let path = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  let sql = readFileSync(path, 'utf8');
  let ids = new Set<string>();
  for (let list of sql.matchAll(/account_id in \(([\s\S]*?)\)/gi)) {
    for (let id of list[1]!.matchAll(/'(vrchat:[a-z_]+)'/g)) {
      ids.add(id[1]!);
    }
  }
  return [...ids].sort();
}

describe('Schema debit-normal set tracks isDebitNormal', () => {
  for (let schema of ['db/postgresql-schema.sql', 'db/mysql-schema.sql']) {
    test(`${schema}'s balance-integrity trigger lists exactly the debit-normal accounts`, () => {
      assert.deepEqual(
        debitNormalIdsInSchema(schema),
        canonical,
        `${schema}'s balance-integrity trigger has drifted from isDebitNormal (src/accounts.ts). ` +
          `These must stay in sync or the engine signs the legs sum wrong and rejects correct ` +
          `postings. Re-sync the CASE list with the canonical set.`,
      );
    });
  }
});
