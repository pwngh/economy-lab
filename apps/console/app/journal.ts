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
 * The docs→console handoff journal. The docs runner records every facade call its snippets
 * make and resumes from the journal on each page; the console replays it whole on a ?from=docs
 * entry. Both replay over the same seeded buildEngine, so every engine-minted id comes out
 * identical and an "open in the console" link stays true across pages.
 */

import type { ConsoleEngine } from '~/economy';

const JOURNAL_KEY = 'elab_journal';

// A version mismatch discards the journal rather than half-replaying it. Bump on any change to
// an entry's shape or a replayed call's meaning.
const JOURNAL_VERSION = 1;

/**
 * The facade calls a journal may carry. This list is load-bearing for id determinism: it must
 * cover every id-consuming call a docs snippet makes, or replay skips an operation and every
 * engine-minted id after the gap diverges from what the docs page showed.
 */
export const REPLAYABLE = new Set([
  'deposit',
  'purchase',
  'drainWallet',
  'requestPayout',
  'setVelocityLimit',
]);

export interface JournalEntry {
  m: string;
  a: unknown[];
}

interface JournalEnvelope {
  v: number;
  entries: JournalEntry[];
}

/** The stored journal, or [] when absent, unreadable, or from another schema version. */
export function loadJournal(): JournalEntry[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(JOURNAL_KEY);
  } catch {
    return []; // no storage (tests, privacy mode)
  }
  if (raw === null) {
    return [];
  }
  try {
    const envelope = JSON.parse(raw) as JournalEnvelope;
    if (envelope.v !== JOURNAL_VERSION || !Array.isArray(envelope.entries)) {
      clearJournal();
      return [];
    }
    return envelope.entries;
  } catch {
    clearJournal(); // a corrupt journal must not brick the handoff
    return [];
  }
}

export function saveJournal(entries: JournalEntry[]): void {
  try {
    localStorage.setItem(
      JOURNAL_KEY,
      JSON.stringify({ v: JOURNAL_VERSION, entries }),
    );
  } catch {
    // Storage denied: the run still renders, only the console handoff is lost.
  }
}

// Reset and clear return the economy to its seed, so the docs handoff dies with the state it
// described.
export function clearJournal(): void {
  try {
    localStorage.removeItem(JOURNAL_KEY);
  } catch {
    // no storage: nothing to clear
  }
}

/** Replay journaled calls into a fresh engine, in order, skipping anything not REPLAYABLE. */
export async function replayJournal(
  eco: ConsoleEngine,
  entries: JournalEntry[],
): Promise<ConsoleEngine> {
  const facade = eco as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  for (const { m, a } of entries) {
    if (REPLAYABLE.has(m)) {
      await facade[m](...a);
    }
  }
  return eco;
}
