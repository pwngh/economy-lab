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

import { compare, encodeAmount } from '#src/money.ts';
import { byCodeUnit } from '#src/bytes.ts';

import type { Amount } from '#src/money.ts';
import type { Range } from '#src/ports.ts';

/**
 * Distinguishes money in (a user buying credits) from money out (a payout). The two kinds
 * reconcile separately, so a buy never matches a payout.
 */
export type ReconcileKind = 'buy' | 'payout';

/**
 * Represents one settled event as the processor reports it, meaning money it says cleared.
 * The reconciler matches it against the ledger's record of the same event.
 */
export interface ProcessorRecord {
  kind: ReconcileKind;

  // The shared reference used to find this event's ledger counterpart. It is the provider
  // reference for a payout and the order or purchase reference for a buy. Both sides carry
  // the same value, and matching joins on it.
  matchKey: string;

  amount: Amount;
  providerRef: string;

  settledAt: number;
}

/**
 * Represents one settled event as recorded in our ledger, the counterpart to a
 * `ProcessorRecord`.
 */
export interface LedgerRecord {
  kind: ReconcileKind;

  matchKey: string;

  amount: Amount;
  txnId: string;

  postedAt: number;
}

/**
 * Names the ways the two sides can disagree.
 *
 * - processor_orphan: the processor cleared money with no matching ledger entry. Real money
 *   moved but nothing is on our books.
 * - ledger_orphan: a ledger entry the processor never cleared. This is either stuck money
 *   or an entry that should not exist.
 * - amount_drift: both sides exist for the event but the amounts differ.
 */
export type DiscrepancyKind =
  | 'processor_orphan'
  | 'ledger_orphan'
  | 'amount_drift';

/**
 * Describes one mismatch found. The amount fields are decimal strings such as
 * `'CREDIT:12.34'` rather than raw `bigint`, because `JSON.stringify` cannot serialize a
 * `bigint` but strings round-trip through JSON unchanged.
 *
 * Which amount fields are present depends on `kind`. A processor orphan has only
 * `processorAmount`, a ledger orphan has only `ledgerAmount`, and an amount drift has both.
 */
export interface Discrepancy {
  kind: DiscrepancyKind;

  matchKey: string;

  recordKind: ReconcileKind;

  processorAmount?: string;

  ledgerAmount?: string;
}

/**
 * Holds the result of reconciling one window. `discrepancies` lists every mismatch in
 * stable sorted order, so the same inputs always produce an identical report, and the count
 * fields summarize that list. `reconciled` is true when no mismatch was found.
 */
export interface ReconcileReport {
  window: Range;

  reconciled: boolean;

  matched: number;

  processorCount: number;

  ledgerCount: number;

  processorOrphans: number;

  ledgerOrphans: number;

  amountDrifts: number;

  discrepancies: ReadonlyArray<Discrepancy>;
}

export interface ReconcileInputs {
  processor: ReadonlyArray<ProcessorRecord>;

  ledger: ReadonlyArray<LedgerRecord>;
}

/**
 * Compares processor records against ledger records for one window and reports mismatches. The
 * caller may over-supply; only records inside the half-open window count (a record exactly on `to`
 * belongs to the next window). Two records match on the same kind and matchKey. Every record must be
 * accounted for exactly once and the reconciler must not drop one, so `report` self-checks
 * that the counts reconstruct both sides.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how reconciliation runs on a schedule.
 */
export function reconcile(
  window: Range,
  inputs: ReconcileInputs,
): ReconcileReport {
  const processor = withinWindow(inputs.processor, window, (r) => r.settledAt);
  const ledger = withinWindow(inputs.ledger, window, (r) => r.postedAt);

  const match = matchSides(processor, ledger);

  return report(window, processor, ledger, match);
}

type Match = { matched: number; discrepancies: Discrepancy[] };

