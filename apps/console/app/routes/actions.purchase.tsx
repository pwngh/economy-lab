/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * A buy: split the buyer's credits to the seller's earned balance. A rejection or thrown fault
 * redirects back with its reason code verbatim; malformed input redirects with per-field errors
 * before any submit. A gift lands the entitlement on the recipient.
 */

import { principal } from '~/actor';
import { getEngine } from '~/engine';
import {
  faultFlash,
  invalidFlash,
  noticeFlash,
  outcomeFlash,
  redirectWithFlash,
} from '~/flash';
import { entityName } from '~/ui';
import type { Route } from './+types/actions.purchase';

export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const owner = String(form.get('form') ?? '') || undefined;
  const user = String(form.get('user') ?? '').trim();
  const seller = String(form.get('seller') ?? '').trim();
  const amount = Number(form.get('credits') ?? 0);

  const fields: Record<string, string> = {};
  if (!user) {
    fields.user = 'A user id is required.';
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    fields.credits = 'Enter a credit amount greater than zero.';
  }
  if (!seller) {
    fields.seller = 'A seller id is required for a purchase.';
  }
  if (Object.keys(fields).length > 0) {
    return redirectWithFlash(form, invalidFlash(fields, owner));
  }

  const actorField = String(form.get('actor') ?? '');
  const actor = actorField ? principal(actorField) : undefined;
  const listing = String(form.get('listing') ?? '').trim() || 'Listing';
  const giftTo = String(form.get('giftTo') ?? '').trim() || undefined;

  try {
    const outcome = await eco.purchase({
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
    if (outcome.status === 'rejected') {
      return redirectWithFlash(
        form,
        outcomeFlash(outcome.detail.reason, outcome.detail, owner),
      );
    }
    return redirectWithFlash(form, noticeFlash('Recorded purchase.'));
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err, owner));
  }
}
