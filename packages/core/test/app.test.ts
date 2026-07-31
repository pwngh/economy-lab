/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEconomy,
  credits,
  isRejection,
  memoryPorts,
  spendable,
  systemActor,
} from '@pwngh/economy-lab';
import { createApp } from '../src/app.js';
import { seedDemo } from '../src/dev.js';
import { withDev } from '../src/index.js';
import { topUp, idempotencyKey } from '../src/ops.js';

test('golden desugar seed: module-built ≡ hand-built floor across the package boundary', async () => {
  const app = await createApp(withDev({ authenticate: false, worker: false }), {
    env: {},
  });
  await seedDemo(app.economy);
  const doorBalance = await app.economy.read.balance(spendable('usr_ada'));

  const floor = createEconomy(memoryPorts({ signingKey: 'economy-dev' }));
  await seedDemo(floor);
  const floorBalance = await floor.read.balance(spendable('usr_ada'));

  assert.deepEqual(doorBalance, floorBalance);
  assert.deepEqual(
    doorBalance,
    credits(280),
    'the trio actually moved money: 400 in, 120 spent',
  );
  await app.close();
  await floor.close();
});

test('createApp constructs everything and starts nothing; close is ordered and idempotent', async () => {
  const app = await createApp(withDev({ authenticate: false }), { env: {} });
  assert.equal(typeof app.handler, 'function');
  assert.ok(app.worker, 'worker constructed by default');
  const { port } = await app.listen(0);
  assert.ok(port > 0);
  const first = app.close();
  assert.strictEqual(app.close(), first, 'close() latches');
  await first;
});

test('the outcome path holds through the door: idempotent replay, rejection as data', async () => {
  const app = await createApp(withDev({ authenticate: false, worker: false }), {
    env: {},
  });
  const op = () =>
    topUp({
      idempotencyKey: idempotencyKey('t', 'topup', '1'),
      actor: systemActor('test'),
      userId: 'usr_x',
      amount: credits(10),
      source: 'test',
    });
  const a = await app.economy.submit(op());
  const b = await app.economy.submit(op());
  assert.ok(
    !isRejection(a) && !isRejection(b),
    'replay is at-most-once, not a rejection',
  );
  assert.deepEqual(
    await app.economy.read.balance(spendable('usr_x')),
    credits(10),
  );
  await app.close();
});

test('no posture: in-process use is legal; the network face refuses (AUTH_POSTURE at listen)', async () => {
  const app = await createApp({ worker: false }, { env: {} });
  const ok = await app.economy.submit(
    topUp({
      idempotencyKey: idempotencyKey('t', 'auth', '1'),
      actor: systemActor('test'),
      userId: 'usr_a',
      amount: credits(5),
      source: 'test',
    }),
  );
  assert.ok(!isRejection(ok), 'the economy works without a network posture');
  const authPosture = (e: Error & { code?: string }) => {
    assert.equal(e.code, 'ECONOMY_MODULE.AUTH_POSTURE');
    assert.ok(e.message.includes('authenticate'));
    return true;
  };
  assert.throws(() => app.handler, authPosture);
  await assert.rejects(app.listen(0), authPosture);
  await app.close();
});

test('a policy that is not a config object refuses at boot, never runs on defaults', async () => {
  const configured = await createApp(
    { policy: { platformFeeBps: 250 }, authenticate: false, worker: false },
    { env: {} },
  );
  assert.equal(configured.ports.config.platformFeeBps, 250);
  await configured.close();

  // A factory is the shape `ports` refuses by name. Written on `policy` it used to resolve, and
  // spreading a function contributes nothing, so an economy configured at 250 bps charged the
  // built-in 1530 and said nothing. Every malformed shape has to refuse, not fall back.
  for (const policy of [
    () => ({ platformFeeBps: 250 }),
    '{"platformFeeBps":250}',
    42,
    [{ platformFeeBps: 250 }],
    null,
  ]) {
    await assert.rejects(
      createApp({ policy, authenticate: false, worker: false } as never, {
        env: {},
      }),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, 'ECONOMY_MODULE.SEAM_SHAPE');
        assert.ok(e.message.includes('policy'), 'names the seam');
        return true;
      },
    );
  }
});

