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
 * THE ADVERSARIAL CONFORMANCE HARNESS — Phase 1 (keystone) of docs/the-right-way.md.
 *
 * The thesis: the SQL database is the system of record and must enforce the ledger invariants
 * NATIVELY. The only way to prove that is to attempt each violation by writing a raw, violating
 * row AROUND the app — bypassing `post_entry` for the SQL engines, and going straight to the
 * lowest store method for the memory oracle — and assert the engine REJECTS it. A check that
 * only the app performs is not enforcement; this suite refuses to take the app's word for it.
 *
 * THE LAW OF ORDERING (docs/the-right-way.md §"law of ordering"):
 *   add engine enforcement → PROVE it with an adversarial test that writes the violation around
 *   the app → only THEN delete the app-side duplicate.
 * This file is the "prove it" step built BEFORE any enforcement. It changes no enforcement; it
 * only records, per (invariant, engine), whether the violation is caught TODAY:
 *
 *   - Where the engine already rejects the violation, the case is a HARD assertion now. Those
 *     are the invariants whose enforcement is already in-engine: I4 exactly-once (idempotency
 *     and seen_webhooks primary keys), the I3 no-fork unique index, and the I2 non-negative
 *     CHECK on user balances.
 *   - Where the engine does NOT yet reject it (per the worklist), the case is recorded with a
 *     `t.todo(...)` carrying an ENFORCEMENT-PENDING:<invariant>:<engine> marker and a one-line
 *     note of the mechanism that will close it (PG: a constraint/trigger; MySQL: the procedure
 *     as sole write door + revoked DML). A todo keeps the suite GREEN while naming the debt.
 *
 * The grep-able worklist of what is still pending:
 *   ENFORCEMENT-PENDING:I1:postgres   deferred constraint trigger on legs (sum=0 per currency)
 *   ENFORCEMENT-PENDING:I1:mysql      assert in post_entry + REVOKE direct DML on legs
 *   ENFORCEMENT-PENDING:I1:memory     oracle only — no engine enforcement is planned
 *   ENFORCEMENT-PENDING:I2:memory     oracle only — no engine enforcement is planned
 *   ENFORCEMENT-PENDING:I3:postgres   BEFORE INSERT trigger: prev_hash = account's current head
 *   ENFORCEMENT-PENDING:I3:mysql      continuity check inside post_entry + REVOKE direct DML
 *   ENFORCEMENT-PENDING:I3:memory     oracle only — append auto-computes prev_hash, no fork path
 *   ENFORCEMENT-PENDING:I5:postgres   trigger-maintained account_balances (= SUM(legs))
 *   ENFORCEMENT-PENDING:I5:mysql      trigger/proc-maintained account_balances + REVOKE DML
 *   ENFORCEMENT-PENDING:I5:memory     oracle only — no engine enforcement is planned
 *
 * Already in-engine and asserted HARD today:
 *   I2 overdraft (PG + MySQL): the user_account_non_negative CHECK rejects a negative user row.
 *   I3 no-fork  (PG + MySQL): unique (account_id, prev_hash) rejects a second link at one point.
 *   I4 exactly-once (PG + MySQL + memory): duplicate idempotency key / webhook event id rejected.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount, toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import {
  adversarialMemory,
  adversarialPostgres,
  adversarialMysql,
} from '#test/conformance/adversarial-engines.ts';

import type { TestContext } from 'node:test';
import type {
  AdversarialEngine,
  AdversarialMemory,
} from '#test/conformance/adversarial-engines.ts';
import type { Store, Unit } from '#src/ports.ts';
import type { AccountRef } from '#src/accounts.ts';

const GENESIS_HEX = '0'.repeat(64);
const seq = (() => {
  let n = 0;
  return () => (n += 1);
})();

// Fund a user's spendable account through the APP (post_entry), the clean-setup path every
// adversarial case starts from before it reaches around the app to write the violation.
async function fundSpendable(
  store: Store,
  userId: string,
  dollars: string,
  txnId: string,
): Promise<void> {
  let amount = decodeAmount(dollars, 'CREDIT');
  await store.transaction((unit: Unit) =>
    postEntry(unit.ledger, {
      txnId,
      legs: [credit(spendable(userId), amount), debit(SYSTEM.REVENUE, amount)],
      meta: { source: 'card' },
    }),
  );
}

