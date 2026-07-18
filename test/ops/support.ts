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

import type { Saga } from '#src/ports.ts';
import type { AuditRecord, AuditSink } from '#src/ops/audit.ts';
import type { SagaSource } from '#src/ops/supervisor.ts';
import type { Signal, SignalFeed } from '#src/ops/runtime.ts';

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
