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

import { clearJournal, getEngine } from '~/engine';
import { faultFlash, noticeFlash, redirectWithFlash } from '~/flash';
import type { Route } from './+types/actions.simulate';

const DAY = 86_400_000;

// The topbar clock, the Controls page, and the market's gate controls post every knob here; the outcome redirects
// back as a one-shot flash.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const op = String(form.get('op') ?? '');

  try {
    switch (op) {
      case 'advance': {
        const days = Number(form.get('days') ?? 0);
        eco.advanceTime(days * DAY);
        return redirectWithFlash(
          form,
          noticeFlash(
            `Advanced time by ${days} ${days === 1 ? 'day' : 'days'}.`,
          ),
        );
      }
      case 'runJobs': {
        const note = await eco.runJobs();
        return redirectWithFlash(form, noticeFlash(`Ran jobs — ${note}.`));
      }
      case 'settle': {
        const { settled } = await eco.settleSubmitted();
        return redirectWithFlash(
          form,
          noticeFlash(
            settled === 0
              ? 'No submitted payouts to settle.'
              : `Settled ${settled} payout${settled === 1 ? '' : 's'} — the seller was paid out of trust cash.`,
          ),
        );
      }
      case 'faultOn': {
        eco.setFault(true);
        return redirectWithFlash(
          form,
          noticeFlash('Tilia is now down. Run jobs to watch payouts retry.'),
        );
      }
      case 'faultOff': {
        eco.setFault(false);
        return redirectWithFlash(
          form,
          noticeFlash('Tilia is back up. Run jobs to let payouts submit.'),
        );
      }
      case 'setMaturity': {
        const days = Number(form.get('days') ?? 0);
        await eco.setMaturityDays(days);
        return redirectWithFlash(
          form,
          noticeFlash(
            days > 0
              ? `Maturity horizon set to ${days} ${days === 1 ? 'day' : 'days'}. New earned credits are now held until mature.`
              : 'Maturity horizon cleared (0 days).',
          ),
        );
      }
      case 'setMaxAttempts': {
        const n = Number(form.get('n') ?? 1);
        await eco.setMaxAttempts(n);
        return redirectWithFlash(
          form,
          noticeFlash(`Payout retry limit set to ${n}.`),
        );
      }
      case 'setVelocity': {
        const credits = Number(form.get('credits') ?? 0);
        await eco.setVelocityLimit(credits);
        return redirectWithFlash(
          form,
          noticeFlash(
            `Velocity limit set to ${credits} credits per window. A spend past it declines as RISK_DENIED.`,
          ),
        );
      }
      case 'unlockRates': {
        const r = await eco.unlockRates();
        return redirectWithFlash(
          form,
          noticeFlash(r.message, r.ok ? undefined : { tone: 'warn' }),
        );
      }
      case 'setRates': {
        const r = eco.setRates({
          buyPerThousand: Number(form.get('buy') ?? 0),
          parPerThousand: Number(form.get('par') ?? 0),
        });
        return redirectWithFlash(
          form,
          noticeFlash(r.message, r.ok ? undefined : { tone: 'warn' }),
        );
      }
      case 'lockRates': {
        const r = await eco.lockRates();
        return redirectWithFlash(form, noticeFlash(r.message));
      }
      case 'maintenanceOn': {
        await eco.setMaintenance(true);
        return redirectWithFlash(
          form,
          noticeFlash(
            'Maintenance window opened. Everyday writes decline as ECONOMY_PAUSED until you advance a day or reopen.',
          ),
        );
      }
      case 'maintenanceOff': {
        await eco.setMaintenance(false);
        return redirectWithFlash(
          form,
          noticeFlash('Maintenance window closed. Everyday writes resume.'),
        );
      }
      case 'setPayoutMin': {
        const credits = Number(form.get('credits') ?? 0);
        await eco.setPayoutMinimum(credits);
        return redirectWithFlash(
          form,
          noticeFlash(
            credits > 0
              ? `Minimum cash-out set to ${credits} credits. A smaller payout declines as BELOW_MINIMUM.`
              : 'Minimum cash-out cleared.',
          ),
        );
      }
      case 'setPayoutInterval': {
        const days = Number(form.get('days') ?? 0);
        await eco.setPayoutIntervalDays(days);
        return redirectWithFlash(
          form,
          noticeFlash(
            days > 0
              ? `Cash-out interval set to ${days} ${days === 1 ? 'day' : 'days'}. A second payout inside it declines as PAYOUT_TOO_SOON.`
              : 'Cash-out interval cleared.',
          ),
        );
      }
      case 'reset': {
        await eco.reset();
        clearJournal();
        return redirectWithFlash(
          form,
          noticeFlash('Reset to the starting set of accounts and activity.'),
        );
      }
      case 'clear': {
        await eco.clear();
        clearJournal();
        return redirectWithFlash(
          form,
          noticeFlash('Cleared. No accounts remain.'),
        );
      }
      default:
        return redirectWithFlash(
          form,
          faultFlash(new Error(`Unknown operation: ${op}.`)),
        );
    }
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err));
  }
}
