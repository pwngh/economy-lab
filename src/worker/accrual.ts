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

import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';
import { credit, debit, lockAll, postEntry } from '#src/ledger.ts';
import { verifiedPosting } from '#src/chain.ts';
import { toAmount } from '#src/money.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { toHex } from '#src/bytes.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type {
  AccrualRow,
  AccrualRowKey,
  Leg,
  Posting,
  Store,
  Unit,
} from '#src/ports.ts';

/**
 * Result of one accrual-drain run (config.accrualDrain; the sweep is a no-op with the flag off).
 * - `drained`: one entry per seller whose claimed rows settled — how much reached `earned` and
 *   how much repaid RECEIVABLE, in minor units.
 * - `failed`: that seller's transaction threw and rolled back; the rows stay pending for the
 *   next run.
 */
export type AccrualDrainSummary = {
  drained: ReadonlyArray<{
    sellerId: string;
    txnId: string;
    earnedMinor: string;
    recoveredMinor: string;
  }>;
  failed: ReadonlyArray<{ sellerId: string; code: string }>;
  skipped: boolean;
};

type DrainTally = {
  drained: Array<{
    sellerId: string;
    txnId: string;
    earnedMinor: string;
    recoveredMinor: string;
  }>;
  failed: Array<{ sellerId: string; code: string }>;
  skipped: boolean;
};

/**
 * Move parked seller shares from the SETTLEMENT_ACCRUAL shards to each seller's earned balance,
 * one posting per seller per run — the batching that makes the drain, not each purchase, the only
 * writer of earned rows. Negative rows (refund-recovery debt) net against the seller's positive
 * shares first: RECEIVABLE is repaid before new money reaches `earned`. Each seller drains in its
 * own transaction, so one poisoned group dead-ends alone and the rest still settle. `limit`
 * bounds both dimensions — sellers per run and rows per seller — so one run touches at most
 * limit-squared rows.
 *
 * The posting id derives from the claimed row set, so a crash between post and mark re-runs to
 * the same outcome: the replay finds the posting already committed and only re-applies the marks.
 * A drain can deadlock a concurrent refund of the same rows (opposite row/account lock order);
 * the engines classify that as transient and retry, and the loser re-reads the rows' new status.
 */
export async function drainAccruals(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
): Promise<AccrualDrainSummary> {
  const tally: DrainTally = { drained: [], failed: [], skipped: false };
  if (!ctx.config.accrualDrain) {
    tally.skipped = true;
    return tally;
  }
  await observeBacklog(store, ctx);
  const sellers = await store.accruals.pendingSellers(input.limit);
  for (const sellerId of sellers) {
    try {
      const settled = await store.transaction((unit) =>
        drainSeller(unit, ctx, sellerId, input),
      );
      if (settled !== null) {
        tally.drained.push(settled);
      }
    } catch (error) {
      const normalized = normalizeError(error);
      ctx.logger.log('error', 'worker.accrual.failed', {
        sellerId,
        code: normalized.code,
      });
      tally.failed.push({ sellerId, code: normalized.code });
    }
  }
  return tally;
}

// The drain-lag gauges, the accrual mirror of the relay's backlog pair: a pending age that only
// grows means the drain is down or a seller group is poisoned. Telemetry only — a stats failure
// never blocks the drain.
async function observeBacklog(store: Store, ctx: WorkerCtx): Promise<void> {
  try {
    const stats = await store.accruals.stats();
    ctx.meter.observe('worker.accrual.backlog', Number(stats.pendingMinor));
    if (stats.oldestPendingAgeMs !== null) {
      ctx.meter.observe(
        'worker.accrual.backlog_age_ms',
        stats.oldestPendingAgeMs,
      );
    }
  } catch {
    // Telemetry only.
  }
}

