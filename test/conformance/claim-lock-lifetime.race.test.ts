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
 * Pins how long a claim's exclusivity lasts. `OutboxStore.claimBatch` and
 * `InboxStore.claimInbound` take row locks — `FOR UPDATE SKIP LOCKED` on both SQL engines — and a
 * row lock lives exactly as long as the transaction that took it. Both halves of that are asserted
 * here, because each is load-bearing and neither was covered:
 *
 *   - Inside a caller's transaction the lock is real. Two callers claiming at the same time are
 *     handed disjoint batches, and the rows the loser was refused are claimable again as soon as
 *     the holder's transaction ends. A refused claim can come back empty rather than reaching past
 *     the locked rows — both engines do that under contention, and `up to limit` allows it — so
 *     what is asserted is the holder's batch and the release, never the loser's size.
 *   - Outside one it is gone by the time the method returns. A claim made on the store runs in
 *     autocommit, so the lock dies with the SELECT that took it, and the next caller is handed the
 *     same rows — while the first caller is still working on them.
 *   - A locked row is skipped, never waited for. With every pending row held by another
 *     transaction the claim is handed nothing at all, and an empty claim is therefore not an empty
 *     queue. That is the third half, and it is what a caller has to be written against: the drain
 *     here retries past the empty claim and converges on the whole seeded set, and the exact set is
 *     what is asserted. A caller that reads empty as drained walks away from every row.
 *
 * The second is the shipped workers' pattern: `drainInbox` and `relayOutbox` claim on the store,
 * then submit or dispatch, then mark. So the claim never protects their work, and what makes the
 * effect happen once is the terminal mark and the idempotency key behind it, never the claim.
 * `claim-contention.race.test.ts` proves that effect under six concurrent sweeps. This file proves
 * the lock lifetime underneath it, which is what the port contract now states.
 *
 * Memory runs the released-lock half only. Its store runs one writer at a time, so a second
 * transaction cannot begin until the first has committed and two claims can never genuinely
 * overlap. A barrier that held the first transaction open until the second had claimed would wait
 * on itself.
 *
 * Postgres and MySQL run when reachable and skip, never fail, when not.
 */