function matchSides(
  processor: ReadonlyArray<ProcessorRecord>,
  ledger: ReadonlyArray<LedgerRecord>,
): Match {
  const ledgerByKey = indexByKey(ledger);
  const discrepancies: Discrepancy[] = [];
  const matched = matchProcessorSide(processor, ledgerByKey, discrepancies);
  collectLedgerOrphans(ledgerByKey, discrepancies);
  return { matched, discrepancies };
}

// Pairs each processor record with one ledger counterpart and consumes it from that key's
// bucket, oldest-first, so a ledger record matches at most one processor record. A missing
// bucket, or one already emptied, means a processor record the ledger never recorded: a
// processor orphan. Whatever stays in the buckets afterward is ledger records with no
// processor counterpart, which the next pass reports as ledger orphans.
function matchProcessorSide(
  processor: ReadonlyArray<ProcessorRecord>,
  ledgerByKey: Map<string, LedgerRecord[]>,
  discrepancies: Discrepancy[],
): number {
  let matched = 0;
  for (const record of processor) {
    const key = keyOf(record.kind, record.matchKey);
    const counterpart = ledgerByKey.get(key)?.shift();
    if (counterpart === undefined) {
      discrepancies.push(processorOrphan(record));
      continue;
    }
    if (sameAmount(record.amount, counterpart.amount)) {
      matched += 1;
    } else {
      discrepancies.push(amountDrift(record, counterpart));
    }
  }
  return matched;
}

// Turns the ledger records left unmatched in the buckets into ledger orphans, meaning every
// record no processor match consumed. Buckets keep first-seen order within a key and
// insertion order across keys, both of which ECMAScript guarantees for a Map, so this pass
// is deterministic. The report's final sort settles cross-key order, and same-key
// duplicates keep the original order they have here.
function collectLedgerOrphans(
  remaining: Map<string, LedgerRecord[]>,
  discrepancies: Discrepancy[],
): void {
  for (const bucket of remaining.values()) {
    for (const record of bucket) {
      discrepancies.push(ledgerOrphan(record));
    }
  }
}

function report(
  window: Range,
  processor: ReadonlyArray<ProcessorRecord>,
  ledger: ReadonlyArray<LedgerRecord>,
  match: Match,
): ReconcileReport {
  const sorted = [...match.discrepancies].sort(byDiscrepancy);
  const processorOrphans = countKind(sorted, 'processor_orphan');
  const ledgerOrphans = countKind(sorted, 'ledger_orphan');
  const amountDrifts = countKind(sorted, 'amount_drift');
  assertAccountedFor({
    matched: match.matched,
    amountDrifts,
    processorOrphans,
    ledgerOrphans,
    processorCount: processor.length,
    ledgerCount: ledger.length,
  });
  return {
    window,
    reconciled: sorted.length === 0,
    matched: match.matched,
    processorCount: processor.length,
    ledgerCount: ledger.length,
    processorOrphans,
    ledgerOrphans,
    amountDrifts,
    discrepancies: sorted,
  };
}

// Every record on each side must be accounted for exactly once. A match and an amount drift
// each consume one record from BOTH sides (a paired processor and ledger record). A
// processor orphan is an unpaired processor record, and a ledger orphan is an unpaired
// ledger record. Both sides must therefore reconstruct: matched + drifts + processorOrphans
// === processorCount, and the same for the ledger. If either check fails, the matcher
// dropped or double-counted a record and the report cannot be trusted. Throwing here is
// safer than returning a wrong reconciliation. The equality holds by construction today, and
// this is the regression guard that keeps it so.
function assertAccountedFor(counts: {
  matched: number;
  amountDrifts: number;
  processorOrphans: number;
  ledgerOrphans: number;
  processorCount: number;
  ledgerCount: number;
}): void {
  const processorSeen =
    counts.matched + counts.amountDrifts + counts.processorOrphans;
  const ledgerSeen =
    counts.matched + counts.amountDrifts + counts.ledgerOrphans;
  if (
    processorSeen !== counts.processorCount ||
    ledgerSeen !== counts.ledgerCount
  ) {
    throw new Error(
      `reconcile: internal accounting mismatch — processor ${processorSeen}/${counts.processorCount}, ` +
        `ledger ${ledgerSeen}/${counts.ledgerCount} (matched=${counts.matched}, drifts=${counts.amountDrifts}, ` +
        `processorOrphans=${counts.processorOrphans}, ledgerOrphans=${counts.ledgerOrphans})`,
    );
  }
}

