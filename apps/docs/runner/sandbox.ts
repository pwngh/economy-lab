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
 * The sandbox document: the one page whose CSP permits eval, and deliberately nothing more than
 * a relay with a kill switch. The reader's code executes in a Worker this document spawns (the
 * eval grant is inherited); a run that blows the watchdog gets its whole thread terminate()d —
 * an edited infinite loop costs one worker, never the page. Input arrives only by postMessage
 * from the embedding page on this origin — never from this document's URL, query, or fragment.
 */

import type { RunRequest, SandboxResult } from './sandbox-protocol';

// Generous: a first edited run loads Sucrase and boots the engine inside the worker.
const WATCHDOG_MS = 10_000;

let worker: Worker | null = null;

function workerInstance(): Worker {
  worker ??= new Worker(new URL('./sandbox-worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    const request = event.data as RunRequest;
    if (request?.type !== 'run' || typeof request.code !== 'string') return;

    const thread = workerInstance();
    const timer = setTimeout(() => {
      // Runaway code: kill the thread; the next run boots a fresh one.
      thread.terminate();
      worker = null;
      const timeout: SandboxResult = {
        reqId: request.reqId,
        lines: [],
        logs: [],
        ops: [],
        error: `Stopped after ${WATCHDOG_MS / 1000} s — an infinite loop, or a promise that never settles.`,
      };
      window.parent.postMessage(timeout, event.origin);
    }, WATCHDOG_MS);

    const relay = (message: MessageEvent) => {
      if ((message.data as SandboxResult)?.reqId !== request.reqId) return;
      clearTimeout(timer);
      thread.removeEventListener('message', relay);
      window.parent.postMessage(message.data, event.origin);
    };
    thread.addEventListener('message', relay);
    thread.postMessage(request);
  });
}