// Assert a raw write around the app is REJECTED by the engine (the query throws). The thrown
// error is the engine declining the violation — exactly what native enforcement looks like.
async function assertRawRejected(
  engine: AdversarialEngine,
  description: string,
  sql: string,
  params?: unknown[],
): Promise<void> {
  await assert.rejects(
    engine.raw(sql, params),
    (error: unknown) => error instanceof Error,
    `${engine.name}: expected the engine to reject ${description}, but the raw write succeeded`,
  );
}

// SQL to insert a posting row directly (the parent every leg/chain_link references). The column
// list and literal are identical on both engines (JSON '{}' parses on each).
function rawInsertPosting(id: string): string {
  return `insert into postings (id, meta, posted_at) values ('${id}', '{}', 0)`;
}

// Insert a duplicate idempotency row. `key` is a reserved word in MySQL (needs backticks); plain
// in Postgres. Pick the column spelling by engine.
function rawInsertIdempotency(engineName: string, key: string): string {
  let column = engineName === 'mysql' ? '`key`' : 'key';
  return `insert into idempotency (${column}, transaction) values ('${key}', '{}')`;
}

// Pull the head hash an account currently chains from, straight off the store (the value a
// continuous next link must carry as its prev_hash). Genesis when the account has no link yet.
async function currentHead(store: Store, account: AccountRef): Promise<string> {
  for await (let [acct, head] of store.ledger.heads()) {
    if (acct === account) {
      return head;
    }
  }
  return GENESIS_HEX;
}

// ============================================================================
// The SQL matrix. Each engine is provisioned once; unreachable engines yield null and every
// case skips (never fails) — the same contract the existing adapter suites use.
// ============================================================================
type SqlProvisioner = () => Promise<AdversarialEngine | null>;

