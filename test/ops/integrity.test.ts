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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createWorker,
  credits,
  createEconomy,
  openPorts,
  systemActor,
  topUp,
} from '#src/index.ts';
import { silentLogger, silentMeter } from '#src/runtime.ts';

import {
  createSupervisor,
  jsonlAuditSink,
  createOpsRuntime,
} from '#src/ops/index.ts';
import { fixedClock } from '#test/support/capabilities.ts';
import { frozenSagaSource, recorder } from '#test/ops/support.ts';

import type { AuditRecord } from '#src/ops/index.ts';

test('integrity: a real ledger tamper escalates through the checkpoint mismatch, once, with a prove report', async () => {
  const clock = fixedClock(1_000_000);
  const runtime = createOpsRuntime({
    meter: silentMeter(),
    logger: silentLogger(),
    clock,
  });
  const ports = await openPorts(
    {},
    {
      processor: { submitPayout: async () => ({ providerRef: 'p' }) },
      clock,
      logger: runtime.logger,
      meter: runtime.meter,
    },
  );
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);

  const topped = await economy.submit(
    topUp({
      idempotencyKey: 'idem_topup',
      actor: systemActor('billing'),
      userId: 'usr_a',
      amount: credits(100),
      source: 'card',
    }),
  );
  assert.equal(topped.status, 'committed');
  if (topped.status !== 'committed') {
    return;
  }
  await worker.sweep({ now: clock.now(), limit: 10 });

  const { records, sink } = recorder();
  const lines: string[] = [];
  const jsonl = jsonlAuditSink((line) => lines.push(line));
  const escalations: AuditRecord[] = [];
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      throw new Error('integrity findings must never trigger the sweep');
    },
    audit: (record) => {
      sink(record);
      jsonl(record);
    },
    prove: () => economy.read.health(),
    escalate: (record) => escalations.push(record),
  });

  assert.deepEqual(await supervisor.tick(), []);

  const tamper = (
    ports.store.ledger as unknown as {
      __tamper?: (
        txnId: string,
        mutate: (legs: Array<{ amount: { minor: bigint } }>) => void,
      ) => void;
    }
  ).__tamper;
  assert.notEqual(tamper, undefined);
  tamper?.(topped.transaction.id, (legs) => {
    legs[0].amount.minor += 1n;
  });
  await worker.sweep({ now: clock.now(), limit: 10 });

  const escalated = await supervisor.tick();
  assert.deepEqual(
    escalated.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.deepEqual(escalated[0].detail.channels, ['log', 'meter']);
  assert.equal(escalations.length, 1);
  const proof = escalations[0].detail.proof as { conserved: boolean };
  assert.equal(proof.conserved, false);

  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(escalations.length, 1);
  assert.equal(records.length, 2);

  // The escalation's prove report serializes cleanly, bigint money fields included.
  assert.equal(lines.length, 2);
  for (const line of lines) {
    JSON.parse(line);
  }
});
