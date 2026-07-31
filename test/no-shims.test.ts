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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '#test/support/dist-guard.ts';

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
import type { SupervisorDeps as _T15 } from '#src/supervisor/index.ts';
// @ts-expect-error -- deleted in 0.4.0 (renamed SqsDispatcherOptions)
import type { SqsDispatcherConfig as _T16 } from '@pwngh/economy-sqs';

import { DRIVERS } from '#test/support/package-suites.ts';
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

// None of the drivers a backend package owns may reappear in the lab's own manifest. The list
// is the fan-out's, which holds it live against what the packages actually declare.

// Every engine and adapter factory that left the lab in the backend split.
const MOVED_VALUES = [
  'postgresStore',
  'mysqlStore',
  'createMysqlPool',
  'createMariadbPool',
  'applyMysqlSchema',
  'redisCache',
  'redisRateLimiter',
  'sqsDispatcher',
] as const;

const ENTRIES: Record<string, () => Promise<object>> = {
  '.': () => import('#src/index.ts'),
  './ports': () => import('#src/ports.ts'),
  './adapters': () => import('#src/adapters/index.ts'),
  '@pwngh/economy-redis': () => import('@pwngh/economy-redis'),
  '@pwngh/economy-sqs': () => import('@pwngh/economy-sqs'),
  '@pwngh/economy-postgres': () => import('@pwngh/economy-postgres'),
  '@pwngh/economy-mysql': () => import('@pwngh/economy-mysql'),
  './worker': () => import('#src/worker/index.ts'),
  './server': () => import('#src/server.ts'),
  './netting': () => import('#src/netting.ts'),
  './supervisor': () => import('#src/supervisor/index.ts'),
  './store-kit': () => import('#src/store-kit.ts'),
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

  // `./ops` became `./supervisor` in 0.8.0, and two of its names moved with it. The migration a
  // consumer is told to make is one import path plus those two names, so the promise is that
  // every other name answers unchanged on the other side of it. The roster is the shipped 0.7.0
  // tarball's, resolved from its .d.ts files; it is written out rather than derived, because a
  // roster generated from this tree would agree with this tree by construction and could never
  // catch a symbol dropped in the move.
  const SHIPPED_ON_OPS_AT_0_7_0 = [
    'AuditChainReport',
    'AuditPhase',
    'AuditRecord',
    'AuditSink',
    'DeadlockStormFinding',
    'EngineStallFinding',
    'Finding',
    'InboxDeadLetterFinding',
    'IntegrityMismatchFinding',
    'OpsRuntime',
    'OutboxBacklogFinding',
    'RetryExhaustionFinding',
    'SagaSource',
    'Signal',
    'SignalFeed',
    'SignatureName',
    'SilenceFinding',
    'SlowSealFinding',
    'StuckSagaFinding',
    'Supervisor',
    'SupervisorConfig',
    'SupervisorPorts',
    'TreasuryBreachFinding',
    'VelocityAnomalyFinding',
    'WebhookReplayStormFinding',
    'createOpsRuntime',
    'createSupervisor',
    'createSupervisorFrom',
    'defaultSupervisorConfig',
    'detectDeadlockStorm',
    'detectEngineStall',
    'detectInboxDeadLetters',
    'detectIntegrityMismatches',
    'detectOutboxBacklog',
    'detectRetryExhaustion',
    'detectSilences',
    'detectSlowSeal',
    'detectStuckSagas',
    'detectTreasuryBreaches',
    'detectVelocityAnomaly',
    'detectWebhookReplayStorm',
    'hashChainedAuditSink',
    'jsonlAuditSink',
    'verifyAuditChain',
  ] as const;

  /**
   * The two names renamed in the same major, 0.7.0's spelling to 0.8.0's.
   *
   * Held apart from the roster above rather than edited into it: the roster records what the
   * registry answers and must stay the registry's, so a rename is applied to it here and never
   * written into it. Six siblings already said supervisor, which is what made these two worth
   * moving while a major was open.
   */
  const RENAMED_ON_THE_MOVE = new Map([
    ['OpsRuntime', 'SupervisorRuntime'],
    ['createOpsRuntime', 'createSupervisorRuntime'],
  ]);

  test('./supervisor answers every name ./ops shipped, and no other', () => {
    const surface = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('./fixtures/lab-surface.json', import.meta.url)),
        'utf8',
      ),
    ) as Record<string, Record<string, string>>;
    // A rename recorded for a name the release never shipped renames nothing, and would let the
    // roster drift out from under the map that is applied to it.
    for (const old of RENAMED_ON_THE_MOVE.keys()) {
      assert.ok(
        (SHIPPED_ON_OPS_AT_0_7_0 as readonly string[]).includes(old),
        `${old} is recorded as renamed and ./ops never shipped it`,
      );
    }
    assert.deepEqual(
      Object.keys(surface['./supervisor'] ?? {}).sort(),
      SHIPPED_ON_OPS_AT_0_7_0.map(
        (name) => RENAMED_ON_THE_MOVE.get(name) ?? name,
      ).sort(),
    );
    assert.equal(SHIPPED_ON_OPS_AT_0_7_0.length, 44);
    assert.equal(RENAMED_ON_THE_MOVE.size, 2);
  });

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

  // The browser stub this used to guard is gone, because the reason for it is: the lab's main
  // entry reaches no driver at all now. That is what is guarded instead. A re-added driver would
  // put the stub, its two vite alias blocks, and four check-browser externals back.
  test('the lab declares no database, cache, or queue driver', async () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../package.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const driver of DRIVERS) {
      assert.equal(
        declared.has(driver),
        false,
        `the lab still declares "${driver}"; it belongs to a backend package now`,
      );
    }
  });

  test('no lab export names a moved backend', async () => {
    const namespace = await import('#src/index.ts');
    for (const name of MOVED_VALUES) {
      assert.equal(
        name in namespace,
        false,
        `the lab still exports "${name}", which moved to its own package`,
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
