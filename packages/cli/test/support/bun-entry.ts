/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { appendFileSync } from 'node:fs';

// `economy` run against a stand-in for Bun, so the bun leg's shutdown is observable under plain
// Node. The graceful stop here never settles — Bun's `stop()` with a request nobody will answer —
// so the run can only end by reaching the cut on its own.
const mark = (name: string): void => {
  appendFileSync(process.env.ECONOMY_STUB_LOG!, `${name} ${Date.now()}\n`);
};

(globalThis as { Bun?: unknown }).Bun = {
  serve: (options: { port: number }) => {
    // A listening Bun server holds the event loop open. Nothing else in this run does, and Node
    // answers an emptied loop under a pending top-level await with exit 13, mid-shutdown.
    const listening = setInterval(() => {}, 1 << 30);
    return {
      port: options.port,
      stop: (closeActiveConnections?: boolean) => {
        if (closeActiveConnections) {
          mark('cut');
          clearInterval(listening);
          return Promise.resolve();
        }
        mark('drain');
        return new Promise<void>(() => {});
      },
    };
  },
};

// The markers go to a file rather than a stream because the entry point below ends the run with
// process.exit, which can drop a pipe write that has not flushed.
await import('./entry.js');
