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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeEconomy, economyWithStore } from '#test/support/economy.ts';
import { topUp, credit } from '#test/support/builders.ts';
import { spendable } from '#src/accounts.ts';
import { relayOutbox } from '#src/worker/relay.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  testConfig,
} from '#test/support/capabilities.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { Dispatcher, EconomyEvent } from '#src/ports.ts';

// Optional integration with the sibling @pwngh/taskq repo (a Postgres task queue whose enqueue can share
// a caller transaction). Nothing in the lab depends on it: this suite loads @pwngh/taskq by path from the
// sibling checkout and skips loudly when that checkout or a Postgres DATABASE_URL is absent. The
// pairing under test is guarantee composition — @pwngh/taskq delivers a task at least once, `submit`
// absorbs replays through the caller-owned idempotency key, so the ledger effect lands exactly
// once. @pwngh/taskq stays host-layer only; the Store port and the internal outbox are untouched.

const TASKQ_INDEX = new URL('../../../taskq/src/index.ts', import.meta.url);
const DB_URL = process.env.DATABASE_URL ?? '';

function skipReason(): string | false {
  if (!existsSync(fileURLToPath(TASKQ_INDEX))) {
    return 'sibling @pwngh/taskq checkout not found at ../../taskq';
  }
  if (!DB_URL.startsWith('postgres')) {
    return '@pwngh/taskq needs a postgres DATABASE_URL';
  }
  return false;
}

interface TaskqDb {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

interface TaskqTask {
  id: string;
  key: string | null;
  payload: unknown;
  attempt: number;
}

interface TaskqWorker {
  poke(): void;
  stop(): Promise<void>;
}

interface Taskq {
  createSchema(db: TaskqDb): Promise<void>;
  verifySchema(db: TaskqDb): Promise<void>;
  enqueue(
    db: TaskqDb,
    queue: string,
    payload: unknown,
    options?: { key?: string; maxAttempts?: number },
  ): Promise<string | null>;
  startWorker(
    db: TaskqDb,
    options: {
      queues: Record<
        string,
        (task: TaskqTask, signal: AbortSignal) => Promise<void>
      >;
      pollIntervalMs?: number;
      backoffBaseSeconds?: number;
      backoffCapSeconds?: number;
    },
  ): TaskqWorker;
}

interface PgClientLike extends TaskqDb {
  release(): void;
}

interface PgPoolLike extends TaskqDb {
  connect(): Promise<PgClientLike>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}

interface PgModule {
  default: {
    Pool: new (config: {
      connectionString: string;
      max?: number;
    }) => PgPoolLike;
  };
}

async function loadTaskq(): Promise<Taskq> {
  return (await import(TASKQ_INDEX.href)) as Taskq;
}

// Each run gets its own database because @pwngh/taskq's schema name is fixed. The admin connection is the
// lab's own DATABASE_URL, which has create-database rights in every dev and CI environment the lab
// tests run in.
async function taskqDatabase(): Promise<{
  pool: PgPoolLike;
  drop(): Promise<void>;
}> {
  // @ts-expect-error -- `pg` ships no types; typed at the binding via PgModule, the same pattern
  // src/engines/postgres.ts uses for its static import.
  const { default: pg } = (await import('pg')) as unknown as PgModule;
  const admin = new pg.Pool({ connectionString: DB_URL, max: 1 });
  admin.on('error', () => undefined);
  const name = `taskq_lab_it_${process.pid}`;
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  const url = new URL(DB_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  // pg's documented crash prevention: an idle client killed by the force-drop otherwise emits an
  // unhandled 'error' on the pool and takes the test process down.
  pool.on('error', () => undefined);
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The relay only reads logger, meter, and config; the full object matches the other worker tests.
function workerCtx(): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: testConfig(),
  };
}

async function drainTasks(pool: PgPoolLike): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const left = await pool.query('select count(*)::int as n from taskq.task');
    if (Number(left.rows[0]['n']) === 0) {
      return;
    }
    assert.ok(Date.now() < deadline, '@pwngh/taskq drain timed out');
    await pool.query(
      `update taskq.task set run_at = now() where state = 'ready'`,
    );
    await sleep(20);
  }
}

