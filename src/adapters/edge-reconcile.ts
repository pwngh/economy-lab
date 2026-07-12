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

import { toAmount } from '#src/money.ts';

import type { CanonicalSettlement, Edge } from '@pwngh/economy-edge';
import type { Currency } from '#src/money.ts';
import type {
  LedgerRecord,
  ProcessorRecord,
  ReconcileKind,
} from '#src/reconcile.ts';
import type { Options, Range, Store } from '#src/ports.ts';
import type { ReconcileFeed } from '#src/worker/reconcile.ts';

export type LedgerSide = (
  window: Range,
  options?: Options,
) => Promise<ReadonlyArray<LedgerRecord>>;

export function settledPayoutLedgerRecords(
  store: Store,
  matchKeyOf: (providerRef: string) => string,
): LedgerSide {
  return async (window, options) => {
    const records: LedgerRecord[] = [];
    for await (const saga of store.sagas.list(options)) {
      if (
        saga.state !== 'SETTLED' ||
        saga.providerRef === null ||
        saga.payoutUsd === null
      ) {
        continue;
      }
      if (saga.updatedAt < window.from || saga.updatedAt >= window.to) {
        continue;
      }
      records.push({
        kind: 'payout',
        matchKey: matchKeyOf(saga.providerRef),
        amount: saga.payoutUsd,
        txnId: saga.id,
        postedAt: saga.updatedAt,
      });
    }
    return records;
  };
}

/**
 * A settlement the feed filtered out rather than matched. Drops are legitimate —
 * sku-day aggregates have no per-transaction match key, and a foreign-currency
 * settlement cannot match a CREDIT/USD ledger — but a reconciliation feed must
 * never discard silently, so every drop is reported through `onDrop` with the
 * reason and enough identity to chase it in the provider's console.
 */
export type ReconcileDrop = {
  kind: ReconcileKind;
  reason: 'sku-day' | 'foreign-currency';
  providerTxnId: string;
  currency: string;
};

export function edgeReconcileFeed(
  edge: Edge,
  ledger: LedgerSide,
  onDrop?: (drop: ReconcileDrop) => void,
): ReconcileFeed {
  return {
    pull: async (window, options) => {
      const span = {
        from: new Date(window.from).toISOString(),
        to: new Date(window.to).toISOString(),
      };
      const [buys, payouts] = await Promise.all([
        edge.inbound.report(span),
        edge.outbound.report(span),
      ]);
      return {
        processor: [
          ...processorRecords('buy', buys, window.from, onDrop),
          ...processorRecords(
            'payout',
            payouts.disbursements,
            window.from,
            onDrop,
          ),
        ],
        ledger: await ledger(window, options),
      };
    },
  };
}

function processorRecords(
  kind: ReconcileKind,
  settlements: ReadonlyArray<CanonicalSettlement>,
  settledAt: number,
  onDrop?: (drop: ReconcileDrop) => void,
): ProcessorRecord[] {
  const records: ProcessorRecord[] = [];
  for (const settlement of settlements) {
    if (settlement.granularity === 'sku-day') {
      onDrop?.({
        kind,
        reason: 'sku-day',
        providerTxnId: settlement.providerTxnId,
        currency: settlement.gross.currency,
      });
      continue;
    }
    if (
      settlement.gross.currency !== 'USD' &&
      settlement.gross.currency !== 'CREDIT'
    ) {
      onDrop?.({
        kind,
        reason: 'foreign-currency',
        providerTxnId: settlement.providerTxnId,
        currency: settlement.gross.currency,
      });
      continue;
    }
    records.push({
      kind,
      matchKey: settlement.providerTxnId,
      amount: toAmount(
        settlement.gross.currency as Currency,
        settlement.gross.minor,
      ),
      providerRef: settlement.sourceRef,
      settledAt,
    });
  }
  return records;
}
