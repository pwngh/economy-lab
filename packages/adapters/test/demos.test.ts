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
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { App } from '@pwngh/economy-core';
import { faceLegs, type Send } from './support/legs.js';

// Every demo builds its app from the environment, so the sweep cadence is set before the
// first import and the background half is observable inside one window.
process.env.WORKER_INTERVAL_MS = '10';

const DEMOS = fileURLToPath(new URL('../demos', import.meta.url));
const WINDOW_MS = 250;

type Demo = { readonly app: App; readonly default: unknown };

type Sweeper = { sweep: (request?: unknown) => Promise<unknown> };

/** The sweep the demo's own timer or cron drives, counted from the outside: the demo builds
 *  its app itself, so this is the seam a test can reach. */
function countSweeps(app: App): () => number {
  assert.ok(app.worker, 'the demo built a worker for its background half');
  let sweeps = 0;
  const worker = app.worker as unknown as Sweeper;
  const swept = worker.sweep.bind(worker);
  worker.sweep = (request?: unknown) => {
    sweeps += 1;
    return swept(request);
  };
  return () => sweeps;
}

const fetchOf = (demo: Demo): Send => {
  const shape = demo.default as { fetch: (r: Request) => Promise<Response> };
  return (path, init) => shape.fetch(new Request(`http://t${path}`, init));
};

/**
 * One row per runtime: how a request reaches it, and what runs its background half. The three
 * long-lived targets start it at mount; Workers have no process to hold a timer, so its own
 * `scheduled` export is the cron that stands in.
 */
const RUNTIMES: readonly {
  readonly name: string;
  send(demo: Demo): Send;
  background(demo: Demo): 'timer' | (() => Promise<void>);
}[] = [
  { name: 'bun', send: fetchOf, background: () => 'timer' },
  { name: 'hono', send: fetchOf, background: () => 'timer' },
  {
    name: 'next',
    send: (demo) => {
      const routes = demo as unknown as Record<
        string,
        (r: Request) => Promise<Response>
      >;
      return (path, init) =>
        routes[init?.method ?? 'GET']!(new Request(`http://t${path}`, init));
    },
    background: () => 'timer',
  },
  {
    name: 'cloudflare',
    send: fetchOf,
    background: (demo) => {
      const shape = demo.default as { scheduled: () => Promise<void> };
      return () => shape.scheduled();
    },
  },
];

const directories = readdirSync(DEMOS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

// A demo nobody drives is a snippet. The roster below is what actually ran, so a directory
// added without a row here fails rather than passing unexercised.
test('every demo directory is a runtime this file drives', () => {
  assert.deepEqual(
    RUNTIMES.map((r) => r.name).sort(),
    directories,
    `demos/ holds ${directories.length} directories`,
  );
});

for (const runtime of RUNTIMES) {
  test(`${runtime.name}: the face answers and the background half runs`, async () => {
    const demo = (await import(`../demos/${runtime.name}/index.js`)) as Demo;
    const sweeps = countSweeps(demo.app);
    try {
      await faceLegs(runtime.send(demo), runtime.name);
      const background = runtime.background(demo);
      if (background === 'timer') {
        await sleep(WINDOW_MS);
        assert.ok(
          sweeps() > 0,
          `${runtime.name}: mounted and swept ${sweeps()} times in ${WINDOW_MS}ms`,
        );
      } else {
        await sleep(WINDOW_MS);
        assert.equal(
          sweeps(),
          0,
          `${runtime.name}: no long-lived process, so nothing sweeps on its own`,
        );
        await background();
        assert.equal(sweeps(), 1, `${runtime.name}: the cron trigger swept`);
      }
    } finally {
      await demo.app.close();
    }
  });
}
