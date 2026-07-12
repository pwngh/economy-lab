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

// The taskq bridge host, both halves: describeTaskq's selection rules as pure unit tests, and the
// bridge end to end against each live engine. The postgres leg opts in via TASKQ=1 + DATABASE_URL
// and the mysql leg via the TASKQ_DATABASE_URL override, so both mechanisms and both engines run.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { describeTaskq, maybeTaskqHost } from '#scripts/support/taskq-host.ts';
import { storeUrls } from '#src/env.ts';

import type { EconomyEvent, Logger } from '#src/ports.ts';

const { postgres: PG_URL, mysql: MYSQL_URL } = storeUrls(process.env);

// Absent the optional peer or the engine's URL, a live leg skips loudly rather than failing.
function packageMissing(): string | false {
  try {
    createRequire(import.meta.url).resolve('@pwngh/taskq/package.json');
    return false;
  } catch {
    return '@pwngh/taskq is not installed (optional peer)';
  }
}

// A Logger that records every line, so delivery is observed through the same event the real
// host logs (taskq.event_delivered) rather than through package internals.
function recordingLogger(): {
  logger: Logger;
  events: Array<{ event: string; fields: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return {
    logger: {
      log: (_level, event, fields) => void events.push({ event, fields }),
    },
    events,
  };
}

// One minimal outbox-shaped event with a per-run unique id: taskq dedupes pending tasks on the
// event id, so a stale pending row from an earlier crashed run must not absorb this run's task.
function sampleEvent(): EconomyEvent {
  return {
    id: `evt_host_${process.pid}_${Date.now().toString(36)}`,
    type: 'economy.credits.topped_up',
    version: 1,
    occurredAt: 0,
    subject: 'usr_taskq_host',
    data: {},
    audience: 'internal',
  };
}

const until = async (probe: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return probe();
};

// The whole loop the worker mode runs, minus the economy.
async function roundTrip(
  env: Record<string, string | undefined>,
): Promise<void> {
  const { logger, events } = recordingLogger();
  const host = await maybeTaskqHost({ ...env, TASKQ_POLL_MS: '50' }, logger);
  assert.notEqual(host, undefined);
  try {
    const event = sampleEvent();
    await host!.dispatcher(event);
    const delivered = await until(
      () =>
        events.some(
          (e) =>
            e.event === 'taskq.event_delivered' && e.fields.id === event.id,
        ),
      5_000,
    );
    assert.equal(delivered, true, 'the enqueued event was never delivered');
  } finally {
    await host!.stop();
  }
}

describe('describeTaskq selection rules', () => {
  test('off when neither the flag nor the override is set', () => {
    assert.deepEqual(describeTaskq({}), { kind: 'off' });
    assert.deepEqual(describeTaskq({ DATABASE_URL: 'postgres://x/db' }), {
      kind: 'off',
    });
  });

  test('TASKQ=1 follows the ledger, engine and database alike', () => {
    assert.deepEqual(
      describeTaskq({ TASKQ: '1', DATABASE_URL: 'postgres://x/db' }),
      { kind: 'taskq', engine: 'postgres', url: 'postgres://x/db' },
    );
    assert.deepEqual(
      describeTaskq({ TASKQ: '1', DATABASE_URL: 'mysql://x/db' }),
      { kind: 'taskq', engine: 'mysql', url: 'mysql://x/db' },
    );
  });

  test('the override opts in by itself and its scheme picks the engine', () => {
    assert.deepEqual(
      describeTaskq({ TASKQ_DATABASE_URL: 'mysql://elsewhere/q' }),
      { kind: 'taskq', engine: 'mysql', url: 'mysql://elsewhere/q' },
    );
  });

  test('a memory ledger with TASKQ=1 fails loudly instead of queueing nothing', () => {
    assert.throws(
      () => describeTaskq({ TASKQ: '1' }),
      /needs a database for the task table to live beside/,
    );
  });

  test('an override with an unsupported scheme fails loudly', () => {
    assert.throws(
      () => describeTaskq({ TASKQ_DATABASE_URL: 'redis://x' }),
      /postgres:\/\/ or mysql:\/\//,
    );
  });
});

describe('taskq bridge end to end', () => {
  const missing = packageMissing();

  test(
    'postgres: TASKQ=1 beside the ledger — enqueue via the dispatcher, worker delivers',
    { skip: missing || (PG_URL === null && 'no postgres URL configured') },
    async () => {
      await roundTrip({ TASKQ: '1', DATABASE_URL: PG_URL! });
    },
  );

  test(
    'mysql: TASKQ_DATABASE_URL override — the taskq/mysql engine round-trips the same way',
    { skip: missing || (MYSQL_URL === null && 'no MySQL URL configured') },
    async () => {
      await roundTrip({ TASKQ_DATABASE_URL: MYSQL_URL! });
    },
  );
});
