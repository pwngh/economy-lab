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
 * seeded engine, replays the journal earlier runnable pages wrote, and runs the named snippet
 * against the real Economy — every submitted Operation recorded back to the journal, so the
 * console's replay lands on the very posting any snippet on any page created.
 */

import { EconomyError } from '@pwngh/economy-lab';

import { buildEngine } from '../../console/app/economy';
import { loadJournal, replayJournal, saveJournal } from '../../console/app/journal';
import { renderRun } from './render';

import type { Economy } from '@pwngh/economy-lab';
import type { ConsoleEngine } from '../../console/app/economy';
import type { JournalEntry } from '../../console/app/journal';
import type { SnippetReport } from '../app/snippets/context';

type SnippetRun = (economy: Economy) => Promise<SnippetReport>;

// A page's `data-snippet` name is its snippet's filename stem; the registry derives from the
// directory, so a new snippet file registers itself and cannot be forgotten. context.ts (no
// `run`) and the challenge answer keys are the deliberate exclusions; snippets.test.ts still
// walks the content tree and fails on a name that resolves to nothing here.
const MODULES = import.meta.glob<{ run?: SnippetRun }>('../app/snippets/*.ts', { eager: true });

export const SNIPPETS: Record<string, SnippetRun> = Object.fromEntries(
  Object.entries(MODULES).flatMap(([path, module]) => {
    if (path.endsWith('.solution.ts') || typeof module.run !== 'function') return [];
    const stem = path.slice(path.lastIndexOf('/') + 1, -'.ts'.length);
    return [[stem, module.run]];
  }),
);

let enginePromise: Promise<ConsoleEngine> | null = null;
let journal: JournalEntry[] = [];

// The workbench appends sandbox-run operations (or clears everything) behind this module's back;
// the next in-page run rebuilds from the saved journal so both paths see one economy. The guard
// keeps the module importable where there is no window (snippets.test.ts reads SNIPPETS).
if (typeof window !== 'undefined') {
  window.addEventListener('elab:journal-changed', () => {
    enginePromise = null;
  });
}

function engine(): Promise<ConsoleEngine> {
  enginePromise ??= buildEngine().then(async (eco) => {
    journal = loadJournal();
    try {
      await replayJournal(eco, journal);
    } catch {
      // A journal the engine refuses outright: start this page from the seed.
      journal = [];
    }
    return eco;
  });
  return enginePromise;
}

// The snippet's economy: the real one, with every submitted Operation recorded before it runs.
// A submit that faults stays recorded — replay skips it identically, posting nothing.
function journaling(eco: ConsoleEngine): Economy {
  const live = eco.economy;
  return {
    ...live,
    submit(operation, options) {
      journal.push(operation);
      return live.submit(operation, options);
    },
  };
}

export async function runSnippet(block: HTMLElement): Promise<void> {
  const name = block.dataset.snippet ?? '';
  const snippet = SNIPPETS[name];
  const out = block.querySelector<HTMLElement>('[data-out]');
  if (!out) return;
  if (!snippet) {
    // A name this build doesn't know is a wiring bug — say so rather than doing nothing.
    renderRun(out, {
      lines: [],
      fault: `no snippet registered as "${name}"`,
      ms: 0,
      added: 0,
      total: journal.length,
    });
    return;
  }

  const started = performance.now();
  const before = journal.length;
  let report: SnippetReport | null = null;
  let fault: string | null = null;
  try {
    report = await snippet(journaling(await engine()));
  } catch (error) {
    // The real failure, not a curtain: a fault names its code and message verbatim.
    fault =
      error instanceof EconomyError
        ? `${error.code} — ${error.message}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
  }
  const ms = Math.max(1, Math.round(performance.now() - started));
  saveJournal(journal);

  renderRun(out, {
    lines: report?.lines ?? [],
    fault: fault ?? undefined,
    txnId: report?.txnId,
    consolePath: report?.consolePath,
    ms,
    added: journal.length - before,
    total: journal.length,
  });
}
