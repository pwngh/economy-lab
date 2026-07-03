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
 * Settle-vs-reverse race. This is the gap the per-operation suites never cover. settlePayout moves a
 * saga from SUBMITTED to SETTLED. reversePayout moves a reversible payout to FAILED and returns the
 * reserve to the seller. Both move one saga out of SUBMITTED, but each moves money in an opposite,
 * irreversible direction. Settle empties the reserve into REVENUE and moves USD out of trust, so the
 * seller is paid. Reverse returns the reserve to the seller's earned account, so the payout is
 * undone. settlePayout.test.ts pins settle-vs-settle CAS and the single-actor SETTLED refusal.
 * reversePayout.test.ts pins the SETTLED and live-SUBMITTED refusals. Neither suite fires settle and
 * reverse concurrently on the same SUBMITTED saga.
 *
 * A correct engine must let exactly one win and refuse the other, and money must move exactly once.
 * Either the seller is paid (settle) or the reserve is returned (reverse), never both, never
 * neither. The two ops share the PAYOUT_RESERVE lock (see accountsOf), so economy.submit serializes
 * them on that account. Whoever takes the lock first transitions the saga. The loser then loads a
 * no-longer-SUBMITTED saga and is refused at its state guard (settle's refuseNotSubmitted or
 * reverse's refuseSettled), throwing SAGA.INVALID_TRANSITION before it can post a second move. The
 * winner commits. The loser's submit() promise rejects with that fault and rolls back its postings.
 *
 * Coverage comes at two levels, because true overlapping transactions only exist on a real engine:
 *
 *  - SQL engines (Postgres and MySQL, when reachable) run the genuine concurrent race. settle and
 *    reverse are fired together via Promise.all and truly interleave on the engine's row/account
 *    locks. This is the same harness concurrency.adversarial uses. Memory is deliberately excluded
 *    there because the in-memory store has a single journal and forbids overlapping transactions
 *    ("in-memory transactions do not nest"). 50 iterations, both firing orders each iteration.
 *
 *  - Memory runs a deterministic interleaving instead, mirroring settlePayout.test.ts's
 *    `raceSettleOnce`. It pre-empts the saga into the winner's terminal state by committing the
 *    winner's money first, then runs the loser and asserts the loser is refused with the real
 *    SAGA.INVALID_TRANSITION and posts nothing. This pins the loser-refusal and money-moves-once
 *    contract on memory without needing the nested transactions memory can't provide. 50 iterations,
 *    both winners (settle-wins, reverse-wins) each iteration.
 *
 * Every iteration on every backend asserts the same contract. Exactly one outcome commits. The loser
 * is rejected with SAGA.INVALID_TRANSITION. The reserve moved exactly once in the winner's direction
 * (settle yields REVENUE plus USD left trust plus SETTLED; reverse yields seller earned plus FAILED).
 * And prove() still holds (conserved, no overdraft, chain intact, cache consistent). No double-pay,
 * no lost or minted money.
 *
 * An unreachable SQL engine skips, never fails. This is the same connect-or-skip contract the other
 * conformance suites use.
 */

import { describe, test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import {
  credit,
  usd,
  settlePayout as buildSettlePayout,
} from '#test/support/builders.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import {
  fixedClock,
  seededDigest,
  testConfig,
  sequentialIds,
  seededSigner,
  fakeProcessor,
  fixedRates,
  testLogger,
  noopMeter,
} from '#test/support/capabilities.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  adversarialPostgres,
  adversarialMysql,
} from '#test/conformance/adversarial-engines.ts';
import { settleDuePayouts } from '#src/worker/payouts.ts';

import type { AdversarialEngine } from '#test/conformance/adversarial-engines.ts';
import type { SettleSummary } from '#src/worker/payouts.ts';
import type { Economy, Operation, Outcome, WorkerCtx } from '#src/contract.ts';
import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Saga, Store } from '#src/ports.ts';

