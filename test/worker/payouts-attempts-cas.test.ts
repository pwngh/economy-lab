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
 * Pins the payout attempt count against a slow sweep, on every engine.
 *
 * The sweep claims due payouts on the pool in autocommit, so two sweeps can hold the same saga at
 * once (see the claim-contention header for why that is deliberate). The absorber for a payout is
 * the `advance` compare-and-set. Each hand-off to the provider re-asserts the saga's CURRENT state
 * with `attempts + 1`, and on that same-state advance the state predicate is true for every caller
 * at once, so it discriminates nothing: without `expectAttempts`, a sweep still holding an old
 * snapshot writes its own stale `attempts + 1` over a higher count, and two sweeps both call the
 * rail for one payout.
 *
 * The count is claimed BEFORE the rail call, never after it, so a sweep parked inside the provider
 * writes no count when it returns — there is nothing for a stale snapshot to overwrite. That
 * ordering is also what keeps the money right: a thrown submit cannot say whether the transfer
 * happened, so the reserve is returned on the settlement window (`maxPayoutAgeMs`) and never on the
 * strength of a failed call. `maxPayoutAttempts` bounds how often the rail is asked, nothing more.
 *
 * The scenario is deterministic, not racy: one sweep parks inside the provider call with its
 * snapshot at 1 attempt, three later sweeps drive the row to 4, and the parked sweep is then
 * released. What must hold is that the count never falls, that the reserve is untouched throughout,
 * and that a sweep past the window still returns it.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import '#test/support/dist-guard.ts';

import { advanceDuePayouts } from '#src/worker/payouts.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { createStoreServer, httpStore } from '#src/adapters/http.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { credit, sagaAnchor, usd } from '#test/support/builders.ts';
import {
  fixedClock,
  makeWorkerCtx,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';
import {
  makeIsolatedMysqlStore,
  makeIsolatedPostgresStore,
  testMysqlUrl,
  testPostgresUrl,
} from '#test/support/adapters.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Amount } from '#src/money.ts';
import type { Config } from '#src/config.ts';
import type { EnvMap } from '#src/env.ts';
import type { CallOptions, Processor, Saga, Store, Unit } from '#src/ports.ts';

// The saga is due at 0 and the config gives every state a zero SLA, so no step pushes `dueAt` and
// every sweep re-claims the same row.
const NOW = 1_000;
const SAGA_ID = 'pay_stale_bump';
const SELLER = 'usr_seller';
// A payout at the platform's real cash-out scale: 20,000 credits quoted at 100.00 USD.
const RESERVE = credit('20000.00');
const QUOTE = usd('100.00');
// Four attempts is the hand-off that enters SUBMITTED plus three re-asks, so the parked sweep has
// somewhere to land its stale write before the rail stops being asked.
const MAX_ATTEMPTS = 4;
// Long enough that nothing times out while the count is being driven, short enough that one later
// sweep is past it. The saga enters SUBMITTED at clock 0, so this is measured from there.
const MAX_AGE_MS = 60_000;
const PAST_THE_WINDOW = 120_000;

// The matching half goes to STORED_VALUE, which may go negative and is never read here.
async function fund(
  unit: Unit,
  account: AccountRef,
  amount: Amount,
  options?: CallOptions,
): Promise<void> {
  await postEntry(
    unit.ledger,
    {
      txnId: 'txn_seed',
      legs: [creditLeg(account, amount), debit(SYSTEM.STORED_VALUE, amount)],
      meta: { kind: 'test.fund' },
    },
    options,
  );
}

function reservedSaga(): Saga {
  return {
    id: SAGA_ID,
    userId: SELLER,
    reserve: RESERVE,
    rateId: 'payout:CREDIT->USD:1',
    txnId: `txn_anchor_${SAGA_ID}`,
    state: 'RESERVED',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: QUOTE,
  };
}

// Funds the seller, then posts the reserve posting the row anchors to: every money-moving step
// re-proves the saga against it before acting.
async function openSaga(store: Store): Promise<void> {
  const row = reservedSaga();
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    await fund(unit, earned(row.userId), row.reserve);
    await unit.ledger.append(sagaAnchor(row));
  });
}

