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
 * The sandbox's execution thread. The reader's edited snippet is type-stripped by Sucrase and
 * run against a fresh seeded engine with the page's journal replayed first — inside a Worker,
 * so runaway code (an infinite loop, a promise that never settles) can be terminate()d by the
 * sandbox document instead of freezing the page. Workers inherit the creating document's CSP,
 * which is how the eval grant reaches this thread and no other.
 */

import * as entry from '@pwngh/economy-lab';
import * as storeKit from '@pwngh/economy-lab/store-kit';

import { buildEngine } from '../../console/app/economy';
import { replayJournal } from '../../console/app/journal';

import type { Economy, Operation } from '@pwngh/economy-lab';
import type { JournalEntry } from '../../console/app/journal';
import type { SnippetReport } from '../app/snippets/context';
import type { RunRequest, SandboxResult } from './sandbox-protocol';

// Guarded so the runtime test harness can import execute() under node.
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = (event: MessageEvent) => {
    const request = event.data as RunRequest;
    if (request?.type !== 'run' || typeof request.code !== 'string') return;
    void execute(request.code, Array.isArray(request.journal) ? request.journal : []).then(
      (result) => {
        self.postMessage({ ...result, reqId: request.reqId });
      },
    );
  };
}

// The module map an edited snippet may import from. Anything else is refused with the reason —
// the same boundary check-samples enforces on the shipped files.
function importable(name: string): unknown {
  if (name === '@pwngh/economy-lab') return entry;
  if (name === '@pwngh/economy-lab/store-kit') return storeKit;
  if (name.endsWith('/context.ts') || name.endsWith('/context')) return {};
  throw new Error(
    `Cannot import "${name}" here — a snippet may import only what the published package exports.`,
  );
}

export async function execute(
  code: string,
  journal: JournalEntry[],
): Promise<Omit<SandboxResult, 'reqId'>> {
  const logs: string[] = [];
  const ops: Operation[] = [];
  try {
    const { transform } = await import('sucrase');
    const js = transform(code, { transforms: ['typescript', 'imports'] }).code;

    const eco = await buildEngine();
    await replayJournal(eco, journal);
    const live = eco.economy;
    const journaled: Economy = {
      ...live,
      submit(operation, options) {
        ops.push(operation);
        return live.submit(operation, options);
      },
    };

    const capture = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    const consoleProxy = { ...console, log: capture, info: capture, warn: capture, error: capture };
    const moduleObj = { exports: {} as Record<string, unknown> };
    // Function-constructor eval is this document's whole purpose; the CSP permits it here only.
    new Function('require', 'exports', 'module', 'console', js)(
      importable,
      moduleObj.exports,
      moduleObj,
      consoleProxy,
    );

    const run = moduleObj.exports.run;
    if (typeof run !== 'function') {
      throw new Error('The code must export an async function `run` — see the shipped snippet.');
    }
    const report = (await run(journaled)) as SnippetReport | undefined;
    return {
      lines: Array.isArray(report?.lines) ? report.lines.map(String) : [],
      logs,
      ops,
      journals: run.length > 0,
      txnId: typeof report?.txnId === 'string' ? report.txnId : undefined,
      consolePath: typeof report?.consolePath === 'string' ? report.consolePath : undefined,
    };
  } catch (error) {
    const fault =
      error instanceof entry.EconomyError
        ? `${error.code} — ${error.message}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    return { lines: [], logs, ops, error: fault };
  }
}
