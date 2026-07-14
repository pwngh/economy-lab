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
 * One sandbox economy per browser tab. The engine is built on first use and lives as long as the
 * tab; a reload starts a fresh seeded economy. No pool, no cookie, no eviction — the tab is the
 * session.
 */

import { buildEngine } from '~/economy';
import { clearJournal, loadJournal, replayJournal } from '~/journal';

import type { ConsoleEngine } from '~/economy';

export { clearJournal } from '~/journal';

// The handoff is opt-in by URL: only an entry marked ?from=docs replays the journal, once per
// document load (a reload replays it again over the fresh seed). A direct visit gets the
// pristine sandbox and leaves the journal for a later docs entry.
function fromDocs(): boolean {
  try {
    return new URLSearchParams(location.search).get('from') === 'docs';
  } catch {
    return false;
  }
}

// Replaying the docs journal (see ~/journal) makes this tab's economy the one the reader just
// drove — same ids and all, since both sides run the same seeded buildEngine.
async function replayDocsJournal(eco: ConsoleEngine): Promise<ConsoleEngine> {
  try {
    await replayJournal(eco, loadJournal());
  } catch {
    clearJournal(); // a journal the engine refuses must not brick the tab
  }
  return eco;
}

let engine: Promise<ConsoleEngine> | null = null;

export function getEngine(): Promise<ConsoleEngine> {
  if (engine === null) {
    const built = fromDocs()
      ? buildEngine().then(replayDocsJournal)
      : buildEngine();
    // A failed build must not stay cached, or the tab would be dead until a reload.
    built.catch(() => {
      engine = null;
    });
    engine = built;
  }
  return engine;
}
