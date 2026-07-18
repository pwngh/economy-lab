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
 * classic slip is passing a factory (noopLogger) where its product (noopLogger()) belongs;
 * unvalidated, that surfaces days later as a retryable sweep failure that can wedge a
 * payout in SUBMITTED forever.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  capabilitiesFromEnv,
  externalsFromEnv,
  noopLogger,
} from '#src/index.ts';
import { hasCode } from '#test/support/capabilities.ts';

import type { Clock, Logger, Processor } from '#src/ports.ts';

describe('wiring rejects malformed services at startup', () => {
  test('a logger factory passed where its product belongs is CONFIG.INVALID', async () => {
    await assert.rejects(
      capabilitiesFromEnv({}, externalsFromEnv({}), {
        logger: noopLogger as unknown as Logger,
      }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a clock without now() is CONFIG.INVALID', async () => {
    await assert.rejects(
      capabilitiesFromEnv({}, externalsFromEnv({}), {
        clock: {} as Clock,
      }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a processor without submitPayout is CONFIG.INVALID in externalsFromEnv', () => {
    assert.throws(
      () => externalsFromEnv({}, { processor: {} as Processor }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('ports handed straight to capabilitiesFromEnv are checked too', async () => {
    const ports = externalsFromEnv({});
    await assert.rejects(
      capabilitiesFromEnv(
        {},
        {
          ...ports,
          signer: { sign: async () => new Uint8Array() } as never,
        },
      ),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('well-formed services wire clean', async () => {
    const caps = await capabilitiesFromEnv({}, externalsFromEnv({}), {
      logger: noopLogger(),
    });
    assert.equal(typeof caps.logger.log, 'function');
    await caps.store.close();
  });

  test('a signature under a rotated-out secret verifies only while SIGNING_SECRETS_PRIOR lists it', async () => {
    const payload = new TextEncoder().encode('checkpoint-root');
    const old = externalsFromEnv({ SIGNING_SECRET: 'old-secret' });
    const signature = await old.signer.sign(payload);

    const rotated = externalsFromEnv({
      SIGNING_SECRET: 'new-secret',
      SIGNING_SECRETS_PRIOR: 'old-secret',
    });
    assert.equal(await rotated.signer.verify(payload, signature), true);
    // The new key signs fresh payloads that verify without the prior list.
    const fresh = await rotated.signer.sign(payload);
    const current = externalsFromEnv({ SIGNING_SECRET: 'new-secret' });
    assert.equal(await current.signer.verify(payload, fresh), true);

    // Dropping the prior secret is exactly what breaks old checkpoints.
    const replaced = externalsFromEnv({ SIGNING_SECRET: 'new-secret' });
    assert.equal(await replaced.signer.verify(payload, signature), false);
  });
});
