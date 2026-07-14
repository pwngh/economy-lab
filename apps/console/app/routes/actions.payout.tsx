/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * A payout request: a seller cashes out earned credits, reserving them into a saga. A rejection
 * (below minimum, too soon, still maturing, short of balance) rides back with its reason code;
 * malformed input redirects with per-field errors before any submit.
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
import type { Route } from './+types/actions.payout';

export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const owner = String(form.get('form') ?? '') || undefined;
  const user = String(form.get('user') ?? '').trim();
  const amount = Number(form.get('credits') ?? 0);

  const fields: Record<string, string> = {};
  if (!user) {
    fields.user = 'A user id is required.';
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    fields.credits = 'Enter a credit amount greater than zero.';
  }
  if (Object.keys(fields).length > 0) {
    return redirectWithFlash(form, invalidFlash(fields, owner));
  }

  const actorField = String(form.get('actor') ?? '');
  const actor = actorField ? principal(actorField) : undefined;

  try {
    const outcome = await eco.requestPayout({
      userId: user,
      credits: amount,
      actor,
    });
    if (outcome.status === 'rejected') {
      return redirectWithFlash(
        form,
        outcomeFlash(outcome.reason, outcome.detail ?? {}, owner),
      );
    }
    return redirectWithFlash(form, noticeFlash('Recorded payout request.'));
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err, owner));
  }
}
