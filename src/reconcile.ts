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
 * Whether a settled event is money coming in (a user buying credits) or money going out
 * (a payout to a user). Reconciliation handles the two separately, so a buy can never be
 * matched against a payout.
 */
export type ReconcileKind = 'buy' | 'payout';

/**
 * One settled event as the payment processor reports it — money the processor says
 * actually cleared. Reconciliation matches these against the ledger's own records of the
 * same events.
 */
export interface ProcessorRecord {
  kind: ReconcileKind;

  // The shared reference that lets us find this event's counterpart on the ledger side:
  // the provider reference for a payout, the order/purchase reference for a buy. Both
  // sides carry the same value here, so matching joins on it.
  matchKey: string;

  amount: Amount;
  providerRef: string;

  // When the processor cleared this event (epoch ms). The window filter compares
  // against this to decide whether the event falls in the period being reconciled.
  settledAt: number;
}

/**
 * One settled event as recorded in our own ledger — the counterpart to a
 * `ProcessorRecord` for the same event.
 */
export interface LedgerRecord {
  kind: ReconcileKind;

  // The same shared reference the processor carries for this event, so the two records
  // join on it. (The code that writes the ledger entry copies it in from the event.)
  matchKey: string;

  amount: Amount;
  txnId: string;

  // When this entry was committed to the ledger (epoch ms). The window filter compares
  // against this to decide whether the entry falls in the period being reconciled.
  postedAt: number;
}

/**
 * The three ways the processor's records and the ledger's records can fail to agree:
 *
 * - processor_orphan — the processor cleared money but we have no matching ledger entry
 *   (the dangerous case: real money moved with nothing on our books);
 * - ledger_orphan — we have a ledger entry the processor never cleared (money that's
 *   stuck, or an entry that should not exist);
 * - amount_drift — both sides exist for the same event, but the amounts differ.
 */
export type DiscrepancyKind =
  | 'processor_orphan'
  | 'ledger_orphan'
  | 'amount_drift';

/**
 * One mismatch the reconciliation found. The amount fields are decimal strings (like
 * `'CREDIT:12.34'`), not raw `bigint` amounts, because `JSON.stringify` cannot serialize
 * a `bigint`; using strings lets the report be saved or sent as JSON and come back
 * exactly the same.
 *
 * Which amount fields are present depends on `kind`: a processor orphan has only
 * `processorAmount`, a ledger orphan only `ledgerAmount`, and an amount drift has both.
 */
export interface Discrepancy {
  kind: DiscrepancyKind;

  matchKey: string;

  recordKind: ReconcileKind;

  processorAmount?: string;

  ledgerAmount?: string;
}

/**
 * The result of reconciling one time window. `discrepancies` lists every mismatch found
 * (always in the same sorted order, so the same inputs produce an identical report); the
 * count fields are just a summary of that list. `reconciled` is the one flag callers
 * usually check: true exactly when no mismatch was found.
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

  // The counts of each discrepancy kind (see DiscrepancyKind), summarizing the list below.
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
 * Compare the processor's settled records against the ledger's records for one time
 * window and report every mismatch.
 *
 * Only records that fall inside the window are considered, so the caller can pass more
 * records than needed and let this filter them. The window is half-open: a record
 * exactly on the `to` boundary belongs to the next window, not this one.
 *
 * Two records match when they have the same kind (buy or payout) and the same matchKey.
 * If two records on one side share a key (which should never happen), only the first is
 * matched; any later duplicate is reported as an orphan on its own side rather than
 * silently ignored.
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

// The intermediate result of matching the two sides. The discrepancies are still in the
// order they were discovered; `report` sorts them into the final, stable order.
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

// Walk every processor record and try to find its ledger counterpart in the index.
// Each time one matches, remove it from the index; whatever is left in the index
// afterward is exactly the ledger records that had no processor counterpart, which the
// next pass reports as ledger orphans.
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

// Turn the ledger records still left in the index into ledger orphans. This iterates the
// original ledger list rather than the index itself so the orphans come out in a fixed
// order regardless of how the Map happens to iterate on a given runtime. (The result is
// sorted again later anyway, but this keeps it predictable beforehand.)
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

// Sort the discrepancies into their final stable order and assemble the report. The
// count fields are computed from that same sorted list, so a count can never disagree
// with the list it summarizes.
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

// Keep only the records whose timestamp falls in the window. The `at` function pulls the
// timestamp out of a record (settledAt for processor records, postedAt for ledger ones).
// The window is half-open: a record at exactly `from` is in, but one at exactly `to` is
// out (it belongs to the next window), so adjacent windows never both claim a record.
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

// Build a lookup table from key to ledger record so each processor record can find its
// counterpart quickly. If two records share a key, the first one wins and the later one
// is deliberately left out of the table — it will surface as a ledger orphan instead of
// quietly replacing the first, so an unexpected duplicate gets noticed.
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

// Build the lookup key by combining the kind with the match reference, so a buy and a
// payout that happen to share the same reference never collide.
function keyOf(kind: ReconcileKind, matchKey: string): string {
  return `${kind}:${matchKey}`;
}

// True when the two amounts are exactly equal — same currency and same value to the
// smallest unit, with no tolerance. The currency check comes first because `compare`
// throws when given two different currencies; checking here means a currency mismatch is
// reported as a drift instead of crashing.
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

// Compare two discrepancies so they always sort the same way: first by kind, then by
// match key, then by record kind. A fixed order means the same inputs always produce the
// same report. It compares by character code (see byCodeUnit) rather than with
// `localeCompare`, whose ordering can differ between runtimes and locales.
function byDiscrepancy(a: Discrepancy, b: Discrepancy): number {
  return (
    byCodeUnit(a.kind, b.kind) ||
    byCodeUnit(a.matchKey, b.matchKey) ||
    byCodeUnit(a.recordKind, b.recordKind)
  );
}