async function drainSeller(
  unit: Unit,
  ctx: WorkerCtx,
  sellerId: string,
  input: { now: number; limit: number },
): Promise<DrainTally['drained'][number] | null> {
  const rows = await unit.accruals.claimPendingBySeller(sellerId, input.limit);
  await assertRowsProvable(unit, ctx, rows);
  const positives = rows.filter((row) => row.amount.minor > 0n);
  if (positives.length === 0) {
    // Only recovery debt is pending; nothing funds it this cycle.
    return null;
  }
  const negatives = rows.filter((row) => row.amount.minor < 0n);

  let parkedMinor = 0n;
  const byShard = new Map<AccountRef, bigint>();
  for (const row of positives) {
    parkedMinor += row.amount.minor;
    byShard.set(row.shard, (byShard.get(row.shard) ?? 0n) + row.amount.minor);
  }
  const recovery = consumeRecovery(negatives, parkedMinor);
  const earnedMinor = parkedMinor - recovery.recoveredMinor;

  const legs: Leg[] = [];
  for (const [shard, minor] of byShard) {
    legs.push(debit(shard, toAmount('CREDIT', minor)));
  }
  if (earnedMinor > 0n) {
    legs.push(credit(earned(sellerId), toAmount('CREDIT', earnedMinor)));
  }
  if (recovery.recoveredMinor > 0n) {
    legs.push(
      credit(SYSTEM.RECEIVABLE, toAmount('CREDIT', recovery.recoveredMinor)),
    );
  }

  const txnId = await drainTxnId(ctx, rows);
  await lockAll(
    unit.ledger,
    legs.map((leg) => leg.account),
  );
  if ((await unit.ledger.posting(txnId)) === null) {
    await postEntry(unit.ledger, {
      txnId,
      legs,
      meta: {
        kind: 'accrual_drain',
        sellerId,
        orders: [...new Set(rows.map((row) => row.orderId))].sort(),
        // Sealed into the chain hash so the residual row written below is provable next cycle.
        ...(recovery.residual === null
          ? {}
          : {
              residual: {
                orderId: recovery.residual.orderId,
                seq: recovery.residual.seq,
                minor: recovery.residual.amount.minor.toString(),
              },
            }),
      },
    });
  }

  const settled: AccrualRowKey[] = [...positives, ...recovery.consumed].map(
    ({ orderId, sellerId: seller, seq }) => ({
      orderId,
      sellerId: seller,
      seq,
    }),
  );
  await unit.accruals.markDrained(settled, txnId);
  if (recovery.residual !== null) {
    // Stamped `now`, not the consumed row's original time: the residual is new debt state, so it
    // sorts last in claimPendingBySeller's recorded_at order rather than inheriting the old slot.
    await unit.accruals.put([
      { ...recovery.residual, txnId, recordedAt: input.now },
    ]);
  }

  return {
    sellerId,
    txnId,
    earnedMinor: earnedMinor.toString(),
    recoveredMinor: recovery.recoveredMinor.toString(),
  };
}

// Every claimed row must re-derive from the posting its txnId names: that posting is re-proved
// against its own chain links (verifiedPosting), and the row's amount must match the entry sealed
// in the posting's hashed metadata — `shares` on a charge, `recovered` on a refund, `residual` on
// a prior drain. The rows are an unhashed side table and money moves by their amounts, so an
// edited or fabricated row dead-ends this seller's drain loudly instead of redirecting shares.
async function assertRowsProvable(
  unit: Unit,
  ctx: WorkerCtx,
  rows: ReadonlyArray<AccrualRow>,
): Promise<void> {
  const postings = new Map<string, Posting>();
  for (const row of rows) {
    let posting = postings.get(row.txnId);
    if (posting === undefined) {
      const verified = await verifiedPosting(
        { ledger: unit.ledger, digest: ctx.digest },
        row.txnId,
      );
      if (verified === null) {
        throw rowFault(row);
      }
      postings.set(row.txnId, verified);
      posting = verified;
    }
    if (!rowMatchesMeta(row, posting.meta)) {
      throw rowFault(row);
    }
  }
}

