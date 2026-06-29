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
 * Two records match on same kind (buy/payout) and same matchKey. If a key repeats on a side
 * (shouldn't happen — matchKey is a unique join reference), the duplicates pair up oldest-first and
 * any surplus on either side surfaces as orphans on that side, so every record is accounted for
 * exactly once. A reconciler exists to catch the "shouldn't happen", so it must never silently drop
 * one — `report` self-checks that the counts reconstruct both sides.
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
  collectLedgerOrphans(ledgerByKey, discrepancies);
  return { matched, discrepancies };
}

// Pair each processor record with one ledger counterpart, consuming it from that key's bucket
// (oldest-first) so a ledger record matches at most one processor record. No bucket, or one already
// emptied, means a processor record the ledger never recorded — a processor orphan. Whatever stays
// in the buckets afterward is ledger records with no processor counterpart, reported as ledger
// orphans by the next pass.
function matchProcessorSide(
  processor: ReadonlyArray<ProcessorRecord>,
  ledgerByKey: Map<string, LedgerRecord[]>,
  discrepancies: Discrepancy[],
): number {
  let matched = 0;
  for (let record of processor) {
    let key = keyOf(record.kind, record.matchKey);
    let counterpart = ledgerByKey.get(key)?.shift();
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

// Turn the ledger records left unmatched in the buckets into ledger orphans: every record no
// processor match consumed. Buckets keep first-seen order (within a key, and across keys by
// insertion — both ECMAScript-guaranteed for a Map), so this is deterministic; the report's final
// sort settles cross-key order, and same-key duplicates keep their original order here.
function collectLedgerOrphans(
  remaining: Map<string, LedgerRecord[]>,
  discrepancies: Discrepancy[],
): void {
  for (let bucket of remaining.values()) {
    for (let record of bucket) {
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
  let processorOrphans = countKind(sorted, 'processor_orphan');
  let ledgerOrphans = countKind(sorted, 'ledger_orphan');
  let amountDrifts = countKind(sorted, 'amount_drift');
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

// Every record on each side must be accounted for exactly once. A match and an amount-drift each
// consume one record from BOTH sides (a paired processor+ledger record); a processor orphan is an
// unpaired processor record, a ledger orphan an unpaired ledger record. So both sides must
// reconstruct: matched + drifts + processorOrphans === processorCount, and the same for the ledger.
// If either fails, the matcher dropped or double-counted a record and the report cannot be trusted,
// so throw rather than emit a quietly-wrong reconciliation — the one thing a reconciler must never
// do. Holds by construction today; this is the regression guard that keeps it so.
function assertAccountedFor(counts: {
  matched: number;
  amountDrifts: number;
  processorOrphans: number;
  ledgerOrphans: number;
  processorCount: number;
  ledgerCount: number;
}): void {
  let processorSeen =
    counts.matched + counts.amountDrifts + counts.processorOrphans;
  let ledgerSeen = counts.matched + counts.amountDrifts + counts.ledgerOrphans;
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

// Bucket the ledger records by key, keeping EVERY record per key in first-seen order. A repeated key
// (matchKey is meant to be a unique join reference, so a repeat is the "shouldn't happen" a
// reconciler exists to catch) keeps all its records, so matchProcessorSide pairs each with a
// distinct processor record and any surplus still surfaces as a ledger orphan — never silently
// dropped (the bug this replaced: keeping only the first and losing the rest).
function indexByKey(
  ledger: ReadonlyArray<LedgerRecord>,
): Map<string, LedgerRecord[]> {
  let index = new Map<string, LedgerRecord[]>();
  for (let record of ledger) {
    let key = keyOf(record.kind, record.matchKey);
    let bucket = index.get(key);
    if (bucket === undefined) {
      index.set(key, [record]);
    } else {
      bucket.push(record);
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
