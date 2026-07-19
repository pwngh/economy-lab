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
 * A malformed service must fail at wiring time, not deep inside a request or sweep. The
 * classic slip is passing a factory (silentLogger) where its product (silentLogger()) belongs;
 * unvalidated, that surfaces days later as a retryable sweep failure that can wedge a
 * payout in SUBMITTED forever.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorker,
  createEconomy,
  openPorts,
  preflight,
  systemActor,
  toAmount,
  topUp,
} from '#src/index.ts';
import { silentLogger } from '#src/runtime.ts';
import { hasCode } from '#test/support/capabilities.ts';

import type {
  Anchor,
  Checkpoint,
  Clock,
  Dispatcher,
  Logger,
  PayeeDirectory,
  Processor,
  Signer,
} from '#src/ports.ts';

describe('wiring rejects malformed services at startup', () => {
  test('a logger factory passed where its product belongs is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts({}, { logger: silentLogger as unknown as Logger }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a clock without now() is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts({}, { clock: {} as Clock }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a processor without submitPayout is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts({}, { processor: {} as Processor }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a signer without verify is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts(
        {},
        { signer: { sign: async () => new Uint8Array() } as unknown as Signer },
      ),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('well-formed services wire clean', async () => {
    const ports = await openPorts({}, { logger: silentLogger() });
    assert.equal(typeof ports.logger.log, 'function');
    await ports.store.close();
  });

  test('an anchor without publish is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts({}, { anchor: {} as Anchor }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a signature under a rotated-out secret verifies only while the priors list it', async () => {
    const payload = new TextEncoder().encode('checkpoint-root');
    const old = await openPorts(
      {},
      { secrets: { signingSecret: 'old-secret' } },
    );
    const signature = await old.signer.sign(payload);
    await old.store.close();

    const rotated = await openPorts(
      {},
      {
        secrets: {
          signingSecret: 'new-secret',
          signingSecretsPrior: ['old-secret'],
        },
      },
    );
    assert.equal(await rotated.signer.verify(payload, signature), true);
    // The new key signs fresh payloads that verify without the prior list.
    const fresh = await rotated.signer.sign(payload);
    await rotated.store.close();
    const current = await openPorts(
      {},
      { secrets: { signingSecret: 'new-secret' } },
    );
    assert.equal(await current.signer.verify(payload, fresh), true);

    // Dropping the prior secret is exactly what breaks old checkpoints.
    assert.equal(await current.signer.verify(payload, signature), false);
    await current.store.close();
  });
});

describe('preflight and openPorts agree at the construction seam', () => {
  const errors = (
    env: Record<string, string>,
    init: Parameters<typeof preflight>[1],
  ) => preflight(env, init).filter((issue) => issue.severity === 'error');

  // Production fully configured except the two policy anchors, every optional port declined.
  const productionEnv = {
    NODE_ENV: 'production',
    WEBHOOK_SECRET: 'w',
    SIGNING_SECRET: 's',
    CREDIT_BUY_RATE: '8333',
    CREDIT_BUY_SCALE: '6',
    CREDIT_PAR_RATE: '5',
    CREDIT_PAR_SCALE: '3',
    PAYOUT_RATE: '5',
    PAYOUT_SCALE: '3',
    PROCESSOR_URL: 'https://payouts.example',
    DISPATCHER_DECLINED: '1',
    PAYEES_DECLINED: '1',
    ANCHOR_DECLINED: '1',
  };

  test('policy anchors supplied via the init satisfy production for both', async () => {
    const init = {
      config: { maturityHorizonMs: { card: 0 }, velocityLimitMinor: 100_000n },
      logger: silentLogger(),
    };
    assert.deepEqual(errors(productionEnv, init), []);
    const ports = await openPorts(productionEnv, init);
    assert.equal(ports.config.velocityLimitMinor, 100_000n);
    await ports.store.close();
  });

  test('an object passed where the dispatch function belongs fails both', async () => {
    const init = {
      dispatcher: { dispatch: async () => {} } as unknown as Dispatcher,
      logger: silentLogger(),
    };
    assert.ok(errors({}, init).some((issue) => issue.path === 'dispatcher'));
    await assert.rejects(openPorts({}, init), hasCode('CONFIG.INVALID'));
  });

  test('a payees directory without status fails both', async () => {
    const init = {
      payees: {} as PayeeDirectory,
      logger: silentLogger(),
    };
    assert.ok(errors({}, init).some((issue) => issue.path === 'payees'));
    await assert.rejects(openPorts({}, init), hasCode('CONFIG.INVALID'));
  });

  test('a decline flag shadowing a configured source is a warning, not an error', () => {
    const env = {
      ...productionEnv,
      DISPATCHER_URL: 'https://dispatch.example',
    };
    const init = {
      config: { maturityHorizonMs: { card: 0 }, velocityLimitMinor: 100_000n },
    };
    assert.deepEqual(errors(env, init), []);
    assert.ok(
      preflight(env, init).some(
        (issue) => issue.severity === 'warning' && issue.path === 'dispatcher',
      ),
    );
  });
});

describe('the anchor rides composition into the checkpoint seal', () => {
  test('an anchor in the init reaches the ports bag', async () => {
    const anchor: Anchor = { publish: async () => {} };
    const ports = await openPorts({}, { anchor, logger: silentLogger() });
    assert.equal(ports.anchor, anchor);
    await ports.store.close();
  });

  test('a sealed checkpoint reaches the wired anchor', async () => {
    const published: Checkpoint[] = [];
    const anchor: Anchor = {
      publish: async (checkpoint) => {
        published.push(checkpoint);
      },
    };
    const ports = await openPorts({}, { anchor, logger: silentLogger() });
    const economy = createEconomy(ports);
    await economy.submit(
      topUp({
        idempotencyKey: 'idem_anchor',
        actor: systemActor('test'),
        userId: 'usr_anchor',
        amount: toAmount('CREDIT', 100n),
        source: 'card',
      }),
    );
    const worker = createWorker(ports, economy);
    const run = await worker.sweep({ now: 1_000, limit: 10 });

    assert.equal(run.batch.checkpoint.ok, true);
    assert.equal(published.length, 1);
    await economy.close();
  });
});
