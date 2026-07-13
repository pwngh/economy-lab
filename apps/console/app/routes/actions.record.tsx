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

import type { Route } from './+types/actions.record';
import { getEconomy } from '~/economy.server';
import { humanReason } from '~/views.server';

// Plain-English text for a rejection code. A rejection is the engine declining a valid request for
// a business reason (immature funds, below minimum); it comes back as data, not a thrown fault.
const REJECTION_TEXT: Record<string, string> = {
  FUNDS_IMMATURE:
    'Those earned credits have not matured yet. Advance time past the maturity horizon, then try again.',
  INSUFFICIENT_FUNDS: 'Not enough balance for this amount.',
  BELOW_MINIMUM: 'Below the minimum payout amount.',
  PAYOUT_TOO_SOON: 'Another payout was requested too recently for this user.',
  DUPLICATE_ORDER: 'That order has already been recorded.',
};
function rejectionText(code: string): string {
  return REJECTION_TEXT[code] ?? `Declined: ${humanReason(code)}.`;
}

const TYPE_LABEL: Record<string, string> = {
  deposit: 'deposit',
  promo: 'promo grant',
  payout: 'payout request',
  purchase: 'purchase',
};

// The record action: submit one operation through the engine. A rejection renders as an inline
// notice; a thrown fault (malformed input) is caught and returned the same way.
export async function action({ request }: Route.ActionArgs) {
  const eco = await getEconomy();
  const form = await request.formData();
  const type = String(form.get('type') ?? '');
  const user = String(form.get('user') ?? '').trim();
  const amount = Number(form.get('credits') ?? 0);

  if (!user) {
    return { error: 'A user id is required.' };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'Enter a credit amount greater than zero.' };
  }

  try {
    let outcome;
    if (type === 'deposit') {
      outcome = await eco.deposit({ userId: user, credits: amount });
    } else if (type === 'promo') {
      outcome = await eco.grantPromo({ userId: user, credits: amount });
    } else if (type === 'payout') {
      outcome = await eco.requestPayout({ userId: user, credits: amount });
    } else if (type === 'purchase') {
      const seller = String(form.get('seller') ?? '').trim();
      if (!seller) {
        return { error: 'A seller id is required for a purchase.' };
      }
      outcome = await eco.purchase({
        buyerId: user,
        sellerId: seller,
        listing: String(form.get('listing') ?? '').trim() || 'Listing',
        credits: amount,
      });
    } else {
      return { error: `Unknown record type: ${type}.` };
    }

    if (outcome.status === 'rejected') {
      return { error: rejectionText(outcome.reason) };
    }
    return { note: `Recorded ${TYPE_LABEL[type] ?? type}.`, ok: true };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'The operation failed.',
    };
  }
}
