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

import { defaultConfig, loadConfig } from '#src/config.ts';
import { ERROR_CODES } from '#src/errors.ts';

const CARD_HORIZON_MS = 7 * 24 * 60 * 60_000;

describe('loadConfig maturity horizons', () => {
  test('defaults the steam and meta horizons to the card horizon', () => {
    const config = loadConfig({});

    assert.equal(config.maturityHorizonMs.steam, CARD_HORIZON_MS);
    assert.equal(config.maturityHorizonMs.meta, CARD_HORIZON_MS);
    assert.equal(config.maturityHorizonMs.default, CARD_HORIZON_MS);
  });

  test('follows a raised card horizon so the store rails stay as conservative', () => {
    const config = loadConfig({ MATURITY_HORIZON_CARD_MS: '1209600000' });

    assert.equal(config.maturityHorizonMs.steam, 1_209_600_000);
    assert.equal(config.maturityHorizonMs.meta, 1_209_600_000);
    assert.equal(config.maturityHorizonMs.default, 1_209_600_000);
  });

  test('reads a per-rail override without touching the other horizons', () => {
    const config = loadConfig({ MATURITY_HORIZON_STEAM_MS: '3600000' });

    assert.equal(config.maturityHorizonMs.steam, 3_600_000);
    assert.equal(config.maturityHorizonMs.meta, CARD_HORIZON_MS);
    assert.equal(config.maturityHorizonMs.card, CARD_HORIZON_MS);
  });

  test('ignores an unparseable override and keeps the shipped default', () => {
    const config = loadConfig({ MATURITY_HORIZON_META_MS: 'soon' });

    assert.equal(config.maturityHorizonMs.meta, CARD_HORIZON_MS);
  });
});

describe('loadConfig startup check', () => {
  test('fails in production when required secrets are missing, listing all of them', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production' }),
      (error: unknown) => {
        const fault = error as {
          code?: unknown;
          detail?: { missing?: unknown };
        };
        assert.equal(fault.code, ERROR_CODES.CONFIG_INVALID);
        assert.deepEqual(fault.detail?.missing, [
          'WEBHOOK_SECRET',
          'SIGNING_SECRET',
        ]);
        return true;
      },
    );
  });

  test('tolerates missing secrets outside production for local composition', () => {
    const config = loadConfig({});

    assert.equal(config.webhookSecret, '');
    assert.equal(config.signingSecret, '');
  });
});

describe('mergeConfig record-valued knobs', () => {
  test('overriding one funding source keeps the default fallback', () => {
    const config = defaultConfig({ maturityHorizonMs: { card: 1_000 } });

    assert.equal(config.maturityHorizonMs.card, 1_000);
    assert.equal(
      config.maturityHorizonMs.default,
      defaultConfig().maturityHorizonMs.default,
    );
  });

  test('overriding one payout SLA step keeps the others', () => {
    const config = defaultConfig({ payoutSla: { PENDING: 5 } });

    assert.equal(config.payoutSla.PENDING, 5);
    assert.equal(config.payoutSla.DEFAULT, defaultConfig().payoutSla.DEFAULT);
  });

  test('scalar knobs stay last-wins', () => {
    const config = defaultConfig({ platformShards: 4 });

    assert.equal(config.platformShards, 4);
  });
});
