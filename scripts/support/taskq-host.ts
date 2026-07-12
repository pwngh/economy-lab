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

// Optional host-layer bridge to @pwngh/taskq: outbox events are enqueued as
// durable tasks (keyed by event id, so the relay's at-least-once collapses to
// exactly one pending task) and a @pwngh/taskq worker runs them in this
// process. The core never sees any of this — @pwngh/taskq stays a host
// concern, behind the same Dispatcher seam SQS and HTTP delivery use.
//
// The rule: data follows the ledger. TASKQ=1 opts in and puts the task table
// beside the ledger — the store's own database and engine (@pwngh/taskq for a
// postgres store, @pwngh/taskq/mysql for a mysql store) — which is what lets
// an enqueue share the ledger's transaction. TASKQ_DATABASE_URL both opts in
// and overrides the location for a split deployment; its scheme picks the
// engine. A memory ledger has no database for the table to live beside, so
// the flag without an override fails loudly at startup.

import { describeSelection } from '#src/index.ts';
import { openPgPool } from '#src/engines/pg-driver.ts';
import {
  isMysqlUrl,
  isPostgresUrl,
  readFlag,
  readInt,
  serviceUrls,
} from '#src/env.ts';

import type { EnvMap } from '#src/env.ts';
import type { Dispatcher, Logger } from '#src/ports.ts';

/**
 * Every name this host reads; .env.example is held to this list (TASKQ_DATABASE_URL is a service
 * URL, declared in src/env.ts).
 */
export const TASKQ_KEYS = ['TASKQ', 'TASKQ_POLL_MS'] as const;

export interface TaskqHost {
  dispatcher: Dispatcher;
  stop(): Promise<void>;
}

/** Which durable queue the env selects: off, or a taskq engine on a database. */
export type TaskqSelection =
  | { kind: 'off' }
  | { kind: 'taskq'; engine: 'postgres' | 'mysql'; url: string };

/**
 * The one reading of the queue selection — {@link maybeTaskqHost} wires exactly this, and the
 * startup `config.resolved` line prints it, so display can never diverge from the wiring.
 * Precedence: TASKQ_DATABASE_URL (opts in, overrides the location, scheme picks the engine),
 * else TASKQ=1 (the table lives beside the ledger), else off. Misconfigured opt-ins throw here,
 * so a bad queue config surfaces at startup, not at first delivery.
 */
export function describeTaskq(env: EnvMap): TaskqSelection {
  const override = serviceUrls(env).taskq;
  if (override !== null) {
    if (isPostgresUrl(override)) {
      return { kind: 'taskq', engine: 'postgres', url: override };
    }
    if (isMysqlUrl(override)) {
      return { kind: 'taskq', engine: 'mysql', url: override };
    }
    throw new Error(
      'TASKQ_DATABASE_URL must be a postgres:// or mysql:// DSN.',
    );
  }
  if (!readFlag(env.TASKQ)) {
    return { kind: 'off' };
  }
  const store = describeSelection(env).store;
  if (store.kind === 'postgres' || store.kind === 'mysql') {
    return { kind: 'taskq', engine: store.kind, url: store.url };
  }
  throw new Error(
    'TASKQ=1 needs a database for the task table to live beside: set a ' +
      'postgres:// or mysql:// DATABASE_URL, or point TASKQ_DATABASE_URL at one.',
  );
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

// The engine API both @pwngh/taskq entry points export identically; only the database handle
// differs (a pg pool vs a mysql2 pool), so it stays `unknown` here and each loader below pairs
// the module with the pool shape it expects.
interface Taskq {
  createSchema(db: unknown): Promise<void>;
  verifySchema(db: unknown): Promise<void>;
  enqueue(
    db: unknown,
    queue: string,
    payload: unknown,
    options?: { key?: string },
  ): Promise<string | null>;
  startWorker(
    db: unknown,
    options: {
      queues: Record<
        string,
        (task: TaskqTask, signal: AbortSignal) => Promise<void>
      >;
      pollIntervalMs?: number;
      onError?: (error: unknown, task?: TaskqTask) => void;
    },
  ): TaskqWorker;
}

// One ready engine: the taskq module for the selected engine plus the pool it runs on. Imported
// only when the bridge is opted in, so the package stays an optional peer, the same way the
// store engines load their drivers.
async function loadEngine(
  selection: Extract<TaskqSelection, { kind: 'taskq' }>,
): Promise<{ taskq: Taskq; db: unknown; end: () => Promise<void> }> {
  if (selection.engine === 'postgres') {
    const taskq = await importTaskq('@pwngh/taskq');
    const pool = await openPgPool({ connectionString: selection.url, max: 10 });
    return { taskq, db: pool, end: () => pool.end() };
  }
  const taskq = await importTaskq('@pwngh/taskq/mysql');
  // The engine's pool helper, so the queue's connection gets the same safe defaults as the store.
  const { createMysqlPool } = await import('#src/engines/mysql.ts');
  const pool = await createMysqlPool(selection.url);
  return { taskq, db: pool, end: () => pool.end() };
}

async function importTaskq(specifier: string): Promise<Taskq> {
  try {
    return (await import(specifier)) as Taskq;
  } catch (cause) {
    throw new Error(
      `the taskq bridge is enabled but ${specifier} cannot load; npm install @pwngh/taskq`,
      { cause },
    );
  }
}

/**
 * Builds the bridge when {@link describeTaskq} selects one; resolves undefined when the queue is
 * off, and the worker runs exactly as before. An explicit opt-in with the package missing or no
 * database to live beside fails loudly — a configured bridge that silently no-ops would strand
 * every relayed event.
 */
export async function maybeTaskqHost(
  env: EnvMap,
  logger: Logger,
): Promise<TaskqHost | undefined> {
  const selection = describeTaskq(env);
  if (selection.kind === 'off') {
    return undefined;
  }
  const { taskq, db, end } = await loadEngine(selection);
  await taskq.createSchema(db);
  await taskq.verifySchema(db);

  const worker = taskq.startWorker(db, {
    queues: {
      // The host's event consumer. Handlers must be idempotent (tasks deliver
      // at least once); the event id is the natural idempotency key. This
      // default just proves delivery — a deployment replaces it with real
      // work (mail, webhooks, projections) and adds queues beside it.
      'economy.events': async (task) => {
        const event = task.payload as { type?: string; subject?: string };
        logger.log('info', 'taskq.event_delivered', {
          id: task.key,
          type: event.type,
          subject: event.subject,
          attempt: task.attempt,
        });
      },
    },
    pollIntervalMs: readInt(env.TASKQ_POLL_MS, 250, { min: 1 }),
    onError: (error, task) => {
      logger.log('error', 'taskq.worker_error', {
        error: error instanceof Error ? error.message : String(error),
        task: task?.id,
      });
    },
  });

  const dispatcher: Dispatcher = async (event) => {
    await taskq.enqueue(
      db,
      'economy.events',
      {
        id: event.id,
        type: event.type,
        version: event.version,
        occurredAt: event.occurredAt,
        subject: event.subject,
        data: event.data,
        audience: event.audience,
      },
      { key: event.id },
    );
    worker.poke();
  };

  logger.log('info', 'taskq.bridge_ready', {
    queue: 'economy.events',
    engine: selection.engine,
  });
  return {
    dispatcher,
    stop: async () => {
      await worker.stop();
      await end();
    },
  };
}
