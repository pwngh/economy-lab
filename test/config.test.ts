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

import { defaultConfig, loadConfig, loadSecrets } from '#src/config.ts';
import { ERROR_CODES } from '#src/errors.ts';

const CARD_HORIZON_MS = 7 * 24 * 60 * 60_000;

describe('loadConfig maturity horizons', () => {
  test('outside production every horizon defaults to 0, so the quickstart clears instantly', () => {
    const config = loadConfig({});

    assert.deepEqual(config.maturityHorizonMs, {
      card: 0,
      crypto: 0,
      steam: 0,
      meta: 0,
      default: 0,
    });
  });

  test('every rail follows a raised card horizon, the conservative anchor', () => {
    const config = loadConfig({ MATURITY_HORIZON_CARD_MS: '1209600000' });

    assert.equal(config.maturityHorizonMs.crypto, 1_209_600_000);
    assert.equal(config.maturityHorizonMs.steam, 1_209_600_000);
    assert.equal(config.maturityHorizonMs.meta, 1_209_600_000);
    assert.equal(config.maturityHorizonMs.default, 1_209_600_000);
  });

  test('reads a per-rail override without touching the other horizons', () => {
    const config = loadConfig({
      MATURITY_HORIZON_CARD_MS: String(CARD_HORIZON_MS),
      MATURITY_HORIZON_STEAM_MS: '3600000',
    });

    assert.equal(config.maturityHorizonMs.steam, 3_600_000);
    assert.equal(config.maturityHorizonMs.meta, CARD_HORIZON_MS);
    assert.equal(config.maturityHorizonMs.card, CARD_HORIZON_MS);
  });

  test('ignores an unparseable override and falls back to the card anchor', () => {
    const config = loadConfig({
      MATURITY_HORIZON_CARD_MS: String(CARD_HORIZON_MS),
      MATURITY_HORIZON_META_MS: 'soon',
    });

    assert.equal(config.maturityHorizonMs.meta, CARD_HORIZON_MS);
  });

  test('production requires the card horizon, named in the fail-fast', () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          VELOCITY_LIMIT_MINOR: '100000',
        }),
      (error: unknown) => {
        const fault = error as {
          code?: unknown;
          detail?: { missing?: unknown };
        };
        assert.equal(fault.code, ERROR_CODES.CONFIG_INVALID);
        assert.deepEqual(fault.detail?.missing, ['MATURITY_HORIZON_CARD_MS']);
        return true;
      },
    );
  });

  test('production requires the velocity ceiling, named in the fail-fast', () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          MATURITY_HORIZON_CARD_MS: String(CARD_HORIZON_MS),
        }),
      (error: unknown) => {
        const fault = error as {
          code?: unknown;
          detail?: { missing?: unknown };
        };
        assert.equal(fault.code, ERROR_CODES.CONFIG_INVALID);
        assert.deepEqual(fault.detail?.missing, ['VELOCITY_LIMIT_MINOR']);
        return true;
      },
    );
  });

  test('production with the anchors stated loads clean', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      MATURITY_HORIZON_CARD_MS: String(CARD_HORIZON_MS),
      VELOCITY_LIMIT_MINOR: '5000000',
    });

    assert.equal(config.maturityHorizonMs.card, CARD_HORIZON_MS);
    assert.equal(config.velocityLimitMinor, 5_000_000n);
  });
});

describe('loadConfig purchase catalog', () => {
  test('unset leaves the catalog absent, so any positive top-up is accepted', () => {
    const config = loadConfig({});

    assert.equal(config.topUpBundlesMinor, undefined);
  });

  test('parses, dedupes, and sorts the bundle list', () => {
    const config = loadConfig({
      TOP_UP_BUNDLES_MINOR: '120000,60000,120000',
    });

    assert.deepEqual(config.topUpBundlesMinor, [60_000n, 120_000n]);
  });

  test('a malformed entry fails startup — the fallback here would be an unenforced catalog', () => {
    assert.throws(
      () => loadConfig({ TOP_UP_BUNDLES_MINOR: '60000,not-a-number' }),
      (error: Error) => (error as { code?: string }).code === 'CONFIG.INVALID',
    );
  });

  test('a zero bundle fails startup — bundles must be purchasable amounts', () => {
    assert.throws(
      () => loadConfig({ TOP_UP_BUNDLES_MINOR: '0,60000' }),
      (error: Error) => (error as { code?: string }).code === 'CONFIG.INVALID',
    );
  });

  test('a bundle above the submit amount ceiling fails startup', () => {
    assert.throws(
      () => loadConfig({ TOP_UP_BUNDLES_MINOR: '1000000000000000001' }),
      (error: Error) => (error as { code?: string }).code === 'CONFIG.INVALID',
    );
  });

  test('the stored catalog is frozen', () => {
    const config = loadConfig({ TOP_UP_BUNDLES_MINOR: '60000' });

    assert.ok(Object.isFrozen(config.topUpBundlesMinor));
  });

  test('an override supplies the catalog through defaultConfig', () => {
    const config = defaultConfig({ topUpBundlesMinor: [60_000n] });

    assert.deepEqual(config.topUpBundlesMinor, [60_000n]);
  });
});

describe('loadConfig startup check', () => {
  test('fails in production when the policy anchors are missing, listing all of them', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production' }),
      (error: unknown) => {
        const fault = error as {
          code?: unknown;
          detail?: { missing?: unknown };
        };
        assert.equal(fault.code, ERROR_CODES.CONFIG_INVALID);
        assert.deepEqual(fault.detail?.missing, [
          'MATURITY_HORIZON_CARD_MS',
          'VELOCITY_LIMIT_MINOR',
        ]);
        return true;
      },
    );
  });
});

describe('loadSecrets startup check', () => {
  test('fails in production when required secrets are missing, listing all of them', () => {
    assert.throws(
      () => loadSecrets({ NODE_ENV: 'production' }),
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

  test('an override fills a secret the env leaves blank', () => {
    const secrets = loadSecrets(
      { NODE_ENV: 'production', WEBHOOK_SECRET: 'wh' },
      { signingSecret: 'sg' },
    );

    assert.equal(secrets.webhookSecret, 'wh');
    assert.equal(secrets.signingSecret, 'sg');
  });

  test('tolerates missing secrets outside production for local composition', () => {
    const secrets = loadSecrets({});

    assert.equal(secrets.webhookSecret, '');
    assert.equal(secrets.signingSecret, '');
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