function runSqlAdversarial(name: string, provision: SqlProvisioner): void {
  describe(`Adversarial: ${name}`, () => {
    let engine: AdversarialEngine | null = null;

    before(async () => {
      engine = await provision();
    });
    after(async () => {
      if (engine) {
        await engine.close();
      }
    });

    // --- I1 conservation: a leg set that does not sum to zero must be rejected ---------------
    // Today: NO engine rejects it (the conservation check is app-only, in src/ledger.ts
    // assertBalanced). Recorded as pending; becomes a hard assertion once the engine enforces it.
    test('I1 conservation: a raw unbalanced leg is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let userId = `usr_adv_i1_${seq()}`;
      let account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_i1_setup_${userId}`,
      );

      let txn = `txn_adv_i1_${userId}`;
      await live.raw(rawInsertPosting(txn));
      // One lone credit leg (sum != 0 for CREDIT): a balanced posting must pair it with a debit.
      let writeOneSidedLeg = () =>
        live.raw(
          `insert into legs (posting_id, account_id, currency, amount) values ('${txn}', '${account}', 'CREDIT', -500)`,
        );

      let rejected = await writeOneSidedLeg().then(
        () => false,
        () => true,
      );
      if (!rejected) {
        // Mechanism pending — PG: deferred constraint trigger on legs; MySQL: assert in
        // post_entry + REVOKE direct DML so the proc is the only write door.
        t.todo(
          `ENFORCEMENT-PENDING:I1:${name} — engine accepts an unbalanced leg today`,
        );
        return;
      }
      assert.ok(rejected);
    });

    // --- I2 no overdraft: a negative USER balance must be rejected; a system one is exempt ----
    // Today: the user_account_non_negative CHECK already rejects this on BOTH engines → HARD.
    test('I2 overdraft: a raw negative user balance is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let userId = `usr_adv_i2_${seq()}`;
      let account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_i2_setup_${userId}`,
      );

      // Drive the user's cached balance below zero around the app. The CHECK is the DB's half of
      // the overdraft guard and must decline it regardless of how the row is written.
      await assertRawRejected(
        live,
        'a negative user-account balance',
        `update account_balances set balance = -100 where account_id = '${account}'`,
      );
    });

    // The non-negative CHECK must EXEMPT system accounts — several hold negative balances by design.
    // With I5 enforcing balance = signed leg sum, a system account can no longer be slammed negative
    // by a hand-written balance (I5 would refuse it); the negative must come from real legs. So post a
    // balanced entry that CREDITS RECEIVABLE (debit-normal → its balance falls to -100), satisfying
    // I1 (legs net to zero) and I5 (cached balance equals the legs), leaving only the non-negative
    // rule in question — which must let this 'vrchat:%' system balance stand. A user account driven
    // negative the same way is rejected by that very CHECK; see the case above.
    test('I2 overdraft: a legitimately negative SYSTEM balance is allowed (exempt)', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let userId = `usr_adv_i2sys_${seq()}`;
      await live.store.transaction(async (unit: Unit) => {
        await postEntry(unit.ledger, {
          txnId: `txn_adv_i2sys_${userId}`,
          legs: [
            credit(SYSTEM.RECEIVABLE, toAmount('CREDIT', 100n)),
            debit(SYSTEM.STORED_VALUE, toAmount('CREDIT', 100n)),
          ],
          meta: { source: 'adversarial' },
        });
      });

      let rows = (await live.raw(
        `select balance from account_balances where account_id = '${SYSTEM.RECEIVABLE}'`,
      )) as Array<{ balance: bigint | number | string }>;
      assert.equal(rows.length, 1);
      assert.equal(BigInt(rows[0]!.balance), -100n);
    });

    // --- I3 chain continuity: no fork (two links at one point) and no discontinuity ----------
    // No-fork is enforced by unique (account_id, prev_hash) on BOTH engines → HARD today.
    test('I3 continuity: a raw forked chain link (same prev_hash) is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let userId = `usr_adv_i3fork_${seq()}`;
      let account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_i3fork_${userId}`,
      );

      // The funding posting already wrote one link from GENESIS for this account. A second link
      // claiming the SAME previous hash would fork the chain into two branches.
      let txn = `txn_adv_i3fork2_${userId}`;
      await live.raw(rawInsertPosting(txn));
      await assertRawRejected(
        live,
        'a second chain link at the same prev_hash (a fork)',
        `insert into chain_links (posting_id, account_id, prev_hash, hash) values ('${txn}', '${account}', '${GENESIS_HEX}', '${'f'.repeat(64)}')`,
      );
    });

    // Discontinuity (a link whose prev_hash is NOT the account's current head) is NOT yet
    // rejected by either engine; the unique index blocks a duplicate point, not a wrong one.
    test('I3 continuity: a raw discontinuous chain link (wrong prev_hash) is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let userId = `usr_adv_i3disc_${seq()}`;
      let account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_i3disc_${userId}`,
      );

      let head = await currentHead(live.store, account);
      // A prev_hash that equals neither the current head nor any prior one: a discontinuous link.
      let bogusPrev = 'a'.repeat(64);
      assert.notEqual(bogusPrev, head);

      let txn = `txn_adv_i3disc2_${userId}`;
      await live.raw(rawInsertPosting(txn));
      let writeDiscontinuous = () =>
        live.raw(
          `insert into chain_links (posting_id, account_id, prev_hash, hash) values ('${txn}', '${account}', '${bogusPrev}', '${'e'.repeat(64)}')`,
        );

      let rejected = await writeDiscontinuous().then(
        () => false,
        () => true,
      );
      if (!rejected) {
        // Mechanism pending — PG: BEFORE INSERT trigger asserting prev_hash = current head;
        // MySQL: the same check inside post_entry + REVOKE direct DML on chain_links.
        t.todo(
          `ENFORCEMENT-PENDING:I3:${name} — engine accepts a discontinuous link today`,
        );
        return;
      }
      assert.ok(rejected);
    });

    // --- I4 exactly-once: a duplicate idempotency key / webhook event id must be rejected -----
    // Enforced by the primary keys on idempotency and seen_webhooks on BOTH engines → HARD.
    test('I4 exactly-once: a duplicate idempotency key is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let key = `idem_adv_${seq()}`;
      let userId = `usr_adv_i4_${seq()}`;
      // Claim AND record through the app so a committed primary-key row exists. (claim alone does
      // not insert on Postgres — only record writes the row — so the duplicate must collide with
      // a recorded key, the genuine exactly-once scenario.)
      await live.store.transaction(async (unit: Unit) => {
        let claim = await unit.idempotency.claim(key);
        assert.equal(claim.claimed, true);
        let txn = await postEntry(unit.ledger, {
          txnId: `txn_adv_i4_${userId}`,
          legs: [
            credit(spendable(userId), toAmount('CREDIT', 100n)),
            debit(SYSTEM.REVENUE, toAmount('CREDIT', 100n)),
          ],
          meta: { source: 'card' },
        });
        await unit.idempotency.record(key, txn);
      });

      // A second row for the same key, written around the app, must hit the primary key.
      await assertRawRejected(
        live,
        'a second idempotency row for the same recorded key',
        rawInsertIdempotency(live.name, key),
      );
    });

    test('I4 exactly-once: a duplicate webhook event id is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let eventId = `evt_adv_${seq()}`;
      // First sighting through the app's replay store, which inserts the primary-key row.
      let first = await live.store.replay.claim(eventId);
      assert.equal(first.claimed, true);

      // A second row for the same event id, written around the app, must hit the primary key.
      await assertRawRejected(
        live,
        'a second seen_webhooks row for the same event id',
        `insert into seen_webhooks (event_id) values ('${eventId}')`,
      );
    });

    // --- I5 balance integrity: cached balance must equal SUM(legs) ----------------------------
    // Today: NO engine enforces the equality; account_balances is hand-maintained, drift is an
    // app-side audit only. Recorded pending; becomes hard once the projection is trigger-maintained.
    test('I5 balance integrity: a raw drifted balance (≠ SUM legs) is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let userId = `usr_adv_i5_${seq()}`;
      let account = spendable(userId);
      await fundSpendable(live.store, userId, '5.00', `txn_adv_i5_${userId}`);

      // Inflate the cached balance to a value the legs do not sum to (500 → 999), staying
      // non-negative so the I2 CHECK can't be what rejects it. A trigger-maintained projection
      // would refuse this hand-edit (or make it unrepresentable).
      let drift = () =>
        live.raw(
          `update account_balances set balance = 999 where account_id = '${account}'`,
        );

      let rejected = await drift().then(
        () => false,
        () => true,
      );
      if (!rejected) {
        // Mechanism pending — PG/MySQL: replace the hand-maintained account_balances with a
        // trigger-maintained projection of legs (or derive on read), + REVOKE direct DML.
        t.todo(
          `ENFORCEMENT-PENDING:I5:${name} — engine accepts a drifted cached balance today`,
        );
        return;
      }
      assert.ok(rejected);
    });
  });
}

