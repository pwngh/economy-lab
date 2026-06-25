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
 * Settle-vs-reverse race — the gap the per-operation suites never cover. settlePayout
 * (SUBMITTED -> SETTLED) and reversePayout (a reversible payout -> FAILED, reserve returned to the
 * seller) both move one saga out of SUBMITTED, but each moves money in an opposite, irreversible
 * direction: settle empties the reserve into REVENUE and ships USD out of trust (the seller is
 * paid), while reverse hands the reserve back to the seller's earned account (the payout is undone).
 * settlePayout.test.ts pins settle-vs-settle CAS and the single-actor SETTLED refusal;
 * reversePayout.test.ts pins the SETTLED/live-SUBMITTED refusals. Neither fires settle AND reverse
 * concurrently on the SAME SUBMITTED saga.
 *
 * A correct engine must let exactly ONE win and refuse the other, and money must move exactly once:
 * either the seller is paid (settle) OR the reserve is returned (reverse), never both, never
 * neither. The two ops share the PAYOUT_RESERVE lock (see accountsOf), so economy.submit serializes
 * them on that account: whoever takes the lock first transitions the saga; the loser then loads a
 * no-longer-SUBMITTED saga and is turned away at its state guard (settle's refuseNotSubmitted /
 * reverse's refuseSettled), throwing SAGA.INVALID_TRANSITION before it can post a second move. The
 * winner commits; the loser's submit() promise rejects with that fault and rolls back its postings.
 *
 * TWO LEVELS OF COVERAGE, because true overlapping transactions only exist on a real engine:
 *
 *  - SQL engines (Postgres + MySQL, when reachable): the genuine concurrent race. settle and reverse
 *    are fired together via Promise.all and truly interleave on the engine's row/account locks — the
 *    same harness concurrency.adversarial uses (memory is deliberately excluded there because the
 *    in-memory store has a single journal and forbids overlapping transactions: "in-memory
 *    transactions do not nest"). 50 iterations, BOTH firing orders each iteration.
 *
 *  - memory: a deterministic interleaving instead, mirroring settlePayout.test.ts's `raceSettleOnce`
 *    — pre-empt the saga into the winner's terminal state (committing the winner's money first),
 *    then run the loser and assert it is refused with the real SAGA.INVALID_TRANSITION and posts
 *    nothing. This pins the loser-refusal + money-moves-once contract on memory without needing the
 *    nested transactions memory can't provide. 50 iterations, BOTH winners (settle-wins,
 *    reverse-wins) each iteration.
 *
 * Every iteration on every backend asserts: exactly one outcome commits, the loser is rejected with
 * SAGA.INVALID_TRANSITION, the reserve moved exactly once in the winner's direction (settle ->
 * REVENUE + USD left trust + SETTLED; reverse -> seller earned + FAILED), and prove() still holds
 * (conserved, no overdraft, chain intact, cache consistent) — no double-pay, no lost/minted money.
 *
 * An unreachable SQL engine skips, never fails — the same graceful contract the other conformance
 * suites use.
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
} from '#test/support/capabilities.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  adversarialPostgres,
  adversarialMysql,
} from '#test/conformance/adversarial-engines.ts';

import type { AdversarialEngine } from '#test/conformance/adversarial-engines.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Saga, Store } from '#src/ports.ts';

// builders.ts has no reversePayout factory (only settlePayout), so build one here, matching the
// operator-actor reverse reversePayout.test.ts drives.
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

// The reserve every race saga holds, and the figures a winning settle moves (the 4.00 CREDIT reserve
// converts at the payout rate $0.005 to $0.02 USD; the same two coupled postings settlePayout.test.ts
// pins). Deltas are asserted against these so a shared store accumulating across iterations is fine.
let RESERVE = credit('4.00');
let SETTLE_USD = usd('0.02');
let INVALID = 'SAGA.INVALID_TRANSITION';
let ITERATIONS = 50;