test('lifecycle: double listen and listen after close both refuse', async () => {
  const app = await createApp(withDev({ authenticate: false, worker: false }), {
    env: {},
  });
  await app.listen(0);
  await assert.rejects(app.listen(0), (e: Error & { code?: string }) => {
    assert.equal(e.code, 'ECONOMY_MODULE.ALREADY_LISTENING');
    return true;
  });
  await app.close();
  await assert.rejects(app.listen(0), (e: Error & { code?: string }) => {
    assert.equal(e.code, 'ECONOMY_MODULE.LISTEN_AFTER_CLOSE');
    return true;
  });
});

test('lifecycle: a busy port rejects, concurrent listens race one winner, startWorker after close refuses', async () => {
  const app = await createApp(withDev({ authenticate: false, worker: false }), {
    env: {},
  });
  const { port } = await app.listen(0);
  const rival = await createApp(
    withDev({ authenticate: false, worker: false }),
    { env: {} },
  );
  await assert.rejects(rival.listen(port), (e: NodeJS.ErrnoException) => {
    assert.equal(
      e.code,
      'EADDRINUSE',
      'the bind failure surfaces instead of hanging',
    );
    return true;
  });
  const again = await rival.listen(0);
  assert.ok(again.port > 0, 'a failed bind releases the latch');
  await rival.close();
  await app.close();

  const racy = await createApp(
    withDev({ authenticate: false, worker: false }),
    { env: {} },
  );
  const [a, b] = await Promise.allSettled([racy.listen(0), racy.listen(0)]);
  const winners = [a, b].filter((r) => r.status === 'fulfilled');
  assert.equal(winners.length, 1, 'exactly one concurrent listen binds');
  const loser = [a, b].find(
    (r) => r.status === 'rejected',
  ) as PromiseRejectedResult;
  assert.match(String(loser.reason), /ALREADY_LISTENING/);
  await racy.close();

  const closed = await createApp(withDev({ authenticate: false }), { env: {} });
  await closed.close();
  assert.throws(
    () => closed.startWorker(),
    /LISTEN_AFTER_CLOSE/,
    'a closed app never starts timers against a closed store',
  );
});

