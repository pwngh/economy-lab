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
 * Adversarial conformance harness.
 *
 * The thesis: the SQL database is the system of record and must enforce the ledger invariants
 * natively. The only way to prove that is to attempt each violation by writing a raw, violating
 * row around the app — bypassing `post_entry` for the SQL engines, and going straight to the
 * lowest store method for the memory oracle — and assert the engine rejects it. A check that
 * only the app performs is not enforcement; this suite refuses to take the app's word for it.
 *
 * The ordering rule: add engine enforcement first, then prove it with an adversarial test that
 * writes the violation around the app, and only then delete the app-side duplicate.
 * Built as the keystone "prove it" step; the enforcement it called for has since landed, and this
 * file now holds the engine to account for them. It changes no enforcement; it asserts, per (invariant, engine),
 * that the violation is caught:
 *
 *   - On the SQL engines (postgres + mysql) every invariant below is a hard assertion: a raw
 *     violating row written around the app is rejected. I1 conservation, I3 chain continuity, and
 *     I5 balance integrity are enforced natively (mechanisms listed below), alongside exactly-once
 *     (idempotency and seen_webhooks primary keys), the no-fork unique index, and the non-negative
 *     CHECK on user balances.
 *   - The memory oracle has no native enforcement to attack, so its violation cases are recorded
 *     with a `t.todo(...)` naming what memory leaves to the SQL engines. A todo keeps the suite
 *     GREEN while naming what the reference store cannot enforce.
 *
 * What is still pending:
 *   conservation, memory          oracle only — no engine enforcement is planned
 *   overdraft, memory             oracle only — no engine enforcement is planned
 *   chain continuity, memory      oracle only — append auto-computes prev_hash, no fork path
 *   balance integrity, memory     oracle only — no engine enforcement is planned
 *
 * Already in the engine and asserted hard today:
 *   conservation (PG): deferred constraint trigger on legs (sum=0 per currency).
 *   conservation (MySQL): assert inside post_entry + REVOKE direct DML on legs.
 *   chain continuity (PG): constraint trigger ties prev_hash to the account's current head.
 *   chain continuity (MySQL): continuity check inside post_entry + REVOKE direct DML on legs.
 *   balance integrity (PG): trigger-maintained account_balances (= SUM(legs)).
 *   balance integrity (MySQL): trigger/proc-maintained account_balances + REVOKE direct DML on legs.
 *   overdraft (PG + MySQL): the user_account_non_negative CHECK rejects a negative user row.
 *   no-fork  (PG + MySQL): unique (account_id, prev_hash) rejects a second link at one point.
 *   exactly-once (PG + MySQL + memory): duplicate idempotency key / webhook event id rejected.
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

    // --- conservation: a leg set that does not sum to zero must be rejected -------------------
    // Enforced natively on both engines (PG: deferred constraint trigger on legs asserting sum=0
    // per currency at commit; MySQL: the assert inside post_entry, with direct DML on legs revoked
    // so the procedure is the only write door) → hard.
    test('conservation: a raw unbalanced leg is refused', async (t: TestContext) => {
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
      await assertRawRejected(
        live,
        'an unbalanced leg set (sum != 0 per currency)',
        `insert into legs (posting_id, account_id, currency, amount) values ('${txn}', '${account}', 'CREDIT', -500)`,
      );
    });

    // --- overdraft: a negative USER balance must be rejected; a system one is exempt ----------
    // Today: the user_account_non_negative CHECK already rejects this on both engines → hard.
    test('overdraft: a raw negative user balance is refused', async (t: TestContext) => {
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

    // The non-negative CHECK must exempt system accounts (several are negative by design). RECEIVABLE is
    // debit-normal, so a balanced credit drives its cached balance to -100 via real legs (conservation +
    // balance integrity both hold); only the non-negative rule is under test, and it must let this vrchat:%
    // system balance stand. A user account driven negative the same way is rejected — see the case above.
    test('overdraft: a legitimately negative SYSTEM balance is allowed (exempt)', async (t: TestContext) => {
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

    // --- chain continuity: no fork (two links at one point) and no discontinuity -------------
    // No-fork is enforced by unique (account_id, prev_hash) on both engines → hard today.
    test('continuity: a raw forked chain link (same prev_hash) is refused', async (t: TestContext) => {
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
      // claiming the same previous hash would fork the chain into two branches.
      let txn = `txn_adv_i3fork2_${userId}`;
      await live.raw(rawInsertPosting(txn));
      await assertRawRejected(
        live,
        'a second chain link at the same prev_hash (a fork)',
        `insert into chain_links (posting_id, account_id, prev_hash, hash) values ('${txn}', '${account}', '${GENESIS_HEX}', '${'f'.repeat(64)}')`,
      );
    });

    // Discontinuity (a link whose prev_hash is NOT the account's current head) is rejected natively
    // on both engines (PG: a constraint trigger asserting prev_hash = the account's current head;
    // MySQL: the same check inside post_entry, direct DML on chain_links revoked) → hard. The unique
    // index blocks a duplicate point; this trigger blocks a wrong one.
    test('continuity: a raw discontinuous chain link (wrong prev_hash) is refused', async (t: TestContext) => {
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
      await assertRawRejected(
        live,
        'a discontinuous chain link (prev_hash != current head)',
        `insert into chain_links (posting_id, account_id, prev_hash, hash) values ('${txn}', '${account}', '${bogusPrev}', '${'e'.repeat(64)}')`,
      );
    });

    // --- exactly-once: a duplicate idempotency key / webhook event id must be rejected --------
    // Enforced by the primary keys on idempotency and seen_webhooks on both engines → hard.
    test('exactly-once: a duplicate idempotency key is refused', async (t: TestContext) => {
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

    test('exactly-once: a duplicate webhook event id is refused', async (t: TestContext) => {
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

    // --- balance integrity: cached balance must equal SUM(legs) -------------------------------
    // Enforced natively on both engines: a trigger checks account_balances equals the signed sum of
    // the account's legs (PG and MySQL), so a hand-edited balance that drifts from the legs is
    // rejected → hard.
    test('balance integrity: a raw drifted balance (≠ SUM legs) is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let live = engine;
      let userId = `usr_adv_i5_${seq()}`;
      let account = spendable(userId);
      await fundSpendable(live.store, userId, '5.00', `txn_adv_i5_${userId}`);

      // Inflate the cached balance to a value the legs do not sum to (500 → 999), staying
      // non-negative so the overdraft CHECK can't be what rejects it; the balance-integrity trigger
      // is what must refuse this hand-edit.
      await assertRawRejected(
        live,
        'a cached balance that drifts from SUM(legs)',
        `update account_balances set balance = 999 where account_id = '${account}'`,
      );
    });
  });
}

runSqlAdversarial('postgres', adversarialPostgres);
runSqlAdversarial('mysql', adversarialMysql);

// ============================================================================
// The memory oracle. See the file header for why memory stays unenforced: the cases reach around
// the app through the lowest write door (`ledger.append`, which performs none of post_entry's
// checks) and the documented `__seedBalance` back door. Exactly-once IS real on memory: the
// idempotency and replay stores dedupe natively.
// ============================================================================
describe('Adversarial: memory (oracle)', () => {
  let oracle: AdversarialMemory;

  before(() => {
    oracle = adversarialMemory();
  });
  after(async () => {
    await oracle.close();
  });

  // conservation: append accepts an unbalanced posting (it does not run assertBalanced). Pending:
  // memory is the oracle and gets no engine enforcement; the SQL engines carry the conservation
  // worklist.
  test('conservation: append accepts an unbalanced posting', async (t: TestContext) => {
    let userId = `usr_mem_i1_${seq()}`;
    let account = spendable(userId);
    let amount = toAmount('CREDIT', 500n);

    let accepted = await oracle.store
      .transaction((unit: Unit) =>
        // one leg only — sum != 0. postEntry would throw; append does not check.
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
        'not enforced on memory: oracle only, no engine enforcement planned',
      );
      return;
    }
    assert.fail('memory unexpectedly rejected an unbalanced append');
  });

  // overdraft: __seedBalance plants a negative user balance with no guard. Pending for the same reason.
  test('overdraft: a seeded negative user balance is accepted', async (t: TestContext) => {
    let userId = `usr_mem_i2_${seq()}`;
    let account = spendable(userId);

    oracle.ledger.__seedBalance(account, toAmount('CREDIT', -100n));
    let stored = await oracle.store.ledger.balance(account);

    if (stored.minor < 0n) {
      t.todo(
        'not enforced on memory: oracle only, no engine enforcement planned',
      );
      return;
    }
    assert.fail('memory unexpectedly refused a negative seeded balance');
  });

  // chain continuity: memory's append AUTO-computes prev_hash from the current head, so there is no
  // path to write a fork or a discontinuous link through the lowest door. Pending/structural: the
  // oracle simply has no way to express the violation; the SQL engines carry the continuity worklist.
  test('continuity: append cannot express a discontinuous link', async (t: TestContext) => {
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
      'not enforced on memory: oracle only, append auto-computes prev_hash',
    );
  });

  // exactly-once IS real on memory: a second claim of a recorded key does not re-grant.
  test('exactly-once: a duplicate idempotency claim does not re-grant', async () => {
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

  // exactly-once IS real on memory: a redelivered webhook event id is not re-claimed.
  test('exactly-once: a duplicate webhook event id is not re-claimed', async () => {
    let eventId = `evt_mem_${seq()}`;
    let first = await oracle.store.replay.claim(eventId);
    let second = await oracle.store.replay.claim(eventId);
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
  });

  // balance integrity: __seedBalance plants a balance away from SUM(legs) (drift), which the oracle
  // keeps and the prover later reports. The store does not refuse it. Pending for the same reason.
  test('balance integrity: a seeded drifted balance is accepted', async (t: TestContext) => {
    let userId = `usr_mem_i5_${seq()}`;
    let account = spendable(userId);
    await fundSpendable(oracle.store, userId, '5.00', `txn_mem_i5_${userId}`);

    // Inflate the cached balance away from SUM(legs) (500 → 999), staying non-negative.
    oracle.ledger.__seedBalance(account, toAmount('CREDIT', 999n));
    let stored = await oracle.store.ledger.balance(account);

    if (stored.minor === 999n) {
      t.todo(
        'not enforced on memory: oracle only, no engine enforcement planned',
      );
      return;
    }
    assert.fail('memory unexpectedly refused a drifted seeded balance');
  });
});
