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
 * What Postgres aborts that a retry can fix, on both table layouts. Two races live here. Writers
 * meeting on a brand-new account collide planting the account row (Q45), and writers appending
 * without a lock collide on the chain head all of them read (Q44). Each is an abort that committed
 * nothing, so `isTransientConflict` has to say so for `withTransientRetry` to re-run it; each was
 * measured escaping unretried instead. The partitioned layout runs alongside the standard one
 * because the fork escaped only there.
 */

import assert from 'node:assert/strict';

import '#test/support/dist-guard.ts';

import { postgresStore } from '@pwngh/economy-postgres';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { byCodeUnit } from '#src/bytes.ts';
import { setRetryObserver } from '@pwngh/economy-lab/sql-kit';
import { freshName } from '#test/support/adapters.ts';
import {
  describeEngine,
  pinEngineGateRoster,
} from '#test/support/engine-gate.ts';

import type { RetryEvent } from '@pwngh/economy-lab/sql-kit';
import type { Store, Unit } from '#src/ports.ts';
import type { AccountRef } from '#src/accounts.ts';

// The findings measured escapes at 3 of 12 and 7 of 12 on the plant race and 23 of 36 on the fork,
// so a dozen rounds is the size that separates "fixed" from "got lucky".
const ROUNDS = 12;
const LAYOUTS = ['standard', 'partitioned'] as const;

let seq = 0;
function freshUser(): string {
  seq += 1;
  return `usr_tc_${process.pid}_${seq}`;
}

const AMOUNT = decodeAmount('1.00', 'CREDIT');

function post(
  unit: Unit,
  txnId: string,
  account: AccountRef,
): Promise<unknown> {
  return postEntry(unit.ledger, {
    txnId,
    legs: [credit(account, AMOUNT), debit(SYSTEM.REVENUE, AMOUNT)],
    meta: { source: 'card' },
  });
}

interface RaceResult {
  escaped: string[];
  retried: number;
  recovered: number;
}

// Runs `round` ROUNDS times with a retry observer attached, collecting what escaped instead of
// throwing on the first one, so the count is the headline rather than whichever round lost first.
async function race(
  rounds: number,
  round: (index: number) => Promise<PromiseSettledResult<unknown>[]>,
): Promise<RaceResult> {
  const escaped: string[] = [];
  const events: RetryEvent[] = [];
  const previous = setRetryObserver((event) => events.push(event));
  try {
    for (let index = 0; index < rounds; index += 1) {
      for (const outcome of await round(index)) {
        if (outcome.status === 'rejected') {
          const reason = outcome.reason as {
            code?: string;
            constraint?: string;
          };
          escaped.push(
            `${reason?.code ?? ''} ${reason?.constraint ?? String(outcome.reason)}`,
          );
        }
      }
    }
  } finally {
    setRetryObserver(previous);
  }
  return {
    escaped,
    retried: events.filter((event) => event.type === 'retry').length,
    recovered: events.filter((event) => event.type === 'recovered').length,
  };
}

function open(
  url: string,
  layout: (typeof LAYOUTS)[number],
  tag: string,
): Promise<Store> {
  return postgresStore({
    url,
    schemaName: freshName(`el_${tag}_${layout.slice(0, 4)}`),
    layout,
  });
}

// Q45. Two writers meet on an account that does not exist yet. `lockMany` locks nothing — there is
// no balance row to lock — so both plant it, and the loser used to escape on
// `accounts_id_currency_key`, which no transient class named. Measured before the fix: 2 of 24 on
// the standard layout and 3 of 24 on the partitioned one.
describeEngine('postgres', 'the first-use account plant', (rig) => {
  for (const layout of LAYOUTS) {
    rig.test(
      `${layout} layout: both first-use writers commit, none escapes`,
      async (url) => {
        const store = await open(url, layout, 'plant');
        try {
          const { escaped } = await race(ROUNDS, async () => {
            const account = spendable(freshUser());
            const locked = [account, SYSTEM.REVENUE].sort(byCodeUnit);
            return Promise.allSettled(
              [0, 1].map((writer) =>
                store.transaction(async (unit) => {
                  await unit.ledger.lockMany!(locked);
                  await post(unit, `txn_plant_${account}_${writer}`, account);
                }),
              ),
            );
          });
          assert.equal(
            escaped.length,
            0,
            `${escaped.length} of ${ROUNDS * 2} first-use writers escaped: ${escaped[0] ?? ''}`,
          );
        } finally {
          await store.close();
        }
      },
    );
  }
});