type StallGate = {
  processor: Processor;
  // Resolves once a sweep is inside the provider call, holding the snapshot it claimed.
  claimed: Promise<void>;
  release: () => void;
};

// A provider that refuses every payout with a retryable fault, and holds its FIRST caller until
// released. The held sweep has already claimed its saga, so its snapshot goes stale while the
// sweeps behind it advance the row — a slow worker, without a race to lose.
function stallGate(): StallGate {
  let announce: () => void = () => {};
  let release: () => void = () => {};
  const claimed = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  return {
    claimed,
    release: () => release(),
    processor: {
      submitPayout: async () => {
        calls += 1;
        if (calls === 1) {
          announce();
          await parked;
        }
        throw fault(ERROR_CODES.PROVIDER_FAILURE, 'provider down', {
          retryable: true,
        });
      },
    },
  };
}

async function attemptsOf(store: Store, engine: string): Promise<number> {
  const saga = await store.sagas.load(SAGA_ID);
  assert.ok(saga, `[${engine}] the saga vanished`);
  return saga.attempts;
}

// The whole scenario, one engine. Every assertion carries the engine name so a single-engine
// failure says which backend produced it.
async function staleBumpNeverLowersTheCount(
  store: Store,
  engine: string,
): Promise<void> {
  const config: Config = {
    ...testConfig(),
    maxPayoutAttempts: MAX_ATTEMPTS,
    maxPayoutAgeMs: MAX_AGE_MS,
    payoutSla: {},
  };
  const gate = stallGate();
  const ctx = makeWorkerCtx({ processor: gate.processor, config });
  await openSaga(store);

  // The slow sweep records the hand-off — RESERVED to SUBMITTED at 1 attempt — and only then
  // parks inside the provider call, holding that snapshot.
  const slow = advanceDuePayouts(store, ctx, { now: NOW, limit: 10 });
  await gate.claimed;
  assert.equal(
    await attemptsOf(store, engine),
    1,
    `[${engine}] the attempt is claimed before the rail is called, not after`,
  );

  // Three sweeps behind it, each re-claiming the same due row and re-asking the rail once.
  const climbed: number[] = [];
  for (const expected of [2, 3, 4]) {
    const run = await advanceDuePayouts(store, ctx, { now: NOW, limit: 10 });
    assert.equal(
      run.retrying.length,
      1,
      `[${engine}] the failing payout should be reported retrying`,
    );
    const attempts = await attemptsOf(store, engine);
    assert.equal(
      attempts,
      expected,
      `[${engine}] a fresh sweep must raise attempts to ${expected}`,
    );
    climbed.push(attempts);
    assert.deepEqual(
      await store.ledger.balance(earned(SELLER)),
      credit('0.00'),
      `[${engine}] the reserve moved while the hand-off outcome was still unknown`,
    );
  }
  assert.deepEqual(
    climbed,
    [2, 3, 4],
    `[${engine}] three sweeps must produce three re-asks`,
  );

  // The parked sweep returns here, holding a snapshot that says 1 attempt.
  gate.release();
  const stale = await slow;
  assert.equal(
    stale.retrying.length,
    1,
    `[${engine}] the parked sweep still reports the payout retrying`,
  );
  assert.equal(
    await attemptsOf(store, engine),
    4,
    `[${engine}] a stale sweep lowered the attempt count below its peak, so the rail can be ` +
      `re-asked past its bound`,
  );
  assert.equal(
    (await store.sagas.load(SAGA_ID))!.state,
    'SUBMITTED',
    `[${engine}] a thrown submit must not move the saga out of SUBMITTED`,
  );

  // The rail never answered, so nothing here can say whether it paid. The settlement window is
  // what ends the payout and returns the credits — not the attempt count.
  const last = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: gate.processor,
      config,
      clock: fixedClock(PAST_THE_WINDOW),
    }),
    { now: PAST_THE_WINDOW, limit: 10 },
  );
  assert.deepEqual(
    last.retrying,
    [],
    `[${engine}] the payout was re-asked past its settlement window`,
  );
  assert.equal(
    last.deadLettered.length,
    1,
    `[${engine}] the payout was never dead-lettered, so the reserve is stranded`,
  );
  assert.equal(last.deadLettered[0]!.id, SAGA_ID);
  assert.equal(last.deadLettered[0]!.reason, 'payout.timeout');
  const failed = await store.sagas.load(SAGA_ID);
  assert.equal(failed!.state, 'FAILED', `[${engine}] the saga is not FAILED`);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
    `[${engine}] the payout reserve still holds the seller's credits`,
  );
  assert.deepEqual(
    await store.ledger.balance(earned(SELLER)),
    RESERVE,
    `[${engine}] the seller never got their reserved credits back`,
  );
}

