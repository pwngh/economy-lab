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

/**
 * Request-path telemetry: every submit counts once under `economy.submit` tagged by kind and
 * how it resolved, and observes its wall time — so an operator has outcome metrics without
 * wrapping submit themselves. Metering is a bystander: it never changes the outcome, and a
 * throwing meter cannot turn a decided outcome into an error.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { economyFromCapabilities } from '#src/economy.ts';
import { economyWithStore } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spend, topUp, credit } from '#test/support/builders.ts';
import {
  defaultPricing,
  fakeProcessor,
  fixedClock,
  fixedRates,
  seededDigest,
  seededSigner,
  sequentialIds,
  testConfig,
  testLogger,
} from '#test/support/capabilities.ts';

import type { Meter } from '#src/ports.ts';

type Count = { name: string; tags?: Record<string, string> };

function meteredEconomy(counts: Count[], observed: string[]) {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const meter: Meter = {
    count: (name, _n, tags) => counts.push({ name, tags }),
    observe: (name) => observed.push(name),
  };
  return economyFromCapabilities({
    store: memoryStore({ digest, clock }),
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(1),
    rates: fixedRates(),
    logger: testLogger(),
    meter,
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: testConfig(),
  });
}

describe('economy.submit telemetry', () => {
  test('counts committed, duplicate, and fault submits by kind and outcome', async () => {
    const counts: Count[] = [];
    const observed: string[] = [];
    const economy = meteredEconomy(counts, observed);

    const operation = topUp({ userId: 'usr_m', amount: credit('5.00') });
    await economy.submit(operation);
    await economy.submit(operation); // same key: duplicate
    await assert.rejects(
      economy.submit({ kind: 'settlePayout' } as never), // malformed: a fault
    );

    assert.deepEqual(
      counts.map((c) => ({ name: c.name, ...c.tags })),
      [
        { name: 'economy.submit', kind: 'topUp', status: 'committed' },
        { name: 'economy.submit', kind: 'topUp', status: 'duplicate' },
        { name: 'economy.submit', kind: 'settlePayout', status: 'fault' },
      ],
    );
    assert.equal(
      observed.filter((name) => name === 'economy.submit.ms').length,
      3,
    );
    await economy.close();
  });

  test('a throwing meter never changes the outcome', async () => {
    const digest = seededDigest(1);
    const clock = fixedClock(0);
    const economy = economyFromCapabilities({
      store: memoryStore({ digest, clock }),
      clock,
      ids: sequentialIds(),
      digest,
      signer: seededSigner(1),
      rates: fixedRates(),
      logger: testLogger(),
      meter: {
        count: () => {
          throw new Error('metrics sink down');
        },
        observe: () => {
          throw new Error('metrics sink down');
        },
      },
      processor: fakeProcessor(),
      pricing: defaultPricing(),
      config: testConfig(),
    });

    const outcome = await economy.submit(
      topUp({ userId: 'usr_m', amount: credit('5.00') }),
    );
    assert.equal(outcome.status, 'committed');
    await economy.close();
  });
});

describe('Submit Correlation', () => {
  test('the outbox envelope carries the submit correlation id', async () => {
    const { economy, store } = economyWithStore(1);

    await economy.submit(
      {
        kind: 'topUp',
        idempotencyKey: 'idem_corr',
        actor: { kind: 'system', service: 'test' },
        userId: 'usr_corr',
        source: 'card',
        amount: credit('1.00'),
      } as never,
      { correlationId: 'req_end_to_end' },
    );

    const [row] = await store.outbox.claimBatch(10);
    assert.equal(row!.correlationId, 'req_end_to_end');
  });
});
