/**
 * @pwngh/economy-adapters
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
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { memoryPorts } from '@pwngh/economy-lab';
import type { Ports } from '@pwngh/economy-lab';
import { createApp, withDev } from '@pwngh/economy-core';
import type { App } from '@pwngh/economy-core';
import { economyExpress } from '../src/express.js';

// The worker's own batch heartbeat, at a tick fast enough to count inside one window.
const SWEEP_METRIC = 'worker.sweep';
const TICK_MS = 10;
const WINDOW_MS = 250;

interface Probe {
  readonly app: App;
  sweeps(): number;
  close(): Promise<void>;
}

/** An app over a ports bag whose meter counts the sweeps the background half emits. */
async function probeApp(): Promise<Probe> {
  const base = memoryPorts({ signingKey: 'lifecycle-probe' });
  let sweeps = 0;
  const ports: Ports = {
    ...base,
    meter: {
      count: (name, n, tags) => {
        if (name === SWEEP_METRIC) sweeps += 1;
        base.meter.count(name, n, tags);
      },
      observe: (name, value, tags) => base.meter.observe(name, value, tags),
    },
  };
  const app = await createApp(withDev({}), {
    env: {},
    portsBag: ports,
    flags: { WORKER_INTERVAL_MS: TICK_MS },
  });
  return {
    app,
    sweeps: () => sweeps,
    close: async () => {
      await app.close();
      await app.economy.close();
    },
  };
}

/** The documented Express recipe, over a real socket, and nothing else. */
async function serve(
  middleware: express.RequestHandler,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = express();
  server.use(middleware);
  const listening = server.listen(0, '127.0.0.1');
  await once(listening, 'listening');
  return {
    port: (listening.address() as AddressInfo).port,
    close: () => new Promise((done) => listening.close(() => done())),
  };
}

test('mounting an App on Express runs the background half', async () => {
  const probe = await probeApp();
  const mounted = economyExpress(probe.app);
  const server = await serve(mounted);
  try {
    assert.equal(
      (await fetch(`http://127.0.0.1:${server.port}/healthz`)).status,
      200,
      'the HTTP face answers',
    );
    await sleep(WINDOW_MS);
    assert.ok(
      probe.sweeps() > 0,
      `the mount swept ${probe.sweeps()} times in ${WINDOW_MS}ms — the economy behind it is dead`,
    );
  } finally {
    await server.close();
    await probe.close();
  }
});

test('{ worker: false } mounts the face alone, and startWorker() runs the rest', async () => {
  const probe = await probeApp();
  const mounted = economyExpress(probe.app, { worker: false });
  const server = await serve(mounted);
  try {
    await sleep(WINDOW_MS);
    assert.equal(
      probe.sweeps(),
      0,
      'the opt-out starts nothing: the worker role runs in another process',
    );
    probe.app.startWorker();
    await sleep(WINDOW_MS);
    assert.ok(
      probe.sweeps() > 0,
      `startWorker() swept ${probe.sweeps()} times in ${WINDOW_MS}ms`,
    );
  } finally {
    await server.close();
    await probe.close();
  }
});

test('a bare handler is mounted as given, and claims no lifecycle', async () => {
  const probe = await probeApp();
  const mounted = economyExpress((request) => probe.app.handler(request));
  const server = await serve(mounted);
  try {
    // The property is absent, not present and undefined: `close` in hand is the claim.
    assert.equal(
      'close' in mounted,
      false,
      'the caller kept the app, so the mount has nothing to close',
    );
    await sleep(WINDOW_MS);
    assert.equal(
      probe.sweeps(),
      0,
      'a handler carries no lifecycle for the mount to start',
    );
  } finally {
    await server.close();
    await probe.close();
  }
});

// The mistake the umbrella README's own naming invites: both snippets call the variable `app`,
// and the definition is an object with no handler on it.
test('a module definition is refused at mount, not on the first request', async () => {
  assert.throws(
    () => economyExpress({ authenticate: false, routes: {} } as never),
    (error: Error) =>
      error instanceof TypeError && error.message.includes('createApp()'),
  );
});
