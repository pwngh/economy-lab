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
 * Money in (a user buying credits) or money out (a payout). Reconciled separately, so a
 * buy never matches a payout.
 */
export type ReconcileKind = 'buy' | 'payout';

/**
 * One settled event as the processor reports it (money it says cleared). Matched against
 * the ledger's records of the same events.
 */
export interface ProcessorRecord {
  kind: ReconcileKind;

  // Shared reference used to find this event's ledger counterpart: provider ref for a
  // payout, order/purchase ref for a buy. Both sides carry the same value; matching joins
  // on it.
  matchKey: string;

  amount: Amount;
  providerRef: string;

  // When the processor cleared this event (epoch ms). The window filter compares against
  // this.
  settledAt: number;
}

/**
 * One settled event as recorded in our ledger, the counterpart to a `ProcessorRecord`.
 */
export interface LedgerRecord {
  kind: ReconcileKind;

  // Same shared reference the processor carries, so the two records join on it. (Copied
  // in from the event when the ledger entry is written.)
  matchKey: string;

  amount: Amount;
  txnId: string;

  // When this entry was committed to the ledger (epoch ms). The window filter compares
  // against this.
  postedAt: number;
}

/**
 * Ways the two sides can disagree:
 *
 * - processor_orphan: processor cleared money with no matching ledger entry (dangerous:
 *   real money moved, nothing on our books).
 * - ledger_orphan: ledger entry the processor never cleared (stuck money, or an entry
 *   that should not exist).
 * - amount_drift: both sides exist for the event but the amounts differ.
 */
export type DiscrepancyKind =
  | 'processor_orphan'
  | 'ledger_orphan'
  | 'amount_drift';

/**
 * One mismatch found. Amount fields are decimal strings (e.g. `'CREDIT:12.34'`) not raw
 * `bigint`, since `JSON.stringify` can't serialize a `bigint`; strings round-trip through
 * JSON unchanged.
 *
 * Which amount fields are present depends on `kind`: processor orphan has only
 * `processorAmount`, ledger orphan only `ledgerAmount`, amount drift has both.
 */
export interface Discrepancy {
  kind: DiscrepancyKind;

  matchKey: string;

  recordKind: ReconcileKind;

  processorAmount?: string;

  ledgerAmount?: string;
}

/**
 * Result of reconciling one window. `discrepancies` lists every mismatch in stable sorted
 * order (same inputs → identical report); the count fields summarize it. `reconciled` is
 * true when no mismatch was found.
 */
export interface ReconcileReport {
  // The time window that was reconciled.
  window: Range;

  // True when no discrepancies were found.
  reconciled: boolean;

  // How many events matched on both sides with equal amounts.
  matched: number;

  // How many records each side contributed within the window.
  processorCount: number;

  ledgerCount: number;

  // Counts per discrepancy kind (see DiscrepancyKind), summarizing the list below.
  processorOrphans: number;

  ledgerOrphans: number;

  amountDrifts: number;

  discrepancies: ReadonlyArray<Discrepancy>;
}

/** The two sides to compare: the processor's settled records and the ledger's own records. */
export interface ReconcileInputs {
  processor: ReadonlyArray<ProcessorRecord>;

  ledger: ReadonlyArray<LedgerRecord>;
}

/**
 * Compare processor records against ledger records for one window and report mismatches.
 *
 * Only records inside the window count, so the caller can over-supply and let this filter.
 * Half-open window: a record exactly on `to` belongs to the next window.
 *
 * Two records match on same kind (buy/payout) and same matchKey. If two records on one
 * side share a key (shouldn't happen), only the first matches; later duplicates are
 * reported as orphans on their own side.
 */
export function reconcile(
  window: Range,
  inputs: ReconcileInputs,
): ReconcileReport {
  let processor = withinWindow(inputs.processor, window, (r) => r.settledAt);
  let ledger = withinWindow(inputs.ledger, window, (r) => r.postedAt);

  let match = matchSides(processor, ledger);

  return report(window, processor, ledger, match);
}

// Intermediate match result. Discrepancies are in discovery order; `report` sorts them
// into the final stable order.
type Match = { matched: number; discrepancies: Discrepancy[] };

function matchSides(
  processor: ReadonlyArray<ProcessorRecord>,
  ledger: ReadonlyArray<LedgerRecord>,
): Match {
  let ledgerByKey = indexByKey(ledger);
  let discrepancies: Discrepancy[] = [];
  let matched = matchProcessorSide(processor, ledgerByKey, discrepancies);
  collectLedgerOrphans(ledger, ledgerByKey, discrepancies);
  return { matched, discrepancies };
}