runSqlAdversarial('postgres', adversarialPostgres);
runSqlAdversarial('mysql', adversarialMysql);

// ============================================================================
// The memory oracle. There is no layer beneath it, so "around the app" means the lowest write
// door (`ledger.append`, which performs NONE of post_entry's checks) and the documented
// `__seedBalance` / `__tamper` back doors. Per the plan, memory is the test oracle and receives
// no engine enforcement, so I1/I2/I3/I5 are expected to stay pending here. I4 IS real on memory:
// the idempotency and replay stores dedupe natively.
// ============================================================================
describe('Adversarial: memory (oracle)', () => {
  let oracle: AdversarialMemory;

  before(() => {
    oracle = adversarialMemory();
  });
  after(async () => {
    await oracle.close();
  });

  // I1: append accepts an unbalanced posting (it does not run assertBalanced). Pending: memory
  // is the oracle and gets no engine enforcement; the SQL engines carry the I1 worklist.
  test('I1 conservation: append accepts an unbalanced posting', async (t: TestContext) => {
    let userId = `usr_mem_i1_${seq()}`;
    let account = spendable(userId);
    let amount = toAmount('CREDIT', 500n);

    let accepted = await oracle.store
      .transaction((unit: Unit) =>
        // ONE leg only — sum != 0. postEntry would throw; append does not check.
        unit.ledger.append({
          txnId: `txn_mem_i1_${userId}`,
          legs: [{ account, amount: toAmount('CREDIT', -amount.minor) }],
          meta: {},
        }),
      )
      .then(
        () => true,
        () => false,
      );

    if (accepted) {
      t.todo(
        'ENFORCEMENT-PENDING:I1:memory — oracle only, no engine enforcement planned',
      );
      return;
    }
    assert.fail('memory unexpectedly rejected an unbalanced append');
  });

  // I2: __seedBalance plants a negative user balance with no guard. Pending for the same reason.
  test('I2 overdraft: a seeded negative user balance is accepted', async (t: TestContext) => {
    let userId = `usr_mem_i2_${seq()}`;
    let account = spendable(userId);

    oracle.ledger.__seedBalance(account, toAmount('CREDIT', -100n));
    let stored = await oracle.store.ledger.balance(account);

    if (stored.minor < 0n) {
      t.todo(
        'ENFORCEMENT-PENDING:I2:memory — oracle only, no engine enforcement planned',
      );
      return;
    }
    assert.fail('memory unexpectedly refused a negative seeded balance');
  });

  // I3: memory's append AUTO-computes prev_hash from the current head, so there is no path to
  // write a fork or a discontinuous link through the lowest door. Pending/structural: the oracle
  // simply has no way to express the violation; the SQL engines carry the I3 worklist.
  test('I3 continuity: append cannot express a discontinuous link', async (t: TestContext) => {
    let userId = `usr_mem_i3_${seq()}`;
    let account = spendable(userId);
    let amount = toAmount('CREDIT', 500n);

    // Append a balanced posting; the link's prev_hash is forced to GENESIS by the store, not by us.
    let txn = await oracle.store.transaction((unit: Unit) =>
      unit.ledger.append({
        txnId: `txn_mem_i3_${userId}`,
        legs: [
          { account, amount: toAmount('CREDIT', -amount.minor) },
          { account: SYSTEM.REVENUE, amount: toAmount('CREDIT', amount.minor) },
        ],
        meta: {},
      }),
    );
    let link = txn.links.find((candidate) => candidate.account === account);
    assert.notEqual(link, undefined);
    // The store computed prev_hash itself (GENESIS for a first link); the caller never supplied it.
    assert.equal(link!.prevHash, GENESIS_HEX);
    t.todo(
      'ENFORCEMENT-PENDING:I3:memory — oracle only, append auto-computes prev_hash',
    );
  });

  // I4 exactly-once IS real on memory: a second claim of a recorded key does not re-grant.
  test('I4 exactly-once: a duplicate idempotency claim does not re-grant', async () => {
    let key = `idem_mem_${seq()}`;
    let recorded = await oracle.store.transaction(async (unit: Unit) => {
      let claim = await unit.idempotency.claim(key);
      assert.equal(claim.claimed, true);
      let txn = await postEntry(unit.ledger, {
        txnId: `txn_mem_i4_${key}`,
        legs: [
          {
            account: spendable(`usr_${key}`),
            amount: toAmount('CREDIT', -100n),
          },
          { account: SYSTEM.REVENUE, amount: toAmount('CREDIT', 100n) },
        ],
        meta: {},
      });
      await unit.idempotency.record(key, txn);
      return txn;
    });

    let replay = await oracle.store.transaction((unit: Unit) =>
      unit.idempotency.claim(key),
    );
    assert.equal(replay.claimed, false);
    assert.deepEqual(
      (replay as { claimed: false; transaction: typeof recorded }).transaction,
      recorded,
    );
  });

  // I4 exactly-once IS real on memory: a redelivered webhook event id is not re-claimed.
  test('I4 exactly-once: a duplicate webhook event id is not re-claimed', async () => {
    let eventId = `evt_mem_${seq()}`;
    let first = await oracle.store.replay.claim(eventId);
    let second = await oracle.store.replay.claim(eventId);
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
  });

  // I5: __seedBalance plants a balance away from SUM(legs) (drift), which the oracle keeps
  // and the prover later reports. The store does not refuse it. Pending for the same reason.
  test('I5 balance integrity: a seeded drifted balance is accepted', async (t: TestContext) => {
    let userId = `usr_mem_i5_${seq()}`;
    let account = spendable(userId);
    await fundSpendable(oracle.store, userId, '5.00', `txn_mem_i5_${userId}`);

    // Inflate the cached balance away from SUM(legs) (500 → 999), staying non-negative.
    oracle.ledger.__seedBalance(account, toAmount('CREDIT', 999n));
    let stored = await oracle.store.ledger.balance(account);

    if (stored.minor === 999n) {
      t.todo(
        'ENFORCEMENT-PENDING:I5:memory — oracle only, no engine enforcement planned',
      );
      return;
    }
    assert.fail('memory unexpectedly refused a drifted seeded balance');
  });
});