// builders.ts has no reversePayout factory, only settlePayout, so build one here. It matches the
// operator-actor reverse that reversePayout.test.ts drives.
function reversePayoutOp(sagaId: string, userId: string): Operation {
  return {
    kind: 'reversePayout',
    idempotencyKey: `idem_rev_${sagaId}`,
    actor: { kind: 'operator', operatorId: 'op_race' },
    userId,
    sagaId,
    reason: 'race reverse',
  };
}
function settlePayoutOp(sagaId: string): Operation {
  return buildSettlePayout({
    sagaId,
    actor: { kind: 'system', service: 'webhook:settle' },
  });
}

// The reserve every race saga holds, plus the figures a winning settle moves. The 4.00 CREDIT
// reserve converts at the payout rate of $0.005 to $0.02 USD. These are the same two coupled
// postings settlePayout.test.ts pins. Assertions check deltas against these figures, so a shared
// store that accumulates across iterations is fine.
const RESERVE = credit('4.00');
const SETTLE_USD = usd('0.02');
const INVALID = 'SAGA.INVALID_TRANSITION';
const ITERATIONS = 50;
// The worker-vs-settle race uses fewer iterations. Each iteration adds to the same growing ledger
// that prove() re-walks, and this many genuinely concurrent attempts already catch the narrow
// timeout-vs-late-settle window.
const WORKER_ITERATIONS = 15;

// How a refused loser must surface on every backend: the clean domain fault. Whoever takes the
// PAYOUT_RESERVE lock first transitions the saga. The loser reloads a no-longer-SUBMITTED saga and
// throws SAGA.INVALID_TRANSITION at its state guard before posting anything. Under genuine
// concurrency the engine's own lock manager may break the tie first by aborting one transaction with
// a deadlock or serialization conflict (InnoDB ER_LOCK_DEADLOCK, Postgres 40P01/40001). But the SQL
// engines now retry those transient aborts inside their transaction wrappers. The aborted side rolls
// back and re-runs the whole transaction, which reloads the terminal saga and is refused with the
// same SAGA.INVALID_TRANSITION. So no raw DB lock error escapes to the caller, and the loser is the
// clean domain refusal on memory, Postgres, and MySQL alike.
const CLEAN_REFUSAL = [INVALID];

// Seeds one payout in SUBMITTED with its reserve already in escrow. It credits PAYOUT_RESERVE and
// debits STORED_VALUE, a platform account exempt from the overdraft rule, exactly as the two op
// tests do. `updatedAt` is set far enough in the past that `now - updatedAt > maxPayoutAgeMs`, so a
// manual reverse of this SUBMITTED saga is allowed because it is past the provider settlement
// window. Otherwise reverse would be refused up front at refuseLiveSubmitted and there would be no
// race to run.
async function seedSubmittedSaga(
  store: Store,
  id: string,
  userId: string,
): Promise<void> {
  const stale = fixedClock(0).now() - testConfig().maxPayoutAgeMs - 1;
  const row: Saga = {
    id,
    userId,
    reserve: RESERVE,
    rateId: 'payout:CREDIT->USD:5/3',
    state: 'SUBMITTED',
    providerRef: 'prov_race',
    reason: null,
    attempts: 1,
    dueAt: 0,
    updatedAt: stale,
    payoutUsd: null,
  };
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    await unit.ledger.append({
      txnId: `txn_seed_${id}`,
      legs: [
        creditLeg(SYSTEM.PAYOUT_RESERVE, RESERVE),
        debitLeg(SYSTEM.STORED_VALUE, RESERVE),
      ],
      meta: { kind: 'seed' },
    });
  });
}

interface Snapshot {
  reserve: Amount;
  revenue: Amount;
  trustCash: Amount;
  usdClearing: Amount;
  earned: Amount;
}

async function snapshot(
  store: Store,
  sellerEarned: AccountRef,
): Promise<Snapshot> {
  return {
    reserve: await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    revenue: await store.ledger.balance(SYSTEM.REVENUE),
    trustCash: await store.ledger.balance(SYSTEM.TRUST_CASH),
    usdClearing: await store.ledger.balance(SYSTEM.USD_CLEARING),
    earned: await store.ledger.balance(sellerEarned),
  };
}

function delta(before: Amount, after: Amount): bigint {
  return after.minor - before.minor;
}

