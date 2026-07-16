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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { economyFromCapabilities } from '#src/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
} from '#test/support/capabilities.ts';

// Config is read live on every submit while velocityWindowMs is captured at store construction,
// so a runtime mutation would half-apply. The freeze makes "a config change requires a rebuild"
// uniformly true: mutation throws instead of half-working.
describe('economyFromCapabilities freezes its config', () => {
  function build() {
    const digest = seededDigest(1);
    const clock = fixedClock(0);
    const config = testConfig();
    economyFromCapabilities({
      store: memoryStore({ digest, clock }),
      clock,
      ids: sequentialIds(),
      digest,
      signer: seededSigner(1),
      rates: fixedRates(),
      logger: testLogger(),
      meter: noopMeter(),
      processor: fakeProcessor(),
      pricing: defaultPricing(),
      config,
    });
    return config;
  }

  test('mutating a scalar knob throws', () => {
    const config = build();
    assert.throws(() => {
      config.velocityLimitMinor = 1n;
    }, TypeError);
  });

  test('mutating a record-valued knob throws', () => {
    const config = build();
    assert.throws(() => {
      config.maturityHorizonMs.default = 1;
    }, TypeError);
    assert.throws(() => {
      config.payoutSla.PENDING = 1;
    }, TypeError);
  });
});
