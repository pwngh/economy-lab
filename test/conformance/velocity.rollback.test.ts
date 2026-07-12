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
 * A denied attempt must still count toward the velocity window after a real rollback.
 *
 * The velocity attempt rides the money transaction, so a rejection's rollback erases it; what
 * keeps the count is `submit` re-recording the attempt on the store's own connection. The
 * in-memory suite covers that logic. This one drives it through Postgres's and MySQL's actual
 * ROLLBACK, where a lost attempt would let the limit be probed for free. Both denial paths run:
 * a funds rejection (risk passed, money failed) and a risk denial (the gate itself said no).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spendable } from '#src/accounts.ts';
import { makeEconomy } from '#test/support/economy.ts';
import {
  makeIsolatedMysqlStore,
  makeIsolatedPostgresStore,
  testMysqlUrl,
  testPostgresUrl,
} from '#test/support/adapters.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';
import { credit, spend, topUp } from '#test/support/builders.ts';

import type { Store } from '#src/ports.ts';

// Enough for the top-up (500) and the unaffordable spend (1,000), but under the third attempt's
// running total, so the same window drives both denial paths.
const VELOCITY_LIMIT_MINOR = 5_000n;

const backends = [
  {
    name: 'postgres',
    build: async (): Promise<Store> =>
      makeIsolatedPostgresStore({
        url: testPostgresUrl(process.env),
        digest: seededDigest(1),
        clock: fixedClock(0),
      }),
  },
  {
    name: 'mysql',
    build: async (): Promise<Store> => {
      const url = testMysqlUrl(process.env);
      if (url === null) {
        throw new Error('no MySQL URL configured');
      }
      return makeIsolatedMysqlStore({
        url,
        digest: seededDigest(1),
        clock: fixedClock(0),
      });
    },
  },
];

describe('velocity attempts survive a real rollback', () => {
  for (const backend of backends) {
    describe(backend.name, () => {
      let store: Store | null = null;

      before(async () => {
        try {
          store = await backend.build();
        } catch {
          store = null;
        }
      });
      after(async () => {
        if (store) {
          await store.close();
        }
      });

      test('funds-rejected and risk-denied attempts still count', async (t) => {
        if (!store) {
          t.skip(`${backend.name} unreachable`);
          return;
        }
        const economy = makeEconomy(1, store, {
          velocityLimitMinor: VELOCITY_LIMIT_MINOR,
        });
        const buyer = 'usr_velo_rb';

        const funded = await economy.submit(
          topUp({ userId: buyer, amount: credit('5.00') }),
        );
        assert.equal(funded.status, 'committed');
        const afterTopUp = await store.trust.read(buyer);

        // Risk passes (total stays under the limit) but the buyer holds 5.00, so the money
        // transaction rejects and rolls back. The attempt must still land in the window.
        const broke = await economy.submit(
          spend({
            buyerId: buyer,
            sku: 'sku_velo_rb',
            price: credit('10.00'),
            orderId: 'ord_velo_rb_1',
          }),
        );
        assert.equal(broke.status, 'rejected');
        assert.equal(
          (broke as Extract<typeof broke, { status: 'rejected' }>).reason,
          'INSUFFICIENT_FUNDS',
        );
        const afterBroke = await store.trust.read(buyer);
        assert.equal(afterBroke.attempts, afterTopUp.attempts + 1);
        assert.equal(afterBroke.spent.minor, afterTopUp.spent.minor + 1_000n);

        // Now the gate itself denies: this attempt pushes the running total past the limit.
        // Its rollback is the RISK_DENIED path, and it too must still count.
        const denied = await economy.submit(
          spend({
            buyerId: buyer,
            sku: 'sku_velo_rb',
            price: credit('40.00'),
            orderId: 'ord_velo_rb_2',
          }),
        );
        assert.equal(denied.status, 'rejected');
        assert.equal(
          (denied as Extract<typeof denied, { status: 'rejected' }>).reason,
          'RISK_DENIED',
        );
        const afterDenied = await store.trust.read(buyer);
        assert.equal(afterDenied.attempts, afterBroke.attempts + 1);
        assert.equal(afterDenied.spent.minor, afterBroke.spent.minor + 4_000n);

        // The rejections moved no money: the buyer still holds exactly the top-up.
        const balance = await store.ledger.balance(spendable(buyer));
        assert.equal(balance.minor, 500n);
      });
    });
  }
});