// Find each processor record's ledger counterpart in the index, removing matches as we
// go. Whatever remains in the index afterward is the ledger records with no processor
// counterpart, which the next pass reports as ledger orphans.
function matchProcessorSide(
  processor: ReadonlyArray<ProcessorRecord>,
  ledgerByKey: Map<string, LedgerRecord>,
  discrepancies: Discrepancy[],
): number {
  let matched = 0;
  for (let record of processor) {
    let key = keyOf(record.kind, record.matchKey);
    let counterpart = ledgerByKey.get(key);
    if (counterpart === undefined) {
      discrepancies.push(processorOrphan(record));
      continue;
    }
    ledgerByKey.delete(key);
    if (sameAmount(record.amount, counterpart.amount)) {
      matched += 1;
    } else {
      discrepancies.push(amountDrift(record, counterpart));
    }
  }
  return matched;
}

// Turn the ledger records left in the index into ledger orphans. Iterates the original
// ledger list, not the Map, so order doesn't depend on Map iteration across runtimes.
// (Sorted again later, but this keeps it predictable beforehand.)
function collectLedgerOrphans(
  ledger: ReadonlyArray<LedgerRecord>,
  remaining: Map<string, LedgerRecord>,
  discrepancies: Discrepancy[],
): void {
  for (let record of ledger) {
    let key = keyOf(record.kind, record.matchKey);
    if (remaining.has(key)) {
      remaining.delete(key);
      discrepancies.push(ledgerOrphan(record));
    }
  }
}

// Sort discrepancies into stable order and assemble the report. Counts are computed from
// that same sorted list, so they can't disagree with it.
function report(
  window: Range,
  processor: ReadonlyArray<ProcessorRecord>,
  ledger: ReadonlyArray<LedgerRecord>,
  match: Match,
): ReconcileReport {
  let sorted = [...match.discrepancies].sort(byDiscrepancy);
  return {
    window,
    reconciled: sorted.length === 0,
    matched: match.matched,
    processorCount: processor.length,
    ledgerCount: ledger.length,
    processorOrphans: countKind(sorted, 'processor_orphan'),
    ledgerOrphans: countKind(sorted, 'ledger_orphan'),
    amountDrifts: countKind(sorted, 'amount_drift'),
    discrepancies: sorted,
  };
}

// --- Matching primitives ----------------------------------------------------------

// Keep only records whose timestamp falls in the window. `at` pulls the timestamp out
// (settledAt for processor, postedAt for ledger). Half-open: `from` is in, `to` is out
// (next window), so adjacent windows never both claim a record.
function withinWindow<T>(
  records: ReadonlyArray<T>,
  window: Range,
  at: (record: T) => number,
): ReadonlyArray<T> {
  return records.filter((record) => {
    let when = at(record);
    return when >= window.from && when < window.to;
  });
}

// Build a key → ledger record lookup. On a duplicate key the first wins and the later one
// is left out, so it surfaces as a ledger orphan rather than overwriting the first.
function indexByKey(
  ledger: ReadonlyArray<LedgerRecord>,
): Map<string, LedgerRecord> {
  let index = new Map<string, LedgerRecord>();
  for (let record of ledger) {
    let key = keyOf(record.kind, record.matchKey);
    if (!index.has(key)) {
      index.set(key, record);
    }
  }
  return index;
}

// Combine kind with the match reference so a buy and payout sharing a reference don't
// collide.
function keyOf(kind: ReconcileKind, matchKey: string): string {
  return `${kind}:${matchKey}`;
}

// True when amounts are exactly equal: same currency, same value to the smallest unit, no
// tolerance. Currency is checked first because `compare` throws on mismatched currencies;
// checking here reports a currency mismatch as drift instead of crashing.
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
  for (let discrepancy of discrepancies) {
    if (discrepancy.kind === kind) {
      n += 1;
    }
  }
  return n;
}

// Sort by kind, then match key, then record kind, for a stable report. Compares by
// character code (see byCodeUnit), not `localeCompare`, whose order varies across
// runtimes and locales.
function byDiscrepancy(a: Discrepancy, b: Discrepancy): number {
  return (
    byCodeUnit(a.kind, b.kind) ||
    byCodeUnit(a.matchKey, b.matchKey) ||
    byCodeUnit(a.recordKind, b.recordKind)
  );
}
