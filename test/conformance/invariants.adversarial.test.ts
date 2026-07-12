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
 * The thesis is that the SQL database is the system of record and must enforce the ledger
 * invariants natively. The only way to prove that is to attempt each violation directly. Each
 * case writes a raw, violating row around the app, bypassing `post_entry` on the SQL engines and
 * calling the lowest store method on the memory oracle, then asserts the engine rejects it. A
 * check that only the app performs is not enforcement, and this suite refuses to take the app's
 * word for it.
 *
 * The ordering rule is to add engine enforcement first, then prove it with an adversarial test
 * that writes the violation around the app, and only then delete the app-side duplicate. This
 * file was built as the keystone "prove it" step. The enforcement it called for has since landed,
 * so the file now holds the engine to account. It changes no enforcement. For each (invariant,
 * engine) pair it asserts that the violation is caught:
 *
 *   - On the SQL engines (postgres and mysql) every invariant below is a hard assertion: a raw
 *     violating row written around the app is rejected. I1 conservation, I3 chain continuity, and
 *     I5 balance integrity are enforced natively (mechanisms listed below), alongside exactly-once
 *     (idempotency and seen_webhooks primary keys), the no-fork unique index, and the non-negative
 *     CHECK on user balances.
 *   - The memory oracle has no native enforcement to attack, so its violation cases are recorded
 *     with a `t.todo(...)` that names what memory leaves to the SQL engines. A todo keeps the
 *     suite green while naming what the reference store cannot enforce.
 *
 * What is still pending:
 *   conservation, memory          oracle only: no engine enforcement is planned
 *   overdraft, memory             oracle only: no engine enforcement is planned
 *   chain continuity, memory      oracle only: append auto-computes prev_hash, so no fork path
 *   balance integrity, memory     oracle only: no engine enforcement is planned
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
import { makeEconomy } from '#test/support/economy.ts';

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

async function fundSpendable(
  store: Store,
  userId: string,
  dollars: string,
  txnId: string,
): Promise<void> {
  const amount = decodeAmount(dollars, 'CREDIT');
  await store.transaction((unit: Unit) =>
    postEntry(unit.ledger, {
      txnId,
      legs: [credit(spendable(userId), amount), debit(SYSTEM.REVENUE, amount)],
      meta: { source: 'card' },
    }),
  );
}

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

// Inserts a posting row directly — the parent row that every leg and chain_link references. The
// column list and literal are identical on both engines.
function rawInsertPosting(id: string): string {
  return `insert into postings (id, meta, posted_at) values ('${id}', '{}', 0)`;
}

// Builds SQL that inserts a duplicate idempotency row. `key` is a reserved word in MySQL and
// needs backticks, but it is plain in Postgres, so this picks the column spelling by engine.
function rawInsertIdempotency(engineName: string, key: string): string {
  const column = engineName === 'mysql' ? '`key`' : 'key';
  return `insert into idempotency (${column}, transaction) values ('${key}', '{}')`;
}

// Reads the head hash an account currently chains from. A continuous next link must carry this
// value as its prev_hash; returns genesis when the account has no link yet.
async function currentHead(store: Store, account: AccountRef): Promise<string> {
  for await (const [acct, head] of store.ledger.heads()) {
    if (acct === account) {
      return head;
    }
  }
  return GENESIS_HEX;
}

