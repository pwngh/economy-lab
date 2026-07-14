/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 */

import { getEngine } from '~/engine';
import {
  faultFlash,
  invalidFlash,
  noticeFlash,
  redirectWithFlash,
} from '~/flash';
import { entityName } from '~/ui';
import type { Route } from './+types/actions.reverse';

// The operator reverses a stuck payout. A success returns the reserve to the seller; the engine's
// refusal of a settled or still-live-submitted saga rides back as its SAGA.INVALID_TRANSITION code.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const sagaId = String(form.get('sagaId') ?? '').trim();
  const userId = String(form.get('userId') ?? '').trim();
  const owner = String(form.get('form') ?? '') || undefined;

  if (!sagaId || !userId) {
    return redirectWithFlash(
      form,
      invalidFlash(
        { sagaId: 'A payout id and its seller are required.' },
        owner,
      ),
    );
  }

  try {
    const outcome = await eco.reversePayout({
      sagaId,
      userId,
      reason: 'operator reversal from the console',
    });
    // A committed reversal moved the reserve; the engine returns `duplicate` (no posting) when the
    // saga already left RESERVED/SUBMITTED — say so rather than claim a reserve returned this run.
    return redirectWithFlash(
      form,
      outcome.status === 'committed'
        ? noticeFlash(
            `Payout reversed — the reserve returned to ${entityName(userId)}'s earned balance.`,
          )
        : noticeFlash('This payout was already reversed — nothing changed.'),
    );
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err, owner));
  }
}