// A positive row is a charge's original share (seq 0, matched against `shares`); a negative row
// is refund recovery (matched against `recovered`) or a prior drain's boundary split (matched
// against `residual`, seller included). Anything else proves nothing and fails.
function rowMatchesMeta(
  row: AccrualRow,
  meta: Record<string, unknown>,
): boolean {
  if (row.amount.minor > 0n) {
    const shares = meta.shares as Record<string, string> | undefined;
    const expected = shares?.[row.sellerId];
    return (
      row.seq === 0 &&
      expected !== undefined &&
      BigInt(expected) === row.amount.minor
    );
  }
  if (meta.kind === 'refund') {
    const recovered = meta.recovered as Record<string, string> | undefined;
    const expected = recovered?.[row.sellerId];
    return expected !== undefined && BigInt(expected) === -row.amount.minor;
  }
  if (meta.kind === 'accrual_drain') {
    const residual = meta.residual as
      | { orderId?: string; seq?: number; minor?: string }
      | undefined;
    return (
      residual !== undefined &&
      meta.sellerId === row.sellerId &&
      residual.orderId === row.orderId &&
      residual.seq === row.seq &&
      BigInt(residual.minor ?? '0') === row.amount.minor
    );
  }
  return false;
}

function rowFault(row: AccrualRow): Error {
  return fault(
    ERROR_CODES.CHAIN_BROKEN,
    'An accrual row does not re-derive from the posting that created it; refusing to drain tampered rows.',
    {
      retryable: false,
      detail: {
        orderId: row.orderId,
        sellerId: row.sellerId,
        seq: row.seq,
        txnId: row.txnId,
      },
    },
  );
}

// How much refund debt this cycle's parked total can repay. Negative rows are consumed whole in
// claim order; a boundary row bigger than what remains is split — it drains, and a smaller
// negative row (the next seq of its order) carries the rest — so recovery is exact with no
// partially-consumed row.
function consumeRecovery(
  negatives: ReadonlyArray<AccrualRow>,
  parkedMinor: bigint,
): {
  recoveredMinor: bigint;
  consumed: AccrualRow[];
  residual: Omit<AccrualRow, 'txnId' | 'recordedAt'> | null;
} {
  let remaining = parkedMinor;
  let recoveredMinor = 0n;
  const consumed: AccrualRow[] = [];
  let residual: Omit<AccrualRow, 'txnId' | 'recordedAt'> | null = null;
  for (const row of negatives) {
    if (remaining === 0n) {
      break;
    }
    const owed = -row.amount.minor;
    if (owed <= remaining) {
      consumed.push(row);
      recoveredMinor += owed;
      remaining -= owed;
      continue;
    }
    consumed.push(row);
    recoveredMinor += remaining;
    residual = {
      orderId: row.orderId,
      sellerId: row.sellerId,
      seq: row.seq + 1,
      amount: toAmount('CREDIT', -(owed - remaining)),
      shard: row.shard,
      status: 'pending',
      settledTxnId: null,
    };
    remaining = 0n;
    break;
  }
  return { recoveredMinor, consumed, residual };
}

// Deterministic posting id from the claimed row set: the same pending rows always drain under
// the same id, which is what makes the crash replay converge instead of double-posting.
async function drainTxnId(
  ctx: WorkerCtx,
  rows: ReadonlyArray<AccrualRow>,
): Promise<string> {
  const keys = rows
    .map((row) => `${row.orderId}|${row.sellerId}|${row.seq}`)
    .sort()
    .join('\n');
  const digest = await ctx.digest.hash(new TextEncoder().encode(keys));
  // 32 hex chars = 128 bits: collision odds are negligible at any real drain volume, and the id
  // stays inside the 64-char posting-id column.
  return `acc_${toHex(digest).slice(0, 32)}`;
}