// ============================================================================
// The SQL matrix. Each engine is provisioned once. An unreachable engine yields null, and every
// case then skips rather than fails. This is the same contract the existing adapter suites use.
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
    // Enforced natively on both engines, so the assertion is hard. On Postgres a deferred
    // constraint trigger on legs asserts that the legs sum to zero per currency at commit. On
    // MySQL the assert lives inside post_entry, and direct DML on legs is revoked so the procedure
    // is the only write door.
    test('conservation: a raw unbalanced leg is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const userId = `usr_adv_i1_${seq()}`;
      const account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_i1_setup_${userId}`,
      );

      const txn = `txn_adv_i1_${userId}`;
      await live.raw(rawInsertPosting(txn));
      await assertRawRejected(
        live,
        'an unbalanced leg set (sum != 0 per currency)',
        `insert into legs (posting_id, account_id, currency, amount) values ('${txn}', '${account}', 'CREDIT', -500)`,
      );
    });

    // --- leg currency: a leg's currency must match its account's (composite FK) ----------------
    // Enforced natively. Postgres uses the composite FK legs(account_id, currency) ->
    // accounts(id, currency). MySQL uses the same FK plus revoked direct legs DML, so a raw write
    // is refused at the door, as in the conservation case. A balanced cross-currency pair passes
    // the per-currency conservation check, so the FK is the only thing that catches it. This makes
    // leg currency a distinct invariant from conservation.
    test('leg currency: a raw cross-currency leg pair is refused even though it conserves', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const userId = `usr_adv_legcur_${seq()}`;
      const account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_legcur_setup_${userId}`,
      );

      const txn = `txn_adv_legcur_${userId}`;
      await live.raw(rawInsertPosting(txn));
      await assertRawRejected(
        live,
        'a balanced cross-currency leg pair (USD legs on CREDIT accounts)',
        `insert into legs (posting_id, account_id, currency, amount) values ` +
          `('${txn}', '${account}', 'USD', 500), ('${txn}', '${SYSTEM.REVENUE}', 'USD', -500)`,
      );
    });

    // --- overdraft: a negative USER balance must be rejected; a system one is exempt ----------
    // The user_account_non_negative CHECK already rejects this on both engines, so the assertion
    // is hard.
    test('overdraft: a raw negative user balance is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const userId = `usr_adv_i2_${seq()}`;
      const account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_i2_setup_${userId}`,
      );

      // Drive the user's cached balance below zero around the app. The CHECK is the database's
      // half of the overdraft guard and must decline it regardless of how the row is written.
      await assertRawRejected(
        live,
        'a negative user-account balance',
        `update account_balances set balance = -100 where account_id = '${account}'`,
      );
    });

    // The non-negative CHECK must exempt system accounts, several of which are negative by design.
    // RECEIVABLE is debit-normal, so a balanced credit drives its cached balance to -100 through
    // real legs, and both conservation and balance integrity still hold. Only the non-negative rule
    // is under test here, and it must let this system balance stand. A user account driven negative
    // the same way is rejected, as shown in the case above.
    test('overdraft: a legitimately negative SYSTEM balance is allowed (exempt)', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const userId = `usr_adv_i2sys_${seq()}`;
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

      const rows = (await live.raw(
        `select balance from account_balances where account_id = '${SYSTEM.RECEIVABLE}'`,
      )) as Array<{ balance: bigint | number | string }>;
      assert.equal(rows.length, 1);
      assert.equal(BigInt(rows[0]!.balance), -100n);
    });

    // --- chain continuity: no fork (two links at one point) and no discontinuity -------------
    // No-fork is enforced by the unique index (account_id, prev_hash) on both engines, so the
    // assertion is hard.
    test('continuity: a raw forked chain link (same prev_hash) is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const userId = `usr_adv_i3fork_${seq()}`;
      const account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_i3fork_${userId}`,
      );

      // The funding posting already wrote one link from genesis for this account. A second link
      // claiming the same previous hash would fork the chain into two branches.
      const txn = `txn_adv_i3fork2_${userId}`;
      await live.raw(rawInsertPosting(txn));
      await assertRawRejected(
        live,
        'a second chain link at the same prev_hash (a fork)',
        `insert into chain_links (posting_id, account_id, prev_hash, hash) values ('${txn}', '${account}', '${GENESIS_HEX}', '${'f'.repeat(64)}')`,
      );
    });

    // Discontinuity is a link whose prev_hash is not the account's current head. It is rejected
    // natively on both engines, so the assertion is hard. On Postgres a constraint trigger asserts
    // that prev_hash equals the account's current head. On MySQL the same check lives inside
    // post_entry, with direct DML on chain_links revoked. The unique index blocks a duplicate
    // point, while this trigger blocks a wrong one.
    test('continuity: a raw discontinuous chain link (wrong prev_hash) is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const userId = `usr_adv_i3disc_${seq()}`;
      const account = spendable(userId);
      await fundSpendable(
        live.store,
        userId,
        '5.00',
        `txn_adv_i3disc_${userId}`,
      );

      const head = await currentHead(live.store, account);
      // A prev_hash that equals neither the current head nor any prior one, so the link is discontinuous.
      const bogusPrev = 'a'.repeat(64);
      assert.notEqual(bogusPrev, head);

      const txn = `txn_adv_i3disc2_${userId}`;
      await live.raw(rawInsertPosting(txn));
      await assertRawRejected(
        live,
        'a discontinuous chain link (prev_hash != current head)',
        `insert into chain_links (posting_id, account_id, prev_hash, hash) values ('${txn}', '${account}', '${bogusPrev}', '${'e'.repeat(64)}')`,
      );
    });

    // --- exactly-once: a duplicate idempotency key / webhook event id must be rejected --------
    // Enforced by the primary keys on idempotency and seen_webhooks on both engines, so the
    // assertion is hard.
    test('exactly-once: a duplicate idempotency key is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const key = `idem_adv_${seq()}`;
      const userId = `usr_adv_i4_${seq()}`;
      // Claim and record through the app so a committed primary-key row exists. On Postgres, claim
      // alone does not insert, because only record writes the row. The duplicate must therefore
      // collide with a recorded key, which is the genuine exactly-once scenario.
      await live.store.transaction(async (unit: Unit) => {
        const claim = await unit.idempotency.claim(key);
        assert.equal(claim.claimed, true);
        const txn = await postEntry(unit.ledger, {
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
      const live = engine;
      const eventId = `evt_adv_${seq()}`;
      // Record the first sighting through the app's replay store, which inserts the primary-key row.
      const first = await live.store.replay.claim(eventId);
      assert.equal(first.claimed, true);

      // A second row for the same event id, written around the app, must hit the primary key.
      await assertRawRejected(
        live,
        'a second seen_webhooks row for the same event id',
        `insert into seen_webhooks (event_id) values ('${eventId}')`,
      );
    });

    // --- balance integrity: cached balance must equal SUM(legs) -------------------------------
    // Enforced natively on both engines, so the assertion is hard. A trigger checks that
    // account_balances equals the signed sum of the account's legs on Postgres and MySQL alike, so
    // a hand-edited balance that drifts from the legs is rejected.
    test('balance integrity: a raw drifted balance (≠ SUM legs) is refused', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const userId = `usr_adv_i5_${seq()}`;
      const account = spendable(userId);
      await fundSpendable(live.store, userId, '5.00', `txn_adv_i5_${userId}`);

      // Inflate the cached balance to a value the legs do not sum to (500 to 999), staying
      // non-negative so the overdraft CHECK cannot be what rejects it. The balance-integrity
      // trigger is what must refuse this hand-edit.
      await assertRawRejected(
        live,
        'a cached balance that drifts from SUM(legs)',
        `update account_balances set balance = 999 where account_id = '${account}'`,
      );
    });

    test('outbox: markRelayed never resurrects a dead-lettered row', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const id = `obx_adv_dead_${name}`;
      // A poison message that is enqueued, then given up on. Dead-lettering sets its status to 'dead'.
      await live.store.transaction((unit: Unit) =>
        unit.outbox.enqueue({
          id,
          event: {
            id: `evt_${id}`,
            type: 'economy.test.dead',
            version: 1,
            occurredAt: 0,
            subject: 'usr_adv',
            data: {},
            audience: 'internal',
          },
          status: 'pending',
          attempts: 0,
          reason: null,
        }),
      );
      await live.store.outbox.deadLetter(id, 'poison');

      // A stale resend marks the row relayed. With markRelayed's `status = 'pending'` guard this is
      // a no-op. Without that guard the dead row is silently flipped to 'relayed' and the poison
      // event looks delivered. claimBatch never returns a terminal row, so read the status directly.
      await live.store.outbox.markRelayed([id]);
      const observed = (await live.raw(
        `select status from outbox where id = '${id}'`,
      )) as Array<{ status: string }>;
      assert.equal(
        observed[0]?.status,
        'dead',
        `${name}: markRelayed flipped a dead-lettered outbox row to '${String(observed[0]?.status)}' — a poison event must stay 'dead'`,
      );
    });

    test('idempotency: a rejected request leaves the key unused (no row)', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      const live = engine;
      const economy = makeEconomy(1, live.store);
      const key = `idem_adv_reject_${name}`;
      // A refund of an order that does not exist. The pipeline claims the key, then the handler
      // returns rejected(UNKNOWN_ORDER) with nothing posted. A rejected outcome rolls the
      // transaction back, so the key is left unused. MySQL's claim placeholder must not survive.
      // It once did, which diverged from Postgres, which holds a transaction advisory lock and
      // inserts no row at all.
      const outcome = await economy.submit({
        kind: 'refund',
        idempotencyKey: key,
        actor: { kind: 'system', service: 'support' },
        orderId: `no_such_order_${name}`,
        reason: 'adversarial',
      });
      assert.equal(outcome.status, 'rejected');

      // `key` is a reserved word on MySQL, so quote the column per engine.
      const keyCol = name === 'mysql' ? '`key`' : 'key';
      const counted = (await live.raw(
        `select count(*) as n from idempotency where ${keyCol} = '${key}'`,
      )) as Array<{ n: number | string }>;
      assert.equal(
        Number(counted[0]?.n),
        0,
        `${name}: a rejected request left an idempotency row for '${key}' — the key must stay unused`,
      );
    });
  });
}

