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
import { run as challengeAuthorization } from '../app/snippets/challenge-authorization';
import { run as challengeIdempotency } from '../app/snippets/challenge-idempotency';
import { run as drain } from '../app/snippets/drain';
import { run as idempotency } from '../app/snippets/idempotency';
import { run as payout } from '../app/snippets/payout';
import { run as prove } from '../app/snippets/prove';
import { run as rejection } from '../app/snippets/rejection';
import { run as velocity } from '../app/snippets/velocity';
import { renderRun } from './render';

import type { Economy } from '@pwngh/economy-lab';
import type { ConsoleEngine } from '../../console/app/economy';
import type { JournalEntry } from '../../console/app/journal';
import type { SnippetReport } from '../app/snippets/context';

const SNIPPETS: Record<string, (economy: Economy) => Promise<SnippetReport>> = {
  idempotency,
  drain,
  prove,
  velocity,
  rejection,
  payout,
  'challenge-idempotency': challengeIdempotency,
  'challenge-authorization': challengeAuthorization,
};

let enginePromise: Promise<ConsoleEngine> | null = null;
let journal: JournalEntry[] = [];

// The workbench appends sandbox-run operations (or clears everything) behind this module's back;
// the next in-page run rebuilds from the saved journal so both paths see one economy.
window.addEventListener('elab:journal-changed', () => {
  enginePromise = null;
});

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
  if (!snippet || !out) return;

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