// What a submit resolved or rejected to, flattened so both firing orders read the same. It is
// 'committed' when the submit committed, the fault code when it threw, or a tag for anything else.
// The anything-else tag fails the test.
type Settled =
  | { kind: 'committed' }
  | { kind: 'rejected'; code: string | undefined }
  | { kind: 'other'; status: string };

async function settleOf(submit: Promise<Outcome>): Promise<Settled> {
  try {
    const outcome = await submit;
    return outcome.status === 'committed'
      ? { kind: 'committed' }
      : { kind: 'other', status: outcome.status };
  } catch (error) {
    const code =
      error instanceof Error ? (error as { code?: string }).code : undefined;
    return { kind: 'rejected', code };
  }
}

// Asserts the books after a race that settle won. The saga is SETTLED, the reserve emptied into
// REVENUE, gross USD left trust, and the seller's fresh earned account is untouched. The reserve
// moved once, in the settle direction, and was not also returned.
function assertSettleWonBooks(
  tag: string,
  state: string | undefined,
  before: Snapshot,
  after: Snapshot,
): void {
  assert.equal(state, 'SETTLED', `${tag}: settle won but saga not SETTLED`);
  assert.equal(
    delta(before.reserve, after.reserve),
    -RESERVE.minor,
    `${tag}: reserve did not empty on settle`,
  );
  assert.equal(
    delta(before.revenue, after.revenue),
    RESERVE.minor,
    `${tag}: reserve did not land in REVENUE on settle`,
  );
  assert.equal(
    delta(before.trustCash, after.trustCash),
    -SETTLE_USD.minor,
    `${tag}: USD did not leave trust on settle`,
  );
  assert.equal(
    delta(before.usdClearing, after.usdClearing),
    SETTLE_USD.minor,
    `${tag}: USD_CLEARING did not record the settle`,
  );
  assert.deepEqual(
    after.earned,
    credit('0.00'),
    `${tag}: settle won but the reserve also went back to the seller — double outcome`,
  );
}

// Asserts the books after a race that reverse won. The saga is FAILED, the reserve returned to the
// seller's earned account, and REVENUE and trust are untouched. The reserve moved once, in the
// reverse direction, and the seller was not also paid.
function assertReverseWonBooks(
  tag: string,
  state: string | undefined,
  before: Snapshot,
  after: Snapshot,
): void {
  assert.equal(state, 'FAILED', `${tag}: reverse won but saga not FAILED`);
  assert.equal(
    delta(before.reserve, after.reserve),
    -RESERVE.minor,
    `${tag}: reserve did not empty on reverse`,
  );
  assert.deepEqual(
    after.earned,
    RESERVE,
    `${tag}: reserve did not return to the seller on reverse`,
  );
  assert.equal(
    delta(before.revenue, after.revenue),
    0n,
    `${tag}: reverse won but REVENUE moved — double outcome`,
  );
  assert.equal(
    delta(before.trustCash, after.trustCash),
    0n,
    `${tag}: reverse won but USD left trust — double outcome`,
  );
  assert.equal(
    delta(before.usdClearing, after.usdClearing),
    0n,
    `${tag}: reverse won but USD_CLEARING moved — double outcome`,
  );
}

// Runs prove() after every race. It checks that no money was created or lost, no account overdrew,
// the hash chain is intact, and cached balances are consistent with the legs.
async function assertInvariants(engine: Economy, tag: string): Promise<void> {
  const report = await engine.read.prove();
  assert.ok(report.conserved, `${tag}: conservation broken after the race`);
  assert.ok(report.noOverdraft, `${tag}: overdraft after the race`);
  assert.ok(report.chainIntact, `${tag}: hash chain broken after the race`);
  assert.ok(report.consistent, `${tag}: cached balance drifted after the race`);
}

// --- SQL engines: the genuine concurrent race --------------------------------------------------