// --- Matching primitives ----------------------------------------------------------

// Keeps only records whose timestamp falls in the window. `at` pulls the timestamp out,
// which is settledAt for a processor record and postedAt for a ledger record. The window is
// half-open: `from` is in and `to` is out and belongs to the next window, so adjacent
// windows never both claim a record.
function withinWindow<T>(
  records: ReadonlyArray<T>,
  window: Range,
  at: (record: T) => number,
): ReadonlyArray<T> {
  return records.filter((record) => {
    const when = at(record);
    return when >= window.from && when < window.to;
  });
}

// Buckets the ledger records by key, keeping EVERY record per key in first-seen order.
// matchKey is meant to be a unique join reference, so a repeated key should not occur and is
// the kind of mismatch the reconciler catches. A repeated key keeps all its records, so
// matchProcessorSide pairs each with a distinct processor record and any surplus still
// surfaces as a ledger orphan. No record is dropped.
function indexByKey(
  ledger: ReadonlyArray<LedgerRecord>,
): Map<string, LedgerRecord[]> {
  const index = new Map<string, LedgerRecord[]>();
  for (const record of ledger) {
    const key = keyOf(record.kind, record.matchKey);
    const bucket = index.get(key);
    if (bucket === undefined) {
      index.set(key, [record]);
    } else {
      bucket.push(record);
    }
  }
  return index;
}

function keyOf(kind: ReconcileKind, matchKey: string): string {
  return `${kind}:${matchKey}`;
}

// Returns true when the amounts are exactly equal: the same currency and the same value to
// the smallest unit, with no tolerance. Currency is checked first because `compare` throws
// on mismatched currencies. Checking it here reports a currency mismatch as drift instead of
// crashing.
function sameAmount(a: Amount, b: Amount): boolean {
  if (a.currency !== b.currency) {
    return false;
  }
  return compare(a, b) === 0;
}

// --- Discrepancy constructors -----------------------------------------------------

function processorOrphan(record: ProcessorRecord): Discrepancy {
  return {
    kind: 'processor_orphan',
    matchKey: record.matchKey,
    recordKind: record.kind,
    processorAmount: encodeAmount(record.amount),
  };
}

function ledgerOrphan(record: LedgerRecord): Discrepancy {
  return {
    kind: 'ledger_orphan',
    matchKey: record.matchKey,
    recordKind: record.kind,
    ledgerAmount: encodeAmount(record.amount),
  };
}

function amountDrift(
  processor: ProcessorRecord,
  ledger: LedgerRecord,
): Discrepancy {
  return {
    kind: 'amount_drift',
    matchKey: processor.matchKey,
    recordKind: processor.kind,
    processorAmount: encodeAmount(processor.amount),
    ledgerAmount: encodeAmount(ledger.amount),
  };
}

// --- Deterministic ordering -------------------------------------------------------

function countKind(
  discrepancies: ReadonlyArray<Discrepancy>,
  kind: DiscrepancyKind,
): number {
  let n = 0;
  for (const discrepancy of discrepancies) {
    if (discrepancy.kind === kind) {
      n += 1;
    }
  }
  return n;
}

// Sorts by kind, then match key, then record kind, for a stable report. It compares by
// character code (see byCodeUnit) rather than `localeCompare`, whose order varies across
// runtimes and locales.
function byDiscrepancy(a: Discrepancy, b: Discrepancy): number {
  return (
    byCodeUnit(a.kind, b.kind) ||
    byCodeUnit(a.matchKey, b.matchKey) ||
    byCodeUnit(a.recordKind, b.recordKind)
  );
}
