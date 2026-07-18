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
  capabilitiesFromEnv,
  createWorker,
  credits,
  economyFromCapabilities,
  externalsFromEnv,
  noopLogger,
  noopMeter,
  requestPayout,
  spend,
  systemActor,
  topUp,
  userActor,
  workerCtxFrom,
} from '#src/index.ts';

import {
  createSupervisor,
  jsonlAuditSink,
  opsRuntime,
} from '#src/ops/index.ts';
import { fixedClock } from '#test/support/capabilities.ts';

import type { Processor } from '#src/ports.ts';
import type { AuditRecord } from '#src/ops/index.ts';

test('acceptance: a stuck payout saga is detected, swept, verified, and audited', async () => {
  const clock = fixedClock(1_000_000);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const processor: Processor = {
    submitPayout: async () => ({ providerRef: 'prov_acceptance' }),
  };
  const caps = await capabilitiesFromEnv(
    { PAYOUT_MIN_EARNED_MINOR: '1000' },
    externalsFromEnv({}, { processor }),
    { clock, logger: runtime.logger, meter: runtime.meter },
  );
  const economy = economyFromCapabilities(caps);
  const worker = createWorker(caps.store, workerCtxFrom(caps));

  const buyer = 'usr_buyer';
  const seller = 'usr_seller';
  const topped = await economy.submit(
    topUp({
      idempotencyKey: 'idem_topup',
      actor: systemActor('billing'),
      userId: buyer,
      amount: credits(150),
      source: 'card',
    }),
  );
  assert.equal(topped.status, 'committed');
  const order = await economy.submit(
    spend({
      idempotencyKey: 'idem_order',
      actor: userActor(buyer),
      orderId: 'ord_1',
      buyerId: buyer,
      sku: 'gallery-print',
      price: credits(100),
      recipients: [{ sellerId: seller, shareBps: 10_000 }],
    }),
  );
  assert.equal(order.status, 'committed');
  const request = await economy.submit(
    requestPayout({
      idempotencyKey: 'idem_payout',
      actor: userActor(seller),
      userId: seller,
      amount: credits(40),
    }),
  );
  assert.equal(request.status, 'committed');
  if (request.status !== 'committed') {
    return;
  }
  const sagaId = request.transaction.meta.sagaId as string;
  const before = await economy.read.saga(sagaId);
  assert.equal(before?.state, 'RESERVED');

  const records: AuditRecord[] = [];
  const lines: string[] = [];
  const jsonl = jsonlAuditSink((line) => lines.push(line));
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: caps.store.sagas,
    runSweep: (now) => worker.runOnce({ now, limit: 10 }),
    audit: (record) => {
      records.push(record);
      jsonl(record);
    },
    config: { stuckSagaAgeMs: 60_000, actionCooldownMs: 30_000 },
  });

  assert.deepEqual(await supervisor.tick(), []);

  clock.advance(120_000);
  const acted = await supervisor.tick();

  const sagaPhases = acted
    .filter(
      (record) =>
        record.signature === 'stuck-saga' && record.subject === sagaId,
    )
    .map((record) => record.phase);
  assert.deepEqual(sagaPhases, ['detected', 'decided', 'verified']);
  const sweep = acted.find((record) => record.phase === 'acted');
  assert.deepEqual(sweep?.detail.sagas, [sagaId]);
  const verified = acted.find(
    (record) => record.phase === 'verified' && record.subject === sagaId,
  );
  assert.equal(verified?.detail.outcome, 'progressed');

  const after = await economy.read.saga(sagaId);
  assert.equal(after?.state, 'SUBMITTED');
  assert.equal(after?.providerRef, 'prov_acceptance');

  assert.equal(lines.length, records.length);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    records,
  );

  const report = await economy.read.prove();
  assert.equal(report.conserved, true);
  assert.equal(report.chainIntact, true);
  assert.equal(report.noOverdraft, true);
});
