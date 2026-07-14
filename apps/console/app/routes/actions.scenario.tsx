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

import { redirect } from 'react-router';

import { DAY_MS } from '~/demo';
import { getEngine } from '~/engine';
import {
  faultFlash,
  noticeFlash,
  outcomeFlash,
  redirectWithFlash,
} from '~/flash';
import type { Flash } from '~/flash';
import type { Route } from './+types/actions.scenario';

// One-click stories, each composed from the same facade calls the forms make, each landing on the
// page where its consequence is visible. A scenario stages state; it never bypasses a gate.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const op = String(form.get('op') ?? '');

  // Scenario redirects go where the consequence is, not back to the posting page.
  function land(path: string, flash: Flash): Response {
    return redirectWithFlash(form, flash, path);
  }

  try {
    switch (op) {
      case 'outage': {
        eco.setFault(true);
        await eco.requestPayout({ userId: 'usr_nova', credits: 30 });
        eco.advanceTime(DAY_MS);
        await eco.runJobs();
        return land(
          '/payouts',
          noticeFlash(
            'Tilia is down and a fresh payout just failed its first attempt. Run jobs to watch retries climb, or bring the provider back on Controls.',
            { tone: 'warn' },
          ),
        );
      }
      case 'maintenance': {
        await eco.setMaintenance(true);
        return land(
          '/market',
          noticeFlash(
            'A maintenance window is open: every user write now declines as ECONOMY_PAUSED. Try a purchase, then advance a day to reopen.',
            { tone: 'warn' },
          ),
        );
      }
      case 'race': {
        const tally = await eco.raceOrder({
          buyerId: 'usr_alice',
          sellerId: 'usr_nova',
          listing: 'Scenario Race Listing',
          credits: 200,
          count: 8,
        });
        return land('/market#race', {
          kind: 'race',
          form: 'market-break',
          mode: 'order',
          ...tally,
        });
      }
      case 'immature': {
        await eco.setMaturityDays(30);
        await eco.purchase({
          buyerId: 'usr_bjorn',
          sellerId: 'usr_pixel',
          listing: 'Fresh Earnings Pass',
          credits: 300,
        });
        const outcome = await eco.requestPayout({
          userId: 'usr_pixel',
          credits: 300,
        });
        if (outcome.status === 'rejected') {
          return land(
            '/market',
            outcomeFlash(outcome.reason, outcome.detail ?? {}, 'market-payout'),
          );
        }
        return land(
          '/market',
          noticeFlash('The payout cleared — earnings were already mature.'),
        );
      }
      case 'tamper': {
        const { txnId, account } = await eco.tamper();
        return land(
          '/integrity',
          noticeFlash(
            `Edited ${txnId} in place on ${account}. The full audit below re-derives the chain and catches it.`,
            { tone: 'warn', form: 'integrity-break' },
          ),
        );
      }
      default:
        return redirect('/');
    }
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err));
  }
}
