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
 * The docs→console handoff journal. The docs runner records every `Operation` its snippets
 * submit and resumes from the journal on each page; the console replays them whole on a
 * ?from=docs entry. Both replay through `economy.submit` over the same seeded buildEngine, so
 * every engine-minted id comes out identical and an "open in the console" link stays true
 * across pages.
 */

import type { ConsoleEngine } from '~/economy';
import type { Operation } from '#src/contract.ts';

const JOURNAL_KEY = 'elab_journal';

// A version mismatch discards the journal rather than half-replaying it. Bump on any change to
// an entry's shape or a replayed call's meaning (v1 carried facade calls, not Operations).
const JOURNAL_VERSION = 2;

export type JournalEntry = Operation;

interface JournalEnvelope {
  v: number;
  entries: JournalEntry[];
}

// Amount.minor is a bigint, which JSON has no literal for; it crosses storage as a tagged string.
function encode(envelope: JournalEnvelope): string {
  return JSON.stringify(envelope, (_key, value: unknown) =>
    typeof value === 'bigint' ? { $bigint: value.toString() } : value,
  );
}

function decode(raw: string): JournalEnvelope {
  return JSON.parse(raw, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && '$bigint' in value) {
      return BigInt((value as { $bigint: string }).$bigint);
    }
    return value;
  }) as JournalEnvelope;
}

function opShaped(entry: unknown): entry is Operation {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { kind?: unknown }).kind === 'string' &&
    typeof (entry as { idempotencyKey?: unknown }).idempotencyKey === 'string'
  );
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
    const envelope = decode(raw);
    if (
      envelope.v !== JOURNAL_VERSION ||
      !Array.isArray(envelope.entries) ||
      !envelope.entries.every(opShaped)
    ) {
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
    localStorage.setItem(JOURNAL_KEY, encode({ v: JOURNAL_VERSION, entries }));
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

/**
 * Replay journaled operations into a fresh engine, in order. A submit that faults is skipped:
 * it posted nothing on the original run either, so skipping keeps the id stream aligned while
 * one bad entry can't cost the rest of the handoff.
 */
export async function replayJournal(
  eco: ConsoleEngine,
  entries: JournalEntry[],
): Promise<ConsoleEngine> {
  for (const operation of entries) {
    try {
      await eco.economy.submit(operation);
    } catch {
      // deterministic fault: replaying it would throw identically and post nothing
    }
  }
  return eco;
}