test('listen() starts the background half; nothing ticks before it', async () => {
  let metered = 0;
  const meter = {
    count: () => {
      metered += 1;
    },
    observe: () => {
      metered += 1;
    },
  };
  const app = await createApp(
    { authenticate: false, ports: { meter }, worker: { intervalMs: 10 } },
    { env: {} },
  );
  const constructed = metered;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(
    metered,
    constructed,
    'constructed but unlistened: no sweep ran',
  );
  await app.listen(0);
  for (let i = 0; i < 100 && metered === constructed; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(metered > constructed, 'the worker timer rides listen()');
  await app.close();

  const api = await createApp(
    { authenticate: false, ports: { meter }, worker: { intervalMs: 10 } },
    { env: {}, worker: false },
  );
  assert.equal(
    api.worker,
    null,
    'the worker: false option is the API-process shape',
  );
  const bound = metered;
  await api.listen(0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(
    metered,
    bound,
    'an API-shape listen binds without background work',
  );
  await api.close();
});

test('ports overrides: one slot override is one line, compiled onto openPorts', async () => {
  const logger = { log: () => {} };
  const app = await createApp(
    { authenticate: false, worker: false, ports: { logger } },
    { env: {} },
  );
  assert.equal(app.ports.logger, logger, 'the override landed in the bag');
  await app.economy.submit(
    topUp({
      idempotencyKey: idempotencyKey('t', 'override', '1'),
      actor: systemActor('test'),
      userId: 'usr_o',
      amount: credits(5),
      source: 'test',
    }),
  );
  assert.deepEqual(
    await app.economy.read.balance(spendable('usr_o')),
    credits(5),
    'the rest of the bag still came from openPorts(env)',
  );
  await app.close();
});

// Knobs are read under the lab's integer rule. Each of these used to become the number on the
// left, and `WORKER_BATCH=0` was a worker that swept nothing.
test('an env knob the lab would refuse takes the default', async () => {
  const cases: [Record<string, string>, string, number][] = [
    [{ PORT: '8080.5' }, 'PORT', 3_000],
    [{ PORT: '0x1f' }, 'PORT', 3_000],
    [{ PORT: '1e4' }, 'PORT', 3_000],
    [{ PORT: '99999' }, 'PORT', 3_000],
    [{ PORT: '0' }, 'PORT', 3_000],
    [{ PORT: ' 8080 ' }, 'PORT', 3_000],
    [{ WORKER_BATCH: '0' }, 'WORKER_BATCH', 100],
    [{ WORKER_BATCH: '-5' }, 'WORKER_BATCH', 100],
    [{ WORKER_INTERVAL_MS: '1500.5' }, 'WORKER_INTERVAL_MS', 60_000],
  ];
  for (const [env, key, want] of cases) {
    const app = await createApp(withDev({ authenticate: false }), { env });
    const knob = app.config.find((k) => k.key === key)!;
    assert.deepEqual(
      { value: knob.value, source: knob.source },
      { value: want, source: 'default' },
      `${key}=${JSON.stringify(Object.values(env)[0])}`,
    );
    await app.close();
  }
  // A value the rule accepts still reads as env, so the gate is not simply always refusing.
  const good = await createApp(withDev({ authenticate: false }), {
    env: { WORKER_BATCH: '250' },
  });
  assert.deepEqual(
    good.config.find((k) => k.key === 'WORKER_BATCH'),
    { key: 'WORKER_BATCH', value: 250, source: 'env' },
  );
  await good.close();
});

test('knob provenance: definition > flag > env > default', async () => {
  const app = await createApp(
    withDev({ authenticate: false, worker: { intervalMs: 1_000 } }),
    {
      env: { WORKER_INTERVAL_MS: '9', WORKER_BATCH: '7' },
      flags: { WORKER_BATCH: 5 },
    },
  );
  const by = Object.fromEntries(app.config.map((k) => [k.key, k]));
  assert.deepEqual(by.WORKER_INTERVAL_MS, {
    key: 'WORKER_INTERVAL_MS',
    value: 1_000,
    source: 'definition',
  });
  assert.deepEqual(by.WORKER_BATCH, {
    key: 'WORKER_BATCH',
    value: 5,
    source: 'flag',
  });
  assert.deepEqual(by.SHUTDOWN_TIMEOUT_MS, {
    key: 'SHUTDOWN_TIMEOUT_MS',
    value: 5_000,
    source: 'default',
  });
  await app.close();
});

// Ownership follows creation. createApp opens the bag only when the caller supplies none, and
// close() releases exactly what it opened.
test('close() releases the bag createApp opened', async () => {
  let closed = 0;
  // No portsBag, so createApp ran openPorts itself and the bag is its own.
  const app = await createApp(
    { authenticate: false, worker: false },
    { env: {} },
  );
  const store = app.ports.store;
  const realClose = store.close.bind(store);
  (store as { close: () => Promise<void> }).close = async () => {
    closed += 1;
    await realClose();
  };

  await app.close();

  assert.equal(closed, 1, 'the app opened the bag, so the app closed it');
});

test('close() leaves a caller-supplied portsBag alone', async () => {
  const bag = memoryPorts({ signingKey: 'economy-dev' });
  let closed = 0;
  const ports = {
    ...bag,
    store: {
      ...bag.store,
      close: async () => {
        closed += 1;
      },
    },
    cache: {
      get: async () => null,
      set: async () => {},
      invalidate: async () => {},
      close: async () => {
        closed += 1;
      },
    },
  };
  const app = await createApp(
    { authenticate: false, worker: false },
    { env: {}, portsBag: ports },
  );

  await app.close();

  // Two ports declared close and neither ran: the caller built the bag, so the caller ends it.
  assert.equal(closed, 0, 'a bag the caller supplied is the caller’s to close');
  await app.economy.close();
  assert.equal(closed, 2, 'and the caller can still release it in one call');
});
