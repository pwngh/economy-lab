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
 * A worker process that is meant to be killed mid-work. It runs one real sweep against a store
 * served over HTTP by the test that spawned it, prints `DISPATCHING` the moment the work starts,
 * and then never returns. The parent reads that line and sends SIGKILL, which is the fault this
 * probe exists for: a delivery that takes the process down leaves no throw for the worker to
 * catch and no chance to record anything after the fact.
 *
 * Usage: `node test/support/kill-worker.ts <relay|inbox> <baseUrl> <cap>`.
 */

import process from 'node:process';

import { httpStore } from '#src/adapters/http.ts';
import { relayOutbox } from '#src/worker/relay.ts';
import { drainInbox } from '#src/worker/inbox.ts';
import { createEconomy } from '#src/economy.ts';
import { makePorts, testConfig } from '#test/support/capabilities.ts';

import type { Dispatcher } from '#src/ports.ts';

const [mode, baseUrl, cap] = process.argv.slice(2);
if (mode !== 'relay' && mode !== 'inbox') {
  throw new Error(`kill-worker: unknown mode ${String(mode)}`);
}
const attempts = Number(cap);

// A hang holds no handle of its own, and a Node process with an empty event loop exits 13 on an
// unsettled top-level await. This timer keeps the process alive so the only way it can end is the
// parent's signal, which is the whole point of the probe.
setInterval(() => {}, 1_000);

const store = httpStore({
  baseUrl,
  fetch: (request) => globalThis.fetch(request),
});
const ports = makePorts(store, {
  config: {
    ...testConfig(),
    maxOutboxAttempts: attempts,
    maxInboxAttempts: attempts,
  },
});

if (mode === 'relay') {
  // The dispatcher is the work, so hanging it is enough. The line tells the parent the delivery
  // has begun; nothing after the hang ever runs, because the parent kills the process here.
  const hang: Dispatcher = async () => {
    process.stdout.write('DISPATCHING\n');
    await new Promise<never>(() => {});
  };
  await relayOutbox(store, ports, { dispatcher: hang, limit: 10 });
} else {
  // The apply is a full economy submit, so the hang is planted in the parent instead: its bridge
  // stops answering once the drain reaches the ledger, and that unanswered request is also how the
  // parent knows the apply has begun.
  await drainInbox(store, ports, {
    economy: createEconomy(ports),
    now: 0,
    limit: 10,
  });
}