describe('taskq integration (optional sibling)', { skip: skipReason() }, () => {
  test('at-least-once delivery composes with submit idempotency into an exactly-once effect', async () => {
    const economy = makeEconomy();
    const taskq = await loadTaskq();
    const { pool, drop } = await taskqDatabase();
    try {
      await taskq.createSchema(pool);
      await taskq.verifySchema(pool);
      let attempts = 0;
      const worker = taskq.startWorker(pool, {
        queues: {
          'economy.topUp': async (task) => {
            attempts += 1;
            const payload = task.payload as { userId: string; amount: string };
            const operation = {
              ...topUp({
                userId: payload.userId,
                amount: credit(payload.amount),
              }),
              idempotencyKey: task.key ?? task.id,
            };
            await economy.submit(operation);
            // Crash after the ledger effect landed but before taskq records completion — failure
            // matrix row 4. The retry replays the same idempotency key and must be absorbed.
            if (task.attempt === 1) {
              throw new Error('crashed after the effect landed');
            }
          },
        },
        pollIntervalMs: 10,
        backoffBaseSeconds: 0.005,
        backoffCapSeconds: 0.02,
      });
      try {
        await taskq.enqueue(
          pool,
          'economy.topUp',
          { userId: 'usr_task', amount: '10.00' },
          { key: 'top_task_1' },
        );
        await drainTasks(pool);
      } finally {
        await worker.stop();
      }
      assert.equal(attempts, 2);
      const balance = await economy.read.balance(spendable('usr_task'));
      assert.deepEqual(balance, credit('10.00'));
    } finally {
      await drop();
    }
  });

  test('the outbox bridges into taskq: relay redelivery collapses to one task, handled once', async () => {
    // Atomic capture on any engine: the event is written inside the operation's transaction by
    // the store itself, the relay delivers it at least once, and taskq's pending-scoped dedup on
    // the event id turns that into exactly one pending task. The dispatcher is the whole bridge.
    const { economy, store } = economyWithStore();
    const taskq = await loadTaskq();
    const { pool, drop } = await taskqDatabase();
    try {
      await taskq.createSchema(pool);
      await taskq.verifySchema(pool);
      const delivered: EconomyEvent[] = [];
      const enqueued: (string | null)[] = [];
      const dispatcher: Dispatcher = async (event) => {
        delivered.push(event);
        enqueued.push(
          await taskq.enqueue(
            pool,
            'economy.events',
            { type: event.type, subject: event.subject },
            { key: event.id },
          ),
        );
      };

      await economy.submit(
        topUp({ userId: 'usr_evt', amount: credit('5.00') }),
      );
      await relayOutbox(store, workerCtx(), { dispatcher, limit: 10 });
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].type, 'economy.credits.topped_up');

      // A crashed relay redelivers; the bridge must absorb it. Replay the same event through the
      // dispatcher and the partial unique index answers with null instead of a second task.
      await dispatcher(delivered[0]);
      assert.notEqual(enqueued[0], null);
      assert.deepEqual(enqueued.slice(1), [null]);

      const handled: string[] = [];
      const worker = taskq.startWorker(pool, {
        queues: {
          'economy.events': async (task) => {
            handled.push((task.payload as { type: string }).type);
          },
        },
        pollIntervalMs: 10,
      });
      try {
        await drainTasks(pool);
      } finally {
        await worker.stop();
      }
      assert.deepEqual(handled, ['economy.credits.topped_up']);
    } finally {
      await drop();
    }
  });

  test('direct transactional enqueue: a host write and its task commit or vanish together', async () => {
    // The composable other half: when the host's own business write lives in the same Postgres
    // database taskq does, the enqueue is just another insert in that transaction — the outbox
    // pattern with no relay at all. Rollback erases both; commit lands both.
    const taskq = await loadTaskq();
    const { pool, drop } = await taskqDatabase();
    try {
      await taskq.createSchema(pool);
      await taskq.verifySchema(pool);
      await pool.query('create table host_orders (id text primary key)');

      const doomed = await pool.connect();
      try {
        await doomed.query('begin');
        await doomed.query(`insert into host_orders values ('ord_1')`);
        await taskq.enqueue(
          doomed,
          'order.followup',
          { orderId: 'ord_1' },
          { key: 'ord_1' },
        );
        await doomed.query('rollback');
      } finally {
        doomed.release();
      }
      const afterRollback = await pool.query(
        `select (select count(*) from host_orders)::int as orders,
                (select count(*) from taskq.task)::int as tasks`,
      );
      assert.deepEqual(afterRollback.rows[0], { orders: 0, tasks: 0 });

      const committed = await pool.connect();
      try {
        await committed.query('begin');
        await committed.query(`insert into host_orders values ('ord_2')`);
        await taskq.enqueue(
          committed,
          'order.followup',
          { orderId: 'ord_2' },
          { key: 'ord_2' },
        );
        await committed.query('commit');
      } finally {
        committed.release();
      }
      const afterCommit = await pool.query(
        `select (select count(*) from host_orders)::int as orders,
                (select count(*) from taskq.task)::int as tasks`,
      );
      assert.deepEqual(afterCommit.rows[0], { orders: 1, tasks: 1 });
    } finally {
      await drop();
    }
  });

  test('enqueue dedup extends the operation idempotency key one hop upstream', async () => {
    const taskq = await loadTaskq();
    const { pool, drop } = await taskqDatabase();
    try {
      await taskq.createSchema(pool);
      await taskq.verifySchema(pool);
      const first = await taskq.enqueue(
        pool,
        'economy.topUp',
        { userId: 'usr_task', amount: '10.00' },
        { key: 'op_key_1' },
      );
      const second = await taskq.enqueue(
        pool,
        'economy.topUp',
        { userId: 'usr_task', amount: '10.00' },
        { key: 'op_key_1' },
      );
      assert.notEqual(first, null);
      assert.equal(second, null);
      const rows = await pool.query(
        'select count(*)::int as n from taskq.task',
      );
      assert.equal(Number(rows.rows[0]['n']), 1);
    } finally {
      await drop();
    }
  });
});
