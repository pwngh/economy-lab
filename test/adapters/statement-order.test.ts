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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import '#test/support/dist-guard.ts';

import { memoryStore } from '#src/adapters/memory.ts';
import { createStoreServer, httpStore } from '#src/adapters/http.ts';
import { postgresStore } from '@pwngh/economy-postgres';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { storeUrls } from '#src/env.ts';
import { freshName, makeIsolatedMysqlStore } from '#test/support/adapters.ts';
import { seededDigest } from '#test/support/capabilities.ts';

import type { EnvMap } from '#src/env.ts';
import type { Clock, Store } from '#src/ports.ts';

// The clock every engine under test shares, stepped by the workload below.
let now = 0;
const clock: Clock = { now: () => now };

// `postings.posted_at` is a bare BIGINT filled from the injected Clock, and nothing constrains it
// to rise: a stepped-back wall clock writes these four in this order. The permutation is chosen so
// that sorting by posted_at is neither commit order nor its reverse, which tells a fix that holds
// commit order apart from one that merely flipped a direction.
const POSTED_AT = [3000, 1000, 4000, 2000] as const;

// The split posting lands between them in posted_at and last in commit order.
const SPLIT_AT = 2500;

// Commit order, minor units: the four single-leg postings, then the split posting's three legs in
// the order the caller wrote them. Written out rather than derived, so the expectation cannot
// drift with the code that produces it.
const COMMIT_ORDER = '1000,2000,3000,4000,101,102,103';

type EngineCase = { name: string; make: () => Promise<Store> };

/**
 * One case per engine the environment names. An unnamed backend is absent from the roster
 * entirely; a named one that will not open fails the run, because a store the environment points
 * at and the run cannot reach is a provisioning failure, not a reason to compare fewer engines.
 */
function engineRoster(env: EnvMap): EngineCase[] {
  const urls = storeUrls(env);
  const cases: EngineCase[] = [
    {
      name: 'memory',
      make: async () => memoryStore({ digest: seededDigest(1), clock }),
    },
    {
      name: 'http',
      make: async () =>
        httpStore({
          fetch: createStoreServer(
            memoryStore({ digest: seededDigest(1), clock }),
          ),
        }),
    },
  ];
  const postgres = urls.postgres;
  if (postgres !== null) {
    cases.push({
      name: 'postgres',
      make: () =>
        postgresStore({
          url: postgres,
          schemaName: freshName('el_ord'),
          digest: seededDigest(1),
          clock,
        }),
    });
  }
  const mysql = urls.mysql;
  if (mysql !== null) {
    cases.push({
      name: 'mysql',
      make: () =>
        makeIsolatedMysqlStore({
          url: mysql,
          digest: seededDigest(1),
          clock,
        }),
    });
  }
  return cases;
}

// Posts the workload against one store and returns its statement as a comma-joined list of minor
// units, which is the entry order.
async function statementOrderOf(store: Store, user: string): Promise<string> {
  const account = spendable(user);
  for (const [index, at] of POSTED_AT.entries()) {
    now = at;
    const amount = decodeAmount(`${(index + 1) * 10}.00`, 'CREDIT');
    await store.transaction(async (unit) => {
      await postEntry(unit.ledger, {
        txnId: `txn_ord_${user}_${index}`,
        legs: [credit(account, amount), debit(SYSTEM.REVENUE, amount)],
        meta: {},
      });
    });
  }

  // One posting, three legs to the same account: the `legs` table is built for it (the hash-chain
  // link is per account, not per leg), so a statement has to order legs inside a posting too.
  now = SPLIT_AT;
  const shares = ['1.01', '1.02', '1.03'].map((share) =>
    decodeAmount(share, 'CREDIT'),
  );
  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, {
      txnId: `txn_ord_${user}_split`,
      legs: shares.flatMap((amount) => [
        credit(account, amount),
        debit(SYSTEM.REVENUE, amount),
      ]),
      meta: {},
    });
  });

  const statement = await store.ledger.statement(account, {
    from: 0,
    to: 10_000,
  });
  return statement.entries.map((entry) => entry.amount.minor).join(',');
}

describe('Statement entry order across engines', () => {
  test('every engine returns one posting run in commit order', async () => {
    const roster = engineRoster(process.env);
    const orderings = new Map<string, string>();
    for (const engine of roster) {
      const store = await engine.make();
      try {
        orderings.set(
          engine.name,
          await statementOrderOf(store, `usr_ord_${engine.name}`),
        );
      } finally {
        await store.close();
      }
    }

    // Resolve the roster by name. A count would pass on a run that reached one engine and
    // compared it against itself.
    assert.deepEqual(
      [...orderings.keys()],
      roster.map((engine) => engine.name),
    );

    // Each ordering is checked against the written-out commit order, not against a peer: engines
    // that agree on the wrong order agree.
    let compared = 0;
    for (const [name, ordering] of orderings) {
      assert.equal(ordering, COMMIT_ORDER, `${name} statement entry order`);
      compared += 1;
    }
    assert.equal(compared, orderings.size);
  });
});