// Runs one settle-vs-reverse race on a fresh SUBMITTED saga, fired truly concurrently. `settleFirst`
// controls which submit is handed to Promise.all first, so both firing orders are exercised. Asserts
// exactly one winner, the loser refused with INVALID_TRANSITION, money moved once in the winner's
// direction, and prove() holds.
async function oneConcurrentRace(
  engine: Economy,
  store: Store,
  tag: string,
  settleFirst: boolean,
): Promise<void> {
  const sagaId = `pay_race_${tag}`;
  const seller = `usr_race_seller_${tag}`;
  await seedSubmittedSaga(store, sagaId, seller);
  const before = await snapshot(store, earned(seller));

  const settle = () => settleOf(engine.submit(settlePayoutOp(sagaId)));
  const reverse = () =>
    settleOf(engine.submit(reversePayoutOp(sagaId, seller)));

  // Fire both against the engine's lock barrier. The order handed to Promise.all is the firing order
  // under test. Each result is tagged so the winner is known regardless of order.
  const [a, b] = settleFirst
    ? await Promise.all([settle(), reverse()])
    : await Promise.all([reverse(), settle()]);
  const settleResult = settleFirst ? a : b;
  const reverseResult = settleFirst ? b : a;

  const saga = await engine.read.saga(sagaId);
  const after = await snapshot(store, earned(seller));

  const settleWon = settleResult.kind === 'committed';
  const reverseWon = reverseResult.kind === 'committed';

  // Exactly one committed: never both (double-pay), never neither (lost work).
  assert.ok(
    settleWon !== reverseWon,
    `${tag} (settleFirst=${settleFirst}): both ops resolved the same — ` +
      `settle=${JSON.stringify(settleResult)} reverse=${JSON.stringify(reverseResult)}; ` +
      `exactly one must win`,
  );

  if (settleWon) {
    assertLoserRefused(tag, reverseResult, 'reverse', CLEAN_REFUSAL);
    assertSettleWonBooks(tag, saga?.state, before, after);
  } else {
    assertLoserRefused(tag, settleResult, 'settle', CLEAN_REFUSAL);
    assertReverseWonBooks(tag, saga?.state, before, after);
  }
  await assertInvariants(engine, tag);
}

// Asserts the loser of a race is a rejection carrying one of the allowed refusal codes. It must
// never be a `committed`, `duplicate`, or `rejected` outcome, which would mean it silently took or
// no-op'd, and never an unrelated throw. `allowed` is the clean domain refusal
// (SAGA.INVALID_TRANSITION) on every path. The deterministic memory interleaving and the genuine SQL
// concurrency both end there, because the SQL engines retry any transient deadlock or serialization
// abort into that same domain outcome.
function assertLoserRefused(
  tag: string,
  loser: Settled,
  which: string,
  allowed: string[],
): void {
  assert.equal(
    loser.kind,
    'rejected',
    `${tag}: the ${which} loser did not reject (got ${JSON.stringify(loser)})`,
  );
  const code = (loser as { code?: string }).code;
  assert.ok(
    code !== undefined && allowed.includes(code),
    `${tag}: the ${which} loser must be refused with one of [${allowed.join(', ')}], got ${String(code)}`,
  );
}

async function runConcurrentRaces(
  engine: Economy,
  store: Store,
  name: string,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    await oneConcurrentRace(engine, store, `${name}_s${i}`, true); // settle fired first
    await oneConcurrentRace(engine, store, `${name}_r${i}`, false); // reverse fired first
  }
}

// --- memory: deterministic interleaving (no nested transactions available) ---------------------

