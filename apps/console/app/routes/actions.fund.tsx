/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * Fund a wallet: top up purchased credits (deposit) or grant promotional credits (promo) — the two
 * ways a wallet gets credits before it can spend. Malformed input redirects with per-field errors.
 */

import { getEngine } from '~/engine';
import {
  faultFlash,
  invalidFlash,
  noticeFlash,
  outcomeFlash,
  redirectWithFlash,
} from '~/flash';
import type { Route } from './+types/actions.fund';

export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const owner = String(form.get('form') ?? '') || undefined;
  const promo = String(form.get('type') ?? '') === 'promo';
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

  try {
    const outcome = promo
      ? await eco.grantPromo({ userId: user, credits: amount })
      : await eco.deposit({ userId: user, credits: amount });
    if (outcome.status === 'rejected') {
      return redirectWithFlash(
        form,
        outcomeFlash(outcome.reason, outcome.detail ?? {}, owner),
      );
    }
    return redirectWithFlash(
      form,
      noticeFlash(`Recorded ${promo ? 'promo grant' : 'deposit'}.`),
    );
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err, owner));
  }
}