// How a refused loser must surface, on every backend: the clean domain fault. Whoever takes the
// PAYOUT_RESERVE lock first transitions the saga; the loser reloads a no-longer-SUBMITTED saga and
// throws SAGA.INVALID_TRANSITION at its state guard before posting anything. Under genuine
// concurrency the engine's own lock manager may break the tie first by aborting one transaction with
// a deadlock/serialization conflict (InnoDB ER_LOCK_DEADLOCK, Postgres 40P01/40001), but the SQL
// engines now retry those transient aborts inside their transaction wrappers — the aborted side
// rolls back and re-runs the whole transaction, which reloads the terminal saga and is refused with
// the same SAGA.INVALID_TRANSITION. So no raw DB lock error escapes to the caller, and the loser is
// the clean domain refusal on memory, Postgres, and MySQL alike.
let CLEAN_REFUSAL = [INVALID];

// Seed one payout in SUBMITTED with its reserve already in escrow (credit PAYOUT_RESERVE, debit
// STORED_VALUE — a platform account exempt from the overdraft rule), exactly as the two op tests do.
// `updatedAt` is set far enough in the past that `now - updatedAt > maxPayoutAgeMs`, so a manual
// reverse of this SUBMITTED saga is allowed (past the provider settlement window) — otherwise
// reverse would be refused up front at refuseLiveSubmitted and there would be no race to run.
async function seedSubmittedSaga(
  store: Store,
  id: string,
  userId: string,
): Promise<void> {
  let stale = fixedClock(0).now() - testConfig().maxPayoutAgeMs - 1;
  let row: Saga = {
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

// What a submit resolved/rejected to, flattened so both orders read the same: 'committed' when it
// committed, the fault code when it threw, or a tag for anything else (which fails the test).
type Settled =
  | { kind: 'committed' }
  | { kind: 'rejected'; code: string | undefined }
  | { kind: 'other'; status: string };

async function settleOf(submit: Promise<Outcome>): Promise<Settled> {
  try {
    let outcome = await submit;
    return outcome.status === 'committed'
      ? { kind: 'committed' }
      : { kind: 'other', status: outcome.status };
  } catch (error) {
    let code =
      error instanceof Error ? (error as { code?: string }).code : undefined;
    return { kind: 'rejected', code };
  }
}

// Assert the books after a race that SETTLE won: saga SETTLED, reserve emptied into REVENUE, gross
// USD left trust, and the seller's (fresh) earned account untouched — the reserve moved once, in the
// settle direction, and was NOT also returned.
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

// Assert the books after a race that REVERSE won: saga FAILED, reserve returned to the seller's
// earned account, and REVENUE / trust untouched — the reserve moved once, in the reverse direction,
// and the seller was NOT also paid.
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

// prove() after every race: no money created or lost, no overdraft, the hash chain intact, cached
// balances consistent with the legs.
async function assertInvariants(engine: Economy, tag: string): Promise<void> {
  let report = await engine.read.prove();
  assert.ok(report.conserved, `${tag}: conservation broken after the race`);
  assert.ok(report.noOverdraft, `${tag}: overdraft after the race`);
  assert.ok(report.chainIntact, `${tag}: hash chain broken after the race`);
  assert.ok(report.consistent, `${tag}: cached balance drifted after the race`);
}

// --- SQL engines: the genuine concurrent race --------------------------------------------------

// One settle-vs-reverse race on a fresh SUBMITTED saga, fired truly concurrently. `settleFirst`
// controls which submit is handed to Promise.all first, so both firing orders are exercised. Asserts
// exactly one winner, the loser refused with INVALID_TRANSITION, money moved once in the winner's
// direction, and prove() holds.
async function oneConcurrentRace(
  engine: Economy,
  store: Store,
  tag: string,
  settleFirst: boolean,
): Promise<void> {
  let sagaId = `pay_race_${tag}`;
  let seller = `usr_race_seller_${tag}`;
  await seedSubmittedSaga(store, sagaId, seller);
  let before = await snapshot(store, earned(seller));

  let settle = () => settleOf(engine.submit(settlePayoutOp(sagaId)));
  let reverse = () => settleOf(engine.submit(reversePayoutOp(sagaId, seller)));

  // Fire both against the engine's lock barrier; the order handed to Promise.all is the firing order
  // under test. Tag each result so we know which op won regardless of order.
  let [a, b] = settleFirst
    ? await Promise.all([settle(), reverse()])
    : await Promise.all([reverse(), settle()]);
  let settleResult = settleFirst ? a : b;
  let reverseResult = settleFirst ? b : a;

  let saga = await engine.read.saga(sagaId);
  let after = await snapshot(store, earned(seller));

  let settleWon = settleResult.kind === 'committed';
  let reverseWon = reverseResult.kind === 'committed';

  // Exactly one committed — never both (double-pay), never neither (lost work).
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

// The loser of a race must be a rejection carrying one of the allowed refusal codes — never a
// `committed`/`duplicate`/`rejected` outcome (which would mean it silently took or no-op'd) and never
// an unrelated throw. `allowed` is the clean domain refusal (SAGA.INVALID_TRANSITION) on every path:
// the deterministic memory interleaving and the genuine SQL concurrency both end there, because the
// SQL engines retry any transient deadlock/serialization abort into that same domain outcome.
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
  let code = (loser as { code?: string }).code;
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

// One deterministic settle-vs-reverse interleaving. The winner is committed first via its own
// economy.submit (no overlap), pre-empting the saga out of SUBMITTED; the loser is then submitted and
// must be refused with the real SAGA.INVALID_TRANSITION while posting nothing. This is the
// settlePayout.test.ts `raceSettleOnce` shape generalized to the cross-op race, and is the strongest
// interleaving memory can model (its single journal forbids overlapping transactions).
async function oneDeterministicRace(
  engine: Economy,
  store: Store,
  tag: string,
  settleWins: boolean,
): Promise<void> {
  let sagaId = `pay_det_${tag}`;
  let seller = `usr_det_seller_${tag}`;
  await seedSubmittedSaga(store, sagaId, seller);
  let before = await snapshot(store, earned(seller));

  // The winner commits first, moving its money and pre-empting the saga's state.
  let winner = settleWins
    ? await settleOf(engine.submit(settlePayoutOp(sagaId)))
    : await settleOf(engine.submit(reversePayoutOp(sagaId, seller)));
  assert.equal(
    winner.kind,
    'committed',
    `${tag}: the designated winner (${settleWins ? 'settle' : 'reverse'}) did not commit (got ${JSON.stringify(winner)})`,
  );

  // The loser now finds the saga already out of SUBMITTED and must be refused with INVALID_TRANSITION,
  // posting nothing.
  let loser = settleWins
    ? await settleOf(engine.submit(reversePayoutOp(sagaId, seller)))
    : await settleOf(engine.submit(settlePayoutOp(sagaId)));
  // No contention here (winner already committed), so the loser must be the CLEAN domain refusal.
  assertLoserRefused(
    tag,
    loser,
    settleWins ? 'reverse' : 'settle',
    CLEAN_REFUSAL,
  );

  let saga = await engine.read.saga(sagaId);
  let after = await snapshot(store, earned(seller));
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

// --- registration ------------------------------------------------------------------------------

// memory: always available, deterministic interleaving (true concurrency needs a real engine).
describe('Concurrency: settle-vs-reverse (memory, deterministic interleaving)', () => {
  test('exactly one of settle/reverse wins each race; money moves once, the loser is INVALID_TRANSITION, prove() holds', async () => {
    let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
    let economy = makeEconomy(1, store);
    try {
      await runDeterministicRaces(economy, store, 'mem');
    } finally {
      await economy.close();
    }
  });
});

// The SQL engines, mirroring concurrency.adversarial: provision per describe, skip when unreachable,
// run the genuine concurrent race.
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

    test('exactly one of settle/reverse wins each concurrent race; money moves once, the loser is INVALID_TRANSITION, prove() holds', async (t: TestContext) => {
      if (!provisioned) return t.skip(`${name} unreachable`);
      // A single economy across all iterations so its seeded txn-id counter stays unique; the engine's
      // store is shared, and each iteration carries its own saga/seller namespace. The store is closed
      // by `provisioned.close()` in `after`, so the economy is not closed here (that would double-close).
      let economy = makeEconomy(1, provisioned.store);
      await runConcurrentRaces(economy, provisioned.store, name);
    });
  });
}

runSqlRace('postgres', adversarialPostgres);
runSqlRace('mysql', adversarialMysql);
