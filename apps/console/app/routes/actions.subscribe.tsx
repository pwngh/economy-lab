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
import type { Route } from './+types/actions.subscribe';

const FORM = 'market-subscribe';

// The subscriptions card posts here: open one (the engine refuses a second active subscription
// for the same user/sku/seller), or cancel by id. Outcomes ride back as form-owned flashes.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const op = String(form.get('op') ?? '');

  try {
    if (op === 'subscribe') {
      const userId = String(form.get('user') ?? '');
      const sellerId = String(form.get('seller') ?? '');
      const sku = String(form.get('sku') ?? '').trim();
      const price = Number(form.get('credits') ?? 0);
      const periodDays = Number(form.get('days') ?? 0);

      const fields: Record<string, string> = {};
      if (userId === '') fields.user = 'Choose a subscriber.';
      if (sellerId === '') fields.seller = 'Choose a seller.';
      if (sku === '') fields.sku = 'Name the subscription.';
      if (!(price > 0)) fields.credits = 'Enter a positive amount.';
      if (!(periodDays > 0)) fields.days = 'Enter a positive period.';
      if (Object.keys(fields).length > 0) {
        return redirectWithFlash(form, invalidFlash(fields, FORM));
      }

      const outcome = await eco.subscribe({
        userId,
        sellerId,
        sku,
        credits: price,
        periodDays,
      });
      if (outcome.status === 'committed') {
        return redirectWithFlash(
          form,
          noticeFlash(
            `Subscribed — the first period was charged now; the worker renews it every ${periodDays} ${periodDays === 1 ? 'day' : 'days'}.`,
            { form: FORM },
          ),
        );
      }
      if (outcome.status === 'duplicate') {
        return redirectWithFlash(
          form,
          noticeFlash('Replayed: this subscription was already opened.', {
            form: FORM,
          }),
        );
      }
      return redirectWithFlash(
        form,
        outcomeFlash(outcome.detail.reason, outcome.detail, FORM),
      );
    }

    if (op === 'cancel') {
      const outcome = await eco.cancelSubscription({
        subscriptionId: String(form.get('id') ?? ''),
      });
      return redirectWithFlash(
        form,
        outcome.status === 'committed'
          ? noticeFlash('Canceled — no further renewals will be charged.', {
              form: FORM,
            })
          : outcomeFlash(
              outcome.status === 'rejected'
                ? outcome.detail.reason
                : 'DUPLICATE',
              outcome.status === 'rejected' ? outcome.detail : {},
              FORM,
            ),
      );
    }

    return redirectWithFlash(
      form,
      faultFlash(new Error(`Unknown operation: ${op}.`)),
    );
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err, FORM));
  }
}