runSqlAdversarial('postgres', () => adversarialPostgres(process.env));
runSqlAdversarial('mysql', () => adversarialMysql(process.env));

// ============================================================================
// The memory oracle. See the file header for why memory stays unenforced. These cases reach
// around the app through the lowest write door, `ledger.append`, which performs none of
// post_entry's checks, and through the documented `__seedBalance` back door. Exactly-once is real
// on memory, because the idempotency and replay stores dedupe natively.
// ============================================================================
describe('Adversarial: memory (oracle)', () => {
  let oracle: AdversarialMemory;

  before(() => {
    oracle = adversarialMemory();
  });
  after(async () => {
    await oracle.close();
  });

  // conservation: append accepts an unbalanced posting, because it does not run assertBalanced.
  // This stays pending: memory is the oracle and gets no engine enforcement, so the SQL engines
  // carry the conservation worklist.
  test('conservation: append accepts an unbalanced posting', async (t: TestContext) => {
    const userId = `usr_mem_i1_${seq()}`;
    const account = spendable(userId);
    const amount = toAmount('CREDIT', 500n);

    const accepted = await oracle.store
      .transaction((unit: Unit) =>
        // One leg only, so the sum is not zero. postEntry would throw, but append does not check.
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

  // overdraft: __seedBalance plants a negative user balance with no guard. This stays pending for
  // the same reason: memory is the oracle and gets no engine enforcement.
  test('overdraft: a seeded negative user balance is accepted', async (t: TestContext) => {
    const userId = `usr_mem_i2_${seq()}`;
    const account = spendable(userId);

    oracle.ledger.__seedBalance(account, toAmount('CREDIT', -100n));
    const stored = await oracle.store.ledger.balance(account);

    if (stored.minor < 0n) {
      t.todo(
        'not enforced on memory: oracle only, no engine enforcement planned',
      );
      return;
    }
    assert.fail('memory unexpectedly refused a negative seeded balance');
  });

  // chain continuity: memory's append auto-computes prev_hash from the current head, so there is
  // no path to write a fork or a discontinuous link through the lowest door. This is pending and
  // structural: the oracle simply has no way to express the violation, so the SQL engines carry
  // the continuity worklist.
  test('continuity: append cannot express a discontinuous link', async (t: TestContext) => {
    const userId = `usr_mem_i3_${seq()}`;
    const account = spendable(userId);
    const amount = toAmount('CREDIT', 500n);

    // Append a balanced posting. The store forces the link's prev_hash to GENESIS, not the caller.
    const txn = await oracle.store.transaction((unit: Unit) =>
      unit.ledger.append({
        txnId: `txn_mem_i3_${userId}`,
        legs: [
          { account, amount: toAmount('CREDIT', -amount.minor) },
          { account: SYSTEM.REVENUE, amount: toAmount('CREDIT', amount.minor) },
        ],
        meta: {},
      }),
    );
    const link = txn.links.find((candidate) => candidate.account === account);
    assert.notEqual(link, undefined);
    // The store computed prev_hash itself (GENESIS for a first link); the caller never supplied it.
    assert.equal(link!.prevHash, GENESIS_HEX);
    t.todo(
      'not enforced on memory: oracle only, append auto-computes prev_hash',
    );
  });

  // exactly-once is real on memory: a second claim of a recorded key does not re-grant.
  test('exactly-once: a duplicate idempotency claim does not re-grant', async () => {
    const key = `idem_mem_${seq()}`;
    const recorded = await oracle.store.transaction(async (unit: Unit) => {
      const claim = await unit.idempotency.claim(key);
      assert.equal(claim.claimed, true);
      const txn = await postEntry(unit.ledger, {
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

    const replay = await oracle.store.transaction((unit: Unit) =>
      unit.idempotency.claim(key),
    );
    assert.equal(replay.claimed, false);
    assert.deepEqual(
      (replay as { claimed: false; transaction: typeof recorded }).transaction,
      recorded,
    );
  });

  // exactly-once is real on memory: a redelivered webhook event id is not re-claimed.
  test('exactly-once: a duplicate webhook event id is not re-claimed', async () => {
    const eventId = `evt_mem_${seq()}`;
    const first = await oracle.store.replay.claim(eventId);
    const second = await oracle.store.replay.claim(eventId);
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
  });

  // balance integrity: __seedBalance plants a balance away from SUM(legs), a drift that the oracle
  // keeps and the prover later reports. The store does not refuse it. This stays pending for the
  // same reason: memory is the oracle and gets no engine enforcement.
  test('balance integrity: a seeded drifted balance is accepted', async (t: TestContext) => {
    const userId = `usr_mem_i5_${seq()}`;
    const account = spendable(userId);
    await fundSpendable(oracle.store, userId, '5.00', `txn_mem_i5_${userId}`);

    // Inflate the cached balance away from SUM(legs) (500 to 999), staying non-negative.
    oracle.ledger.__seedBalance(account, toAmount('CREDIT', 999n));
    const stored = await oracle.store.ledger.balance(account);

    if (stored.minor === 999n) {
      t.todo(
        'not enforced on memory: oracle only, no engine enforcement planned',
      );
      return;
    }
    assert.fail('memory unexpectedly refused a drifted seeded balance');
  });
});
