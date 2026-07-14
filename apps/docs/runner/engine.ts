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
 * The docs-side engine harness, loaded on the first Run click. It builds the console's own
 * seeded engine, replays the journal earlier runnable pages wrote, runs the named snippet, and
 * appends its calls back to the journal — so the console's replay lands on the very posting any
 * snippet on any page created.
 */

import { buildEngine } from '../../console/app/economy';
import { REPLAYABLE, loadJournal, replayJournal, saveJournal } from '../../console/app/journal';
import { run as drain } from '../app/snippets/drain';
import { run as idempotency } from '../app/snippets/idempotency';
import { run as payout } from '../app/snippets/payout';
import { run as prove } from '../app/snippets/prove';
import { run as rejection } from '../app/snippets/rejection';
import { run as velocity } from '../app/snippets/velocity';

import type { ConsoleEngine } from '../../console/app/economy';
import type { JournalEntry } from '../../console/app/journal';
import type { SnippetCtx, SnippetReport } from '../app/snippets/context';

const SNIPPETS: Record<string, (eco: SnippetCtx) => Promise<SnippetReport>> = {
  idempotency,
  drain,
  prove,
  velocity,
  rejection,
  payout,
};

let enginePromise: Promise<ConsoleEngine> | null = null;
let journal: JournalEntry[] = [];

function engine(): Promise<ConsoleEngine> {
  enginePromise ??= buildEngine().then(async (eco) => {
    journal = loadJournal();
    try {
      await replayJournal(eco, journal);
    } catch {
      // A journal the engine refuses (stale snippet surface): start this page from the seed.
      journal = [];
    }
    return eco;
  });
  return enginePromise;
}

// The snippet context: the real facade, with every replayable call recorded before it runs.
function journaling(eco: ConsoleEngine): SnippetCtx {
  return new Proxy<SnippetCtx>(eco, {
    get(target, prop: string) {
      const fn = (target as unknown as Record<string, unknown>)[prop];
      if (typeof fn !== 'function' || !REPLAYABLE.has(prop)) return fn;
      return (...args: unknown[]) => {
        journal.push({ m: prop, a: args });
        return (fn as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export async function runSnippet(block: HTMLElement): Promise<void> {
  const name = block.dataset.snippet ?? '';
  const snippet = SNIPPETS[name];
  const out = block.querySelector<HTMLElement>('[data-out]');
  if (!snippet || !out) return;

  const started = performance.now();
  const before = journal.length;
  const report = await snippet(journaling(await engine()));
  const ms = Math.max(1, Math.round(performance.now() - started));
  saveJournal(journal);
  const added = journal.length - before;

  out.textContent = '';
  for (const line of report.lines) {
    const div = document.createElement('div');
    div.className = 'runnable-line';
    div.textContent = line;
    out.appendChild(div);
  }

  const foot = document.createElement('div');
  foot.className = 'runnable-foot';
  const meta = document.createElement('span');
  meta.className = 'runnable-metaline';
  meta.textContent = `ran in ${ms} ms · ${added} operation${added === 1 ? '' : 's'} journaled (${journal.length} in the handoff)`;
  const link = document.createElement('a');
  link.className = 'runnable-jump';
  if (report.txnId) {
    link.href = `/console/ledger/txn/${encodeURIComponent(report.txnId)}?from=docs`;
    link.textContent = `open ${report.txnId} in the console`;
  } else {
    const path = report.consolePath ?? '/ledger';
    link.href = `/console${path}?from=docs`;
    link.textContent = `open ${path.replace('/', '')} in the console`;
  }
  foot.append(meta, link);
  out.appendChild(foot);
}
