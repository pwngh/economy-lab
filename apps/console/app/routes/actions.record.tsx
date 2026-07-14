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
  noticeFlash,
  outcomeFlash,
  redirectWithFlash,
} from '~/flash';
import { entityName } from '~/ui';
import type { Outcome, Principal } from '#src/index.ts';
import type { Route } from './+types/actions.record';

const TYPE_LABEL: Record<string, string> = {
  deposit: 'deposit',
  promo: 'promo grant',
  payout: 'payout request',
  purchase: 'purchase',
};

// The acting-as selection as a principal. Only the market's spend and payout carry it, so an
// unknown value defaults to the platform system actor, the console's own operator view.
function principal(actor: string): Principal {
  if (actor === 'operator') {
    return { kind: 'operator', operatorId: 'ops_console' };
  }
  if (/^usr_[a-z0-9_]+$/.test(actor)) {
    return { kind: 'user', userId: actor };
  }
  return { kind: 'system', service: 'console' };
}

// Submit one operation through the engine. A rejection or a thrown fault redirects back carrying
// its reason code verbatim; malformed input redirects with per-field errors before any submit. The
// hidden `form` field names the owning form so the outcome renders in place.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const type = String(form.get('type') ?? '');
  const user = String(form.get('user') ?? '').trim();
  const owner = String(form.get('form') ?? '') || undefined;
  const amount = Number(form.get('credits') ?? 0);

  const fields: Record<string, string> = {};
  if (!user) {
    fields.user = 'A user id is required.';
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    fields.credits = 'Enter a credit amount greater than zero.';
  }
  let seller = '';
  if (type === 'purchase') {
    seller = String(form.get('seller') ?? '').trim();
    if (!seller) {
      fields.seller = 'A seller id is required for a purchase.';
    }
  }
  if (Object.keys(fields).length > 0) {
    return redirectWithFlash(form, invalidFlash(fields, owner));
  }

  const actorField = String(form.get('actor') ?? '');
  const actor = actorField ? principal(actorField) : undefined;

  try {
    let outcome: Outcome;
    if (type === 'deposit') {
      outcome = await eco.deposit({ userId: user, credits: amount });
    } else if (type === 'promo') {
      outcome = await eco.grantPromo({ userId: user, credits: amount });
    } else if (type === 'payout') {
      outcome = await eco.requestPayout({
        userId: user,
        credits: amount,
        actor,
      });
    } else if (type === 'purchase') {
      const listing = String(form.get('listing') ?? '').trim() || 'Listing';
      const giftTo = String(form.get('giftTo') ?? '').trim() || undefined;
      outcome = await eco.purchase({
        buyerId: user,
        sellerId: seller,
        listing,
        credits: amount,
        actor,
        orderId: String(form.get('orderId') ?? '').trim() || undefined,
        giftTo,
      });
      // A committed gift lands the entitlement on the recipient, not the buyer — say so.
      if (outcome.status === 'committed' && giftTo) {
        return redirectWithFlash(
          form,
          noticeFlash(`Gifted ${listing} to ${entityName(giftTo)}.`),
        );
      }
    } else {
      return redirectWithFlash(
        form,
        invalidFlash({ type: `Unknown record type: ${type}.` }, owner),
      );
    }

    if (outcome.status === 'rejected') {
      return redirectWithFlash(
        form,
        outcomeFlash(outcome.reason, outcome.detail ?? {}, owner),
      );
    }
    return redirectWithFlash(
      form,
      noticeFlash(`Recorded ${TYPE_LABEL[type] ?? type}.`),
    );
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err, owner));
  }
}
