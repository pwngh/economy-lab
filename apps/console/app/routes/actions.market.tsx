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

import { getEngine } from '~/engine';
import {
  faultFlash,
  invalidFlash,
  redirectBack,
  redirectWithFlash,
} from '~/flash';
import { setRaceTally } from '~/race';
import type { Route } from './+types/actions.market';

// The try-to-break-it bursts: `order` fires one order id many times (idempotency holds, the
// balance moves once), `drain` fires fresh ids at a thin wallet (the funds gate holds). The tally
// rides back in its own slot (~/race), rendered beside the burst form by the break-harness card.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const op = String(form.get('op') ?? '');
  const buyerId = String(form.get('buyer') ?? '').trim();
  const sellerId = String(form.get('seller') ?? '').trim();
  const listing =
    String(form.get('listing') ?? '').trim() || 'Stress-test listing';
  const credits = Number(form.get('credits') ?? 0);
  const count = Number(form.get('count') ?? 4);

  if (!buyerId || !sellerId) {
    return redirectWithFlash(
      form,
      invalidFlash(
        { buyer: 'A buyer and a seller are required.' },
        'market-break',
      ),
    );
  }

  const input = { buyerId, sellerId, listing, credits, count };
  try {
    const result =
      op === 'drain'
        ? await eco.drainWallet(input)
        : await eco.raceOrder(input);

    setRaceTally({
      mode: op === 'drain' ? 'drain' : 'order',
      attempts: result.attempts,
      committed: result.committed,
      duplicates: result.duplicates,
      insufficient: result.insufficient,
      other: result.other,
      movedCredits: result.movedCredits,
    });
    return redirectBack(form);
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err, 'market-break'));
  }
}