// Runs one deterministic settle-vs-reverse interleaving. The winner commits first via its own
// economy.submit, with no overlap, pre-empting the saga out of SUBMITTED. The loser is then
// submitted and must be refused with the real SAGA.INVALID_TRANSITION while posting nothing. This is
// the settlePayout.test.ts `raceSettleOnce` shape generalized to the cross-op race, and it is the
// strongest interleaving memory can model because its single journal forbids overlapping
// transactions.
async function oneDeterministicRace(
  engine: Economy,
  store: Store,
  tag: string,
  settleWins: boolean,
): Promise<void> {
  const sagaId = `pay_det_${tag}`;
  const seller = `usr_det_seller_${tag}`;
  await seedSubmittedSaga(store, sagaId, seller);
  const before = await snapshot(store, earned(seller));

  // The winner commits first, moving its money and pre-empting the saga's state.
  const winner = settleWins
    ? await settleOf(engine.submit(settlePayoutOp(sagaId)))
    : await settleOf(engine.submit(reversePayoutOp(sagaId, seller)));
  assert.equal(
    winner.kind,
    'committed',
    `${tag}: the designated winner (${settleWins ? 'settle' : 'reverse'}) did not commit (got ${JSON.stringify(winner)})`,
  );

  // The loser now finds the saga already out of SUBMITTED and must be refused with INVALID_TRANSITION,
  // posting nothing.
  const loser = settleWins
    ? await settleOf(engine.submit(reversePayoutOp(sagaId, seller)))
    : await settleOf(engine.submit(settlePayoutOp(sagaId)));
  // No contention here (winner already committed), so the loser must be the clean domain refusal.
  assertLoserRefused(
    tag,
    loser,
    settleWins ? 'reverse' : 'settle',
    CLEAN_REFUSAL,
  );

  const saga = await engine.read.saga(sagaId);
  const after = await snapshot(store, earned(seller));
  if (settleWins) {
    assertSettleWonBooks(tag, saga?.state, before, after);
  } else {
    assertReverseWonBooks(tag, saga?.state, before, after);
  }
  await assertInvariants(engine, tag);
}

async function runDeterministicRaces(
  engine: Economy,
  store: Store,
  name: string,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    await oneDeterministicRace(engine, store, `${name}_sw${i}`, true); // settle wins
    await oneDeterministicRace(engine, store, `${name}_rw${i}`, false); // reverse wins
  }
}

// --- worker timeout vs a late settle: the unguarded-reversal double-pay the audit found --------

// The background sweep force-fails a SUBMITTED payout aged past maxPayoutAgeMs, returning its reserve
// to the seller (deadLetter), at the same moment the provider's late settlement webhook settles it.
// Both move the same reserve in opposite, irreversible directions. The sweep now locks PAYOUT_RESERVE
// and CAS-flips the saga before posting, identical to the pipeline ops, so exactly one wins. Either
// settle pays the seller (SETTLED, reserve to REVENUE) or the sweep returns the reserve (FAILED),
// never both. Before the fix the sweep posted the reversal first and flipped state unconditionally,
// so a settle that won the chain race let the sweep's reversal re-post on retry and double-pay the
// seller.

// The sweep posts its reversal with its own id stream. Prefix it so the sweep's txn, obx, and evt
// ids never collide with the economy's over the shared store, since both otherwise count from zero.
function prefixedIds(prefix: string): WorkerCtx['ids'] {
  const base = sequentialIds();
  return { next: (kind) => base.next(`${prefix}-${kind}`) };
}

// Builds a WorkerCtx for the sweep. The clock is at 0 so a saga seeded with a stale `updatedAt`
// reads as aged past maxPayoutAgeMs. The timeout path calls neither processor nor rates, but both
// are supplied to satisfy the type. One ctx is reused across iterations so its prefixed id counter
// keeps climbing.
function raceWorkerCtx(): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: prefixedIds('wkr'),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: testConfig(),
  };
}

