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

// The 0.4.0 break deleted its old doors outright — no aliases, no dual exports, no compatibility
// getters. This guard keeps them deleted: every entry namespace is checked for the removed value
// names, and the type probes below fail to COMPILE if a removed type or signature ever returns.

/* eslint-disable @typescript-eslint/no-unused-vars -- the probes exist to import, not to use */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error -- deleted in 0.4.0 (renamed Ports)
import type { Capabilities as _T1 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed CallOptions)
import type { Options as _T2 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0
import type { ExternalPorts as _T3 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0
import type { Externals as _T4 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0
import type { RuntimeDefaults as _T5 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0
import type { EconomyOptions as _T6 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0
import type { WorkerCtx as _T7 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0
import type { ComposedWorker as _T8 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed EnvDescription)
import type { Selection as _T9 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed SweepRequest)
import type { SweepInput as _T10 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed WebhookReceipt, home /server)
import type { WebhookAck as _T11 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed EntitlementAttributes)
import type { EntitlementAttrs as _T12 } from '#src/index.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed InboxMessage)
import type { InboxEntry as _T13 } from '#src/ports.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed SessionPorts)
import type { SessionDeps as _T14 } from '#src/netting.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed SupervisorPorts)
import type { SupervisorDeps as _T15 } from '#src/ops/index.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed SqsDispatcherOptions)
import type { SqsDispatcherConfig as _T16 } from '#src/adapters/sqs.ts';

import { createEconomy } from '#src/index.ts';
import type { Ports } from '#src/index.ts';

// @ts-expect-error -- deleted in 0.4.0 (the dual-arg createEconomy options door)
const _T17 = (ports: Ports) => createEconomy(ports, {});

// Every removed value name, checked against every entry so a door cannot creep back in anywhere.
const REMOVED_VALUES = [
  'capabilitiesFromEnv',
  'externalsFromEnv',
  'compose',
  'composeWorker',
  'workerCtxFrom',
  'checkEnv',
  'describeSelection',
  'economyFromCapabilities',
  'noopLogger',
  'noopMeter',
  'systemCapabilities',
  'instanceSession',
  'opsRuntime',
  'redisCacheFrom',
  'redisRateLimiterFrom',
  'neg',
  'runOnce',
  'brandPorts',
  'loadPorts',
] as const;

const ENTRIES: Record<string, () => Promise<object>> = {
  '.': () => import('#src/index.ts'),
  './ports': () => import('#src/ports.ts'),
  './adapters': () => import('#src/adapters/index.ts'),
  './adapters/redis': () => import('#src/adapters/redis.ts'),
  './adapters/sqs': () => import('#src/adapters/sqs.ts'),
  './engines/postgres': () => import('#src/engines/postgres.ts'),
  './engines/mysql': () => import('#src/engines/mysql.ts'),
  './worker': () => import('#src/worker/index.ts'),
  './server': () => import('#src/server.ts'),
  './netting': () => import('#src/netting.ts'),
  './ops': () => import('#src/ops/index.ts'),
  './store-kit': () => import('#src/store-kit.ts'),
  // Not a package entry: the browser-sandbox stand-in the apps' vite configs alias over the DB,
  // cache, and queue modules. A removed name lingering here would resurface in the sandbox bundle.
  'packages/engine-browser': () =>
    import('../packages/engine-browser/unavailable.ts'),
};

describe('no compatibility shims exist', () => {
  for (const [entry, load] of Object.entries(ENTRIES)) {
    test(`${entry} exports none of the removed doors`, async () => {
      const namespace = await load();
      for (const name of REMOVED_VALUES) {
        assert.equal(
          name in namespace,
          false,
          `${entry} still exports removed name "${name}"`,
        );
      }
    });
  }

  test('the worker handle carries no legacy members', async () => {
    const { createWorker } = await import('#src/worker/index.ts');
    const { memoryPorts, createEconomy } = await import('#src/index.ts');
    const ports = memoryPorts({
      signingKey: 'no-shims-signing-key-32-bytes!!!!',
    });
    const worker = createWorker(ports, createEconomy(ports));
    assert.equal('runOnce' in worker, false);
    assert.equal(typeof (worker as { paused?: unknown }).paused, 'undefined');
  });

  test('the browser stub exports no name the aliased modules lack', async () => {
    const stub = await import('../packages/engine-browser/unavailable.ts');
    const real = {
      ...(await import('#src/engines/postgres.ts')),
      ...(await import('#src/engines/mysql.ts')),
      ...(await import('#src/adapters/redis.ts')),
      ...(await import('#src/adapters/sqs.ts')),
    };
    // These stand in for the bare driver packages (ioredis, @aws-sdk/client-sqs), not our modules.
    const driverNames = ['default', 'SQSClient', 'SendMessageCommand'];
    for (const name of Object.keys(stub)) {
      if (driverNames.includes(name)) {
        continue;
      }
      assert.equal(
        name in real,
        true,
        `packages/engine-browser stub exports stale name "${name}"`,
      );
    }
  });

  test('a rejected outcome carries no legacy members', async () => {
    const { memoryPorts, spend, toAmount, userActor } =
      await import('#src/index.ts');
    const economy = createEconomy(
      memoryPorts({ signingKey: 'no-shims-signing-key-32-bytes!!!!' }),
    );
    // The cheapest in-memory rejection: a spend from a buyer who holds nothing.
    const outcome = await economy.submit(
      spend({
        idempotencyKey: 's1',
        actor: userActor('usr_1'),
        orderId: 'ord_1',
        buyerId: 'usr_1',
        sku: 'sku_1',
        price: toAmount('CREDIT', 1n),
        recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      }),
    );
    assert.equal(outcome.status, 'rejected');
    assert.equal('detail' in outcome, true);
    // In-process, `detail` is the sole discriminant; `reason` exists only on the wire, put there
    // by encodeOutcome.
    assert.equal(Object.hasOwn(outcome, 'reason'), false);
    await economy.close();
  });

  test('the read surface carries no legacy members', async () => {
    const { memoryPorts } = await import('#src/index.ts');
    const economy = createEconomy(
      memoryPorts({ signingKey: 'no-shims-signing-key-32-bytes!!!!' }),
    );
    assert.equal('prove' in economy.read, false);
    const status = economy.read.status();
    assert.equal('paused' in status, false);
    assert.equal(typeof status.maintenanceActive, 'boolean');
    await economy.close();
  });
});
