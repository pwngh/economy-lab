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

import type { Route } from './+types/actions.simulate';
import { getEconomy } from '~/economy.server';

const DAY = 86_400_000;

// The Simulation panel posts every knob here. Each branch mutates the live engine, then returns a
// short note (or an inline error) the panel renders. React Router revalidates the active page's
// loader after the action resolves, so the whole UI reflects the new engine state. This action
// never throws to the user: any failure is caught and returned as { error }.
export async function action({ request }: Route.ActionArgs) {
  const eco = await getEconomy();
  const form = await request.formData();
  const op = String(form.get('op') ?? '');

  try {
    switch (op) {
      case 'advance': {
        const days = Number(form.get('days') ?? 0);
        eco.advanceTime(days * DAY);
        return { note: `Advanced time by ${days} day(s).` };
      }
      case 'runJobs': {
        const note = await eco.runJobs();
        return { note: `Ran jobs — ${note}.` };
      }
      case 'faultOn': {
        eco.setFault(true);
        return { note: 'Tilia is now down. Run jobs to watch payouts retry.' };
      }
      case 'faultOff': {
        eco.setFault(false);
        return { note: 'Tilia is back up. Run jobs to let payouts submit.' };
      }
      case 'setMaturity': {
        const days = Number(form.get('days') ?? 0);
        await eco.setMaturityDays(days);
        return {
          note:
            days > 0
              ? `Maturity horizon set to ${days} day(s). New earned credits are now held until mature.`
              : 'Maturity horizon cleared (0 days).',
        };
      }
      case 'setMaxAttempts': {
        const n = Number(form.get('n') ?? 1);
        await eco.setMaxAttempts(n);
        return { note: `Payout retry limit set to ${n}.` };
      }
      case 'reset': {
        await eco.reset();
        return { note: 'Reset to the starting set of accounts and activity.' };
      }
      case 'clear': {
        await eco.clear();
        return { note: 'Cleared. No accounts remain.' };
      }
      default:
        return { error: `Unknown operation: ${op}.` };
    }
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? err.message
          : 'That step could not be completed.',
    };
  }
}
