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
import type { Route } from './+types/actions.tamper';

// The integrity theater: corrupt the books on purpose, watch the prover catch it, heal. This is
// safe to expose because every visitor's economy is their own tab's sandbox.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const op = String(form.get('op') ?? '');

  try {
    switch (op) {
      case 'tamper': {
        const { txnId, account } = await eco.tamper();
        return redirectWithFlash(
          form,
          noticeFlash(
            `Edited ${txnId} in place on ${account}. The recorded chain no longer re-derives — the chain check names the damage below.`,
            { tone: 'warn', form: 'integrity-break' },
          ),
        );
      }
      case 'drift': {
        const { account } = await eco.seedDrift();
        return redirectWithFlash(
          form,
          noticeFlash(
            `Planted a cached balance on ${account} that no posting explains. The consistency check reports it with both figures.`,
            { tone: 'warn', form: 'integrity-break' },
          ),
        );
      }
      case 'heal': {
        await eco.reset();
        clearJournal();
        return redirectWithFlash(
          form,
          noticeFlash(
            'Books rebuilt from the seed — every check re-derives green.',
            { form: 'integrity-break' },
          ),
        );
      }
      default:
        return redirectWithFlash(
          form,
          faultFlash(new Error(`Unknown operation: ${op}.`)),
        );
    }
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err, 'integrity-break'));
  }
}
