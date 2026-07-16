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
});