// Runs one worker-timeout-vs-settle race on a fresh aged SUBMITTED saga, fired truly concurrently.
// `settleFirst` controls which is handed to Promise.all first. The sweep returns a summary and does
// not throw on a lost CAS. The settle is an economy.submit that rejects with INVALID_TRANSITION if
// it loses. Asserts exactly one outcome, money moved once in the winner's direction, and prove()
// holds.
async function oneWorkerVsSettleRace(
  fixtures: { engine: Economy; store: Store; worker: WorkerCtx },
  tag: string,
  settleFirst: boolean,
): Promise<void> {
  const { engine, store, worker } = fixtures;
  const sagaId = `pay_wkr_${tag}`;
  const seller = `usr_wkr_seller_${tag}`;
  await seedSubmittedSaga(store, sagaId, seller);
  const before = await snapshot(store, earned(seller));

  const settle = () => settleOf(engine.submit(settlePayoutOp(sagaId)));
  const sweep = () => settleDuePayouts(store, worker, { now: 0, limit: 50 });

  let settleResult: Settled;
  let sweepSummary: SettleSummary;
  if (settleFirst) {
    const [s, w] = await Promise.all([settle(), sweep()]);
    settleResult = s;
    sweepSummary = w;
  } else {
    const [w, s] = await Promise.all([sweep(), settle()]);
    settleResult = s;
    sweepSummary = w;
  }

  const saga = await engine.read.saga(sagaId);
  const after = await snapshot(store, earned(seller));
  const failedByWorker = sweepSummary.deadLettered.some((d) => d.id === sagaId);

  // Exactly one terminal outcome: SETTLED (settle won) or FAILED (the sweep won), never neither.
  const settleWon = saga?.state === 'SETTLED';
  const workerWon = saga?.state === 'FAILED';
  assert.ok(
    settleWon !== workerWon,
    `${tag} (settleFirst=${settleFirst}): saga ended ${String(saga?.state)}; expected exactly one of SETTLED/FAILED`,
  );

  if (settleWon) {
    assert.equal(
      settleResult.kind,
      'committed',
      `${tag}: saga SETTLED but settle did not commit (got ${JSON.stringify(settleResult)})`,
    );
    assert.ok(
      !failedByWorker,
      `${tag}: settle won, yet the sweep also reported the saga dead-lettered — double outcome`,
    );
    assertSettleWonBooks(tag, saga?.state, before, after);
  } else {
    assert.ok(
      failedByWorker,
      `${tag}: saga FAILED but the sweep did not report it dead-lettered`,
    );
    assertLoserRefused(tag, settleResult, 'settle', CLEAN_REFUSAL);
    assertReverseWonBooks(tag, saga?.state, before, after);
  }
  await assertInvariants(engine, tag);
}

async function runWorkerVsSettleRaces(
  fixtures: { engine: Economy; store: Store; worker: WorkerCtx },
  name: string,
): Promise<void> {
  for (let i = 0; i < WORKER_ITERATIONS; i += 1) {
    await oneWorkerVsSettleRace(fixtures, `${name}_ws${i}`, true);
    await oneWorkerVsSettleRace(fixtures, `${name}_ww${i}`, false);
  }
}

// --- registration ------------------------------------------------------------------------------

// Memory is always available and runs the deterministic interleaving, since true concurrency needs a
// real engine.
describe('Concurrency: settle-vs-reverse (memory, deterministic interleaving)', () => {
  test('exactly one of settle/reverse wins each race; money moves once, the loser is INVALID_TRANSITION, prove() holds', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const economy = makeEconomy(1, store);
    try {
      await runDeterministicRaces(economy, store, 'mem');
    } finally {
      await economy.close();
    }
  });
});

// Registers the SQL engines, mirroring concurrency.adversarial. It provisions per describe, skips
// when the engine is unreachable, and runs the genuine concurrent race.
function runSqlRace(
  name: string,
  provision: () => Promise<AdversarialEngine | null>,
): void {
  describe(`Concurrency: settle-vs-reverse (${name})`, () => {
    let provisioned: AdversarialEngine | null = null;

    before(async () => {
      provisioned = await provision();
    });
    after(async () => {
      if (provisioned) {
        await provisioned.close();
      }
    });

    test('settle/reverse and worker-timeout/settle: exactly one wins each concurrent race; money moves once, the loser is INVALID_TRANSITION, prove() holds', async (t: TestContext) => {
      if (!provisioned) return t.skip(`${name} unreachable`);
      // Use a single economy across all iterations so its seeded txn-id counter stays unique. The
      // engine's store is shared, and each iteration carries its own saga and seller namespace. The
      // store is closed by `provisioned.close()` in `after`, so the economy is not closed here, which
      // would double-close. Both race suites run on the one economy. The worker sweep uses its own
      // prefixed id stream (raceWorkerCtx) so its postings never collide with the economy's over the
      // shared store.
      const economy = makeEconomy(1, provisioned.store);
      await runConcurrentRaces(economy, provisioned.store, name);
      await runWorkerVsSettleRaces(
        { engine: economy, store: provisioned.store, worker: raceWorkerCtx() },
        `${name}_wkr`,
      );
    });
  });
}

runSqlRace('postgres', adversarialPostgres);
runSqlRace('mysql', adversarialMysql);