import { describe, test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from '#src/adapters/memory.ts';
import { spendable } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import {
  adversarialPostgres,
  adversarialMysql,
} from '#test/conformance/adversarial-engines.ts';

import type { AdversarialEngine } from '#test/conformance/adversarial-engines.ts';
import type { Operation } from '#src/contract.ts';
import type { InboxMessage, OutboxMessage, Store, Unit } from '#src/ports.ts';

// Twice the claim limit, so a disjoint pair of claims covers the seeded set exactly and neither
// side can come back empty without failing.
const ROWS = 8;
const LIMIT = 4;

// How long the holder keeps every row locked if the drain never releases it. A store that waits on
// a locked row instead of skipping it never reaches the release, so without this the suite would
// hang instead of failing; with it the holder commits on its own, the blocked claim comes back
// full, and the empty-claim assertion is the thing that goes red.
const HOLD_CEILING_MS = 3_000;

// How long the first transaction of an overlapping pair holds while the second claims. A claim
// that skips a locked row returns in milliseconds; one that waits for it never returns at all,
// because the row it waits on belongs to the transaction waiting for it. Past this the first
// commits regardless, which releases the second and turns the deadlock into the named failure
// below rather than a suite that never ends.
const OVERLAP_CEILING_MS = 3_000;

// The drain claims LIMIT at a time out of ROWS rows, so it needs two productive rounds plus however
// many empty ones the lock produces. A store that strands the rows it withheld never converges, and
// this is what turns that into a named failure instead of a spin.
const ROUND_CEILING = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ids are unique per test, so a run against a namespace someone else seeded still asserts over its
// own rows. Every id column is VARCHAR(64) on MySQL, so the tag stays short.
let seq = 0;
function freshTag(): string {
  seq += 1;
  return `q71_${seq.toString(36)}`;
}

function inboxRow(id: string, receivedAt: number): InboxMessage {
  return {
    id,
    key: `key_${id}`,
    operation: {
      kind: 'topUp',
      idempotencyKey: `key_${id}`,
      actor: { kind: 'system', service: 'webhook:billing' },
      userId: `usr_${id}`,
      amount: toAmount('CREDIT', 1_000n),
      source: 'card',
    } as Operation,
    status: 'pending',
    attempts: 0,
    receivedAt,
    reason: null,
  };
}

function outboxRow(id: string): OutboxMessage {
  return {
    id,
    event: {
      id: `evt_${id}`,
      type: 'economy.credits.topped_up',
      version: 1,
      occurredAt: 0,
      subject: `usr_${id}`,
      data: {},
      audience: 'internal',
    },
    status: 'pending',
    attempts: 0,
    reason: null,
    correlationId: null,
  };
}

// `receivedAt` ascends with the seeded order, so the oldest LIMIT rows are the first LIMIT ids and
// a claim's contents are checkable, not just its size. Each test marks its rows terminal on the way
// out: these tests deliberately leave rows pending, and one test's leftovers are exactly what the
// next one's claim would pick up.
async function withSeededInbox(
  store: Store,
  body: (seeded: ReadonlyArray<string>) => Promise<void>,
): Promise<void> {
  const tag = freshTag();
  const seeded = Array.from({ length: ROWS }, (_u, k) => `${tag}_row${k}`);
  await store.transaction(async (unit) => {
    for (const [index, id] of seeded.entries()) {
      await unit.inbox.enqueueInbound(inboxRow(id, index));
    }
  });
  try {
    await body(seeded);
  } finally {
    for (const id of seeded) {
      await store.inbox.markApplied(id);
    }
  }
}

async function withSeededOutbox(
  store: Store,
  body: (seeded: ReadonlyArray<string>) => Promise<void>,
): Promise<void> {
  const tag = freshTag();
  const seeded = Array.from({ length: ROWS }, (_u, k) => `${tag}_row${k}`);
  await store.transaction(async (unit) => {
    for (const id of seeded) {
      await unit.outbox.enqueue(outboxRow(id));
    }
  });
  try {
    await body(seeded);
  } finally {
    await store.outbox.markRelayed(seeded);
  }
}

function idsOf(rows: ReadonlyArray<{ id: string }>): string[] {
  return rows.map((row) => row.id).sort();
}

// Whether `signal` arrives inside `ms`. The timer is cleared on the winning path so a losing race
// does not hold the run's event loop open past the assertion that read it.
function arrivesWithin(signal: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void signal.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Runs `first` and `second` as two transactions that genuinely overlap: `second` does not claim
 * until `first` holds its lock, and `first` does not commit until `second` has claimed. Both
 * claims are therefore in flight at once, which is the only arrangement under which a row lock
 * can be observed at all.
 *
 * The arrangement is a deadlock the moment a claim waits for a locked row rather than skipping it,
 * because then the second cannot claim until the first commits and the first will not commit until
 * the second has claimed. `OVERLAP_CEILING_MS` is what breaks it: the first commits anyway, which
 * releases the second, and the pair fails by name instead of holding both transactions open
 * forever. Every wait here ends — the ceiling ends the first's, and a first that throws releases
 * the second's rather than stranding it.
 */
async function claimTogether<T>(
  store: Store,
  claim: (
    unit: Parameters<Parameters<Store['transaction']>[0]>[0],
  ) => Promise<T>,
): Promise<[T, T]> {
  let firstHasClaimed = () => {};
  const claimed = new Promise<void>((resolve) => {
    firstHasClaimed = resolve;
  });
  let secondHasClaimed = () => {};
  const overlapped = new Promise<void>((resolve) => {
    secondHasClaimed = resolve;
  });

  let bothInFlight = false;
  const first = store.transaction(async (unit) => {
    const rows = await claim(unit);
    firstHasClaimed();
    bothInFlight = await arrivesWithin(overlapped, OVERLAP_CEILING_MS);
    return rows;
  });
  // The throw itself still surfaces, from the Promise.all below; this only stops a first that
  // failed before claiming from leaving the second waiting on a signal nobody will send.
  void first.catch(() => firstHasClaimed());
  const second = store.transaction(async (unit) => {
    await claimed;
    const rows = await claim(unit);
    secondHasClaimed();
    return rows;
  });
  const pair = await Promise.all([first, second]);
  assert.ok(
    bothInFlight,
    `the second claim did not return within ${OVERLAP_CEILING_MS}ms of the first's, so the two never overlapped: the claim waited for the locked row instead of skipping it`,
  );
  return pair;
}

/**
 * Locks every pending row inside one transaction, then drains the queue from the pool while that
 * transaction is still open. The drain retries past an empty claim instead of reading it as an
 * empty queue, and it releases the holder the first time it is handed nothing — so the rows the
 * empty claim withheld are exactly the rows it goes on to take, and the convergence below is a
 * statement about those rows rather than about a fresh set. Returns the ids the holder locked,
 * every round's ids in order, and the ids the drain drove terminal.
 */
async function drainPastAnEmptyClaim(input: {
  store: Store;
  engineName: string;
  rows: number;
  lockAll: (unit: Unit) => Promise<ReadonlyArray<{ id: string }>>;
  claim: (limit: number) => Promise<ReadonlyArray<{ id: string }>>;
  markTerminal: (ids: ReadonlyArray<string>) => Promise<void>;
}): Promise<{ locked: string[]; rounds: string[][]; drained: string[] }> {
  const { store, engineName, rows, claim, markTerminal } = input;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held: (ids: string[]) => void = () => {};
  const holding = new Promise<string[]>((resolve) => {
    held = resolve;
  });

  const holder = store.transaction(async (unit) => {
    const locked = await input.lockAll(unit);
    held(locked.map((row) => row.id));
    await Promise.race([released, sleep(HOLD_CEILING_MS)]);
  });
  // A holder that throws must not leave the drain waiting on a promise nobody will resolve. The
  // throw itself still surfaces, from the await in the finally below.
  void holder.catch(() => held([]));

  const locked = await holding;
  const rounds: string[][] = [];
  const drained: string[] = [];
  try {
    while (drained.length < rows) {
      assert.ok(
        rounds.length < ROUND_CEILING,
        `[${engineName}] the drain used ${ROUND_CEILING} rounds with ${
          rows - drained.length
        } rows still pending, so the claim stopped handing them back`,
      );
      const batch = await claim(LIMIT);
      rounds.push(batch.map((row) => row.id).sort());
      if (batch.length === 0) {
        release();
        await sleep(2);
        continue;
      }
      const ids = batch.map((row) => row.id);
      await markTerminal(ids);
      drained.push(...ids);
    }
  } finally {
    release();
    await holder;
  }
  return { locked, rounds, drained };
}

function runLockLifetime(
  name: string,
  provision: () => Promise<AdversarialEngine | null>,
  options: { overlappingTransactions: boolean },
): void {
  describe(`Claim lock lifetime: ${name}`, () => {
    let engine: AdversarialEngine | null = null;

    before(async () => {
      engine = await provision();
    });
    after(async () => {
      await engine?.close();
    });

    const withStore = (
      t: TestContext,
      body: (store: Store) => Promise<void>,
    ): Promise<void> | void =>
      engine ? body(engine.store) : t.skip(`${name} unreachable`);

    test('a claimInbound on the store holds nothing once it returns', (t: TestContext) =>
      withStore(t, (store) =>
        withSeededInbox(store, async (seeded) => {
          // Neither claim is inside a transaction, and nothing is marked between them: this is
          // exactly what a second worker sees while the first is still applying its batch.
          const first = await store.inbox.claimInbound({
            now: 0,
            limit: LIMIT,
          });
          const second = await store.inbox.claimInbound({
            now: 0,
            limit: LIMIT,
          });

          // Naming the expected ids, not just the count, is what stops this passing over an empty
          // claim: a store that handed back nothing would have to hand back nothing twice AND
          // match the oldest LIMIT seeded ids to get here.
          assert.deepEqual(idsOf(first), seeded.slice(0, LIMIT).sort());
          assert.deepEqual(
            idsOf(second),
            idsOf(first),
            `[${name}] the second claim was handed a different batch, so the first claim's lock outlived it`,
          );
        }),
      ));

    test('a claimBatch on the store holds nothing once it returns', (t: TestContext) =>
      withStore(t, (store) =>
        withSeededOutbox(store, async (seeded) => {
          const first = await store.outbox.claimBatch(LIMIT);
          const second = await store.outbox.claimBatch(LIMIT);

          assert.equal(first.length, LIMIT);
          assert.equal(
            idsOf(first).filter((id) => seeded.includes(id)).length,
            LIMIT,
          );
          assert.deepEqual(
            idsOf(second),
            idsOf(first),
            `[${name}] the second claim was handed a different batch, so the first claim's lock outlived it`,
          );
        }),
      ));

    if (!options.overlappingTransactions) {
      return;
    }

    test('two claimInbound calls inside overlapping transactions are disjoint', (t: TestContext) =>
      withStore(t, (store) =>
        withSeededInbox(store, async (seeded) => {
          const [first, second] = await claimTogether(store, (unit) =>
            unit.inbox.claimInbound({ now: 0, limit: LIMIT }),
          );

          // The holder's batch is named, not counted, so this cannot pass over an empty claim.
          assert.deepEqual(idsOf(first), seeded.slice(0, LIMIT).sort());
          assert.deepEqual(
            idsOf(second).filter((id) => idsOf(first).includes(id)),
            [],
            `[${name}] both transactions were handed the same rows, so the claim took no lock`,
          );
          // The rows the second claim was refused come back the moment both transactions end, so
          // they were claimable the whole time and it was the lock that withheld them.
          const afterCommit = await store.inbox.claimInbound({
            now: 0,
            limit: LIMIT,
          });
          assert.deepEqual(
            idsOf(afterCommit),
            idsOf(first),
            `[${name}] the locked rows did not come back once the claiming transaction ended`,
          );
        }),
      ));

    test('two claimBatch calls inside overlapping transactions are disjoint', (t: TestContext) =>
      withStore(t, (store) =>
        withSeededOutbox(store, async (seeded) => {
          const [first, second] = await claimTogether(store, (unit) =>
            unit.outbox.claimBatch(LIMIT),
          );

          assert.equal(first.length, LIMIT);
          assert.equal(
            idsOf(first).filter((id) => seeded.includes(id)).length,
            LIMIT,
          );
          assert.deepEqual(
            idsOf(second).filter((id) => idsOf(first).includes(id)),
            [],
            `[${name}] both transactions were handed the same rows, so the claim took no lock`,
          );
          const afterCommit = await store.outbox.claimBatch(LIMIT);
          assert.deepEqual(
            idsOf(afterCommit),
            idsOf(first),
            `[${name}] the locked rows did not come back once the claiming transaction ended`,
          );
        }),
      ));

    test('a claimInbound comes back empty while every row it wants is locked, and a drain that retries still takes them all', (t: TestContext) =>
      withStore(t, (store) =>
        withSeededInbox(store, async (seeded) => {
          // The control. The same call, with nothing contending, fills its limit — so the empty
          // return below is the lock and not what this claim does anyway.
          const uncontended = await store.inbox.claimInbound({
            now: 0,
            limit: LIMIT,
          });
          assert.deepEqual(idsOf(uncontended), seeded.slice(0, LIMIT).sort());

          const drain = await drainPastAnEmptyClaim({
            store,
            engineName: name,
            rows: ROWS,
            lockAll: (unit) => unit.inbox.claimInbound({ now: 0, limit: ROWS }),
            claim: (limit) => store.inbox.claimInbound({ now: 0, limit }),
            markTerminal: async (ids) => {
              for (const id of ids) {
                await store.inbox.markApplied(id);
              }
            },
          });

          // The holder took every seeded row, so there was nothing left for the claim to reach
          // past and the empty return below cannot be a thin table.
          assert.deepEqual(drain.locked.sort(), [...seeded].sort());
          assert.deepEqual(
            drain.rounds[0],
            [],
            `[${name}] the claim was handed ${drain.rounds[0]?.length} rows while another transaction held every one of them, so it either waited for a locked row or took no lock`,
          );
          // The retry converged on the whole seeded set, which is the reason an empty claim is
          // safe to keep going past.
          assert.deepEqual(drain.drained.sort(), [...seeded].sort());
          t.diagnostic(
            `[${name}] claimInbound: ${drain.rounds.length} rounds, ${
              drain.rounds.filter((round) => round.length === 0).length
            } of them handed nothing while ${ROWS} rows were pending`,
          );
        }),
      ));

    // The proof that the ceiling above fires. `unit.ledger.lock` takes a blocking `FOR UPDATE` on
    // Postgres, so the second transaction waits on the first's row instead of skipping past it —
    // exactly what an engine without SKIP LOCKED, or a store that leases rows, does to a claim.
    // Handed that, the arrangement cannot complete on its own: the first will not commit until the
    // second has claimed and the second cannot claim until the first commits. MySQL is excluded
    // because its `lock` is a GET_LOCK with its own 10s wait, so it cannot produce an unbounded one.
    if (name === 'postgres') {
      test('a claim that waits for the lock instead of skipping it fails the pair, and does not wedge it', (t: TestContext) =>
        withStore(t, async (store) => {
          const account = spendable(`usr_${freshTag()}`);
          const startedAt = Date.now();
          await assert.rejects(
            () => claimTogether(store, (unit) => unit.ledger.lock(account)),
            /never overlapped/,
            'a claim that blocks must fail the pair by name, not hold both transactions open',
          );
          const took = Date.now() - startedAt;
          assert.ok(
            took < OVERLAP_CEILING_MS * 3,
            `the blocked pair took ${took}ms to fail, past ${OVERLAP_CEILING_MS * 3}ms`,
          );
          t.diagnostic(`[${name}] the blocked pair failed in ${took}ms`);
        }));
    }

    test('a claimBatch comes back empty while every message it wants is locked, and a drain that retries still relays them all', (t: TestContext) =>
      withStore(t, (store) =>
        withSeededOutbox(store, async (seeded) => {
          const uncontended = await store.outbox.claimBatch(LIMIT);
          assert.equal(uncontended.length, LIMIT);
          assert.equal(
            idsOf(uncontended).filter((id) => seeded.includes(id)).length,
            LIMIT,
          );

          const drain = await drainPastAnEmptyClaim({
            store,
            engineName: name,
            rows: ROWS,
            lockAll: (unit) => unit.outbox.claimBatch(ROWS),
            claim: (limit) => store.outbox.claimBatch(limit),
            markTerminal: (ids) => store.outbox.markRelayed(ids),
          });

          assert.deepEqual(drain.locked.sort(), [...seeded].sort());
          assert.deepEqual(
            drain.rounds[0],
            [],
            `[${name}] the claim was handed ${drain.rounds[0]?.length} messages while another transaction held every one of them, so it either waited for a locked row or took no lock`,
          );
          assert.deepEqual(drain.drained.sort(), [...seeded].sort());
          t.diagnostic(
            `[${name}] claimBatch: ${drain.rounds.length} rounds, ${
              drain.rounds.filter((round) => round.length === 0).length
            } of them handed nothing while ${ROWS} messages were pending`,
          );
        }),
      ));
  });
}

// Memory is not an AdversarialEngine, but it answers the same two questions through the same
// `store` field, so it registers through one shim rather than a second copy of the suite.
runLockLifetime(
  'memory',
  async () => {
    const store = memoryStore();
    return {
      name: 'memory',
      store,
      raw: async () => [],
      close: () => store.close(),
    };
  },
  { overlappingTransactions: false },
);
runLockLifetime('postgres', () => adversarialPostgres(process.env), {
  overlappingTransactions: true,
});
runLockLifetime('mysql', () => adversarialMysql(process.env), {
  overlappingTransactions: true,
});
