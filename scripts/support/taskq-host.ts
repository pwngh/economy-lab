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
// process. Off unless TASKQ_DATABASE_URL is set; the core never sees any of
// this — @pwngh/taskq stays a host concern, behind the same Dispatcher seam SQS and
// HTTP delivery use.

import type { Dispatcher, Logger } from '#src/ports.ts';

type Env = Record<string, string | undefined>;

export interface TaskqHost {
  dispatcher: Dispatcher;
  stop(): Promise<void>;
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
    options?: { key?: string },
  ): Promise<string | null>;
  startWorker(
    db: TaskqDb,
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

interface PgPoolLike extends TaskqDb {
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

// Imported only when the bridge is opted in, so the package stays an optional
// peer, the same way the engines load their drivers.
async function loadTaskq(): Promise<Taskq> {
  try {
    return (await import('@pwngh/taskq')) as Taskq;
  } catch (cause) {
    throw new Error(
      'TASKQ_DATABASE_URL is set but @pwngh/taskq is not installed; npm install @pwngh/taskq',
      { cause },
    );
  }
}

async function makePool(url: string): Promise<PgPoolLike> {
  // @ts-expect-error -- `pg` ships no types; typed at the binding via PgModule, the same pattern
  // src/engines/postgres.ts uses for its static import.
  const { default: pg } = (await import('pg')) as unknown as PgModule;
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Builds the bridge when TASKQ_DATABASE_URL opts in; resolves undefined when
 * it does not, and the worker runs exactly as before. An explicit opt-in with
 * the package missing fails loudly — a configured bridge that silently no-ops
 * would strand every relayed event.
 */
export async function maybeTaskqHost(
  env: Env,
  logger: Logger,
): Promise<TaskqHost | undefined> {
  const url = env.TASKQ_DATABASE_URL;
  if (url === undefined || url === '') {
    return undefined;
  }
  const taskq = await loadTaskq();
  const pool = await makePool(url);
  await taskq.createSchema(pool);
  await taskq.verifySchema(pool);

  const worker = taskq.startWorker(pool, {
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
    pollIntervalMs: Number(env.TASKQ_POLL_MS ?? 250),
    onError: (error, task) => {
      logger.log('error', 'taskq.worker_error', {
        error: error instanceof Error ? error.message : String(error),
        task: task?.id,
      });
    },
  });

  const dispatcher: Dispatcher = async (event) => {
    await taskq.enqueue(
      pool,
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

  logger.log('info', 'taskq.bridge_ready', { queue: 'economy.events' });
  return {
    dispatcher,
    stop: async () => {
      await worker.stop();
      await pool.end();
    },
  };
}