// Q44. Three writers append to a warm account without locking, so all three read the same chain
// head and two of them fork it. The standard layout retried and recovered; the partitioned layout
// reported the violation against a per-partition child index, matched nothing, and escaped 23 of
// 36 times with zero retries.
describeEngine('postgres', 'the stale-head chain fork', (rig) => {
  for (const layout of LAYOUTS) {
    rig.test(
      `${layout} layout: forked appends retry and settle`,
      async (url) => {
        const store = await open(url, layout, 'fork');
        try {
          const { escaped, recovered, retried } = await race(
            ROUNDS,
            async () => {
              const account = spendable(freshUser());
              // Warm the account, so the head the racers read is a real hash and the fork index is
              // what catches them. On an empty chain the continuity trigger fires first instead.
              await store.transaction((unit) =>
                post(unit, `txn_seed_${account}`, account),
              );
              return Promise.allSettled(
                [0, 1, 2].map((writer) =>
                  store.transaction((unit) =>
                    post(unit, `txn_fork_${account}_${writer}`, account),
                  ),
                ),
              );
            },
          );
          assert.equal(
            escaped.length,
            0,
            `${escaped.length} of ${ROUNDS * 3} forked appends escaped: ${escaped[0] ?? ''}`,
          );
          // The liveness half. Zero recoveries means no writer ever forked, and then the assertion
          // above passed while proving nothing about the classifier.
          assert.ok(
            recovered > 0,
            `no append ever forked (${retried} retries, ${recovered} recoveries), so this asserted nothing`,
          );
        } finally {
          await store.close();
        }
      },
    );
  }
});

// The control on both of the above: widening a transient class must not make a genuine duplicate
// retry. A repeated txnId is a real duplicate, not a race, and must fail on the first throw.
describeEngine('postgres', 'a genuine duplicate still fails fast', (rig) => {
  for (const layout of LAYOUTS) {
    rig.test(
      `${layout} layout: a repeated txnId raises once, unretried`,
      async (url) => {
        const store = await open(url, layout, 'dup');
        const account = spendable(freshUser());
        const txnId = `txn_dup_${account}`;
        const write = (): Promise<unknown> =>
          store.transaction(async (unit) => {
            await unit.ledger.lockMany!(
              [account, SYSTEM.REVENUE].sort(byCodeUnit),
            );
            return post(unit, txnId, account);
          });

        const events: RetryEvent[] = [];
        const previous = setRetryObserver((event) => events.push(event));
        try {
          await write();
          await assert.rejects(write());
        } finally {
          setRetryObserver(previous);
          await store.close();
        }

        assert.deepEqual(
          events,
          [],
          `a duplicate txnId produced ${events.length} retry events; it must fail on the first throw`,
        );
      },
    );
  }
});

// Two layouts per race, and every one of them registers. The conditional that used to stand here
// tested a URL helper that never returns null, so it could not be false; what it hid was that these
// races had no connect-or-skip at all, and a machine with no Postgres got six failures.
pinEngineGateRoster([
  'the first-use account plant › standard layout: both first-use writers commit, none escapes',
  'the first-use account plant › partitioned layout: both first-use writers commit, none escapes',
  'the stale-head chain fork › standard layout: forked appends retry and settle',
  'the stale-head chain fork › partitioned layout: forked appends retry and settle',
  'a genuine duplicate still fails fast › standard layout: a repeated txnId raises once, unretried',
  'a genuine duplicate still fails fast › partitioned layout: a repeated txnId raises once, unretried',
]);