// --- The engine roster ----------------------------------------------------------------

type EngineCase = {
  name: string;
  // True when the environment names this engine, so an unreachable one is a broken rig rather
  // than an absent one and fails instead of skipping.
  configured: boolean;
  open: () => Promise<Store>;
};

function engineCases(env: EnvMap): EngineCase[] {
  const mysqlUrl = testMysqlUrl(env);
  return [
    {
      name: 'memory',
      configured: true,
      open: async () =>
        memoryStore({ digest: seededDigest(1), clock: fixedClock(0) }),
    },
    {
      // src/env.ts falls back to the compose-local URL, so Postgres is always attempted and a
      // failure to reach it is the documented skip.
      name: 'postgres',
      configured: false,
      open: () =>
        makeIsolatedPostgresStore({
          url: testPostgresUrl(env),
          digest: seededDigest(1),
          clock: fixedClock(0),
        }),
    },
    {
      name: 'mysql',
      configured: mysqlUrl !== null,
      open: () =>
        makeIsolatedMysqlStore({
          url: mysqlUrl ?? '',
          digest: seededDigest(1),
          clock: fixedClock(0),
        }),
    },
    {
      // The predicate is applied by whichever store the server holds, so it has to survive the
      // request body. This case is the wire hop.
      name: 'http',
      configured: true,
      open: async () =>
        httpStore({
          fetch: createStoreServer(
            memoryStore({ digest: seededDigest(1), clock: fixedClock(0) }),
          ),
        }),
    },
  ];
}

const cases = engineCases(process.env);
// What the roster test compares against: an engine drops out only by announcing itself.
const expected = cases.map((engine) => engine.name);
const exercised: string[] = [];

for (const engine of cases) {
  describe(`advanceDuePayouts Stale Attempt Bump: ${engine.name}`, () => {
    let store: Store | null = null;
    let refusal: unknown = null;

    before(async () => {
      try {
        store = await engine.open();
      } catch (error) {
        refusal = error;
      }
    });
    after(async () => {
      if (store) {
        await store.close();
      }
    });

    test('a stale sweep never lowers the attempt count, and the reserve comes back', async (t) => {
      if (store === null) {
        const why =
          refusal instanceof Error ? refusal.message : String(refusal);
        // A named engine that cannot be reached is a broken rig, not an absent one.
        assert.ok(
          !engine.configured,
          `[${engine.name}] the environment names this engine but it refused: ${why}`,
        );
        console.warn(`payout attempts CAS: SKIP ${engine.name} — ${why}`);
        expected.splice(expected.indexOf(engine.name), 1);
        t.skip(`${engine.name} unreachable`);
        return;
      }
      await staleBumpNeverLowersTheCount(store, engine.name);
      exercised.push(engine.name);
    });
  });
}

describe('advanceDuePayouts Stale Attempt Bump Roster', () => {
  // Registered last, so it reads the tally every engine above wrote. A test body that returned
  // early, or an engine whose suite never ran at all, shows up here as a missing name rather
  // than as a green run that proved nothing.
  test('every engine on the roster ran the scenario', () => {
    assert.deepEqual(exercised, expected);
  });
});
