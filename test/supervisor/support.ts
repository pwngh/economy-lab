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

import { usd } from '#src/money.ts';

import type { ProveReport } from '#src/contract.ts';
import type { Saga } from '#src/ports.ts';
import type { AuditRecord, AuditSink } from '#src/supervisor/audit.ts';
import type { SagaSource } from '#src/supervisor/supervisor.ts';
import type { Signal, SignalFeed } from '#src/supervisor/runtime.ts';

/** A healthy report for a stub `prove` port, with the named flags overridden. */
export function proveReport(overrides: Partial<ProveReport> = {}): ProveReport {
  return {
    prover: 'proveEconomy',
    conserved: true,
    backed: true,
    noOverdraft: true,
    chainIntact: true,
    firstBreak: null,
    consistent: true,
    drift: [],
    shortfall: usd('0.00'),
    ...overrides,
  };
}

export function recorder(): { records: AuditRecord[]; sink: AuditSink } {
  const records: AuditRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

export const noSignals: SignalFeed = { since: () => [] };

export function feedOf(signals: ReadonlyArray<Signal>): SignalFeed {
  return { since: (t) => signals.filter((signal) => signal.at >= t) };
}

export function meterSignal(
  at: number,
  name: string,
  value: number,
  tags: Record<string, string> = {},
): Signal {
  return { at, source: 'meter', name, value, tags };
}

export function logSignal(at: number, name: string, level = 'error'): Signal {
  return { at, source: 'log', name, value: 1, tags: { level } };
}

export function frozenSagaSource(sagas: ReadonlyArray<Saga>): SagaSource {
  return {
    list: async function* () {
      yield* sagas;
    },
    load: async (id) => sagas.find((saga) => saga.id === id) ?? null,
  };
}
