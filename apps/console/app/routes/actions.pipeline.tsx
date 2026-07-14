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
import type { Route } from './+types/actions.pipeline';

// The event pipeline's two mutations: `relay` delivers pending outbox rows through the capture
// dispatcher; `webhook` applies a verified inbound provider event once (a redelivery is a no-op).
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const form = await request.formData();
  const op = String(form.get('op') ?? '');

  try {
    if (op === 'relay') {
      const r = await eco.runRelay();
      return redirectWithFlash(
        form,
        noticeFlash(
          r.relayed === 0
            ? 'The relay ran — no outbox rows were pending.'
            : `Relayed ${r.relayed} event${r.relayed === 1 ? '' : 's'} through the capture dispatcher.`,
        ),
      );
    }

    if (op === 'webhook') {
      const eventId = String(form.get('eventId') ?? '').trim();
      const userId = String(form.get('userId') ?? '').trim();
      const amount = Number(form.get('credits') ?? 0);
      const fields: Record<string, string> = {};
      if (!eventId) {
        fields.eventId = 'A provider event id is required.';
      }
      if (!userId) {
        fields.userId = 'A user is required.';
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        fields.credits = 'Enter a credit amount greater than zero.';
      }
      if (Object.keys(fields).length > 0) {
        return redirectWithFlash(
          form,
          invalidFlash(fields, 'pipeline-webhook'),
        );
      }

      const r = await eco.postWebhook({ eventId, userId, credits: amount });
      const who = entityName(userId);
      if (r.status === 'duplicate') {
        return redirectWithFlash(
          form,
          noticeFlash(
            `Webhook ${eventId} was a duplicate: no second posting, ${who}'s balance is unchanged.`,
          ),
        );
      }
      // Accepted into the inbox but the drain posted nothing — the event was enqueued yet rejected
      // when applied (e.g. an out-of-range amount). Say so; never confirm a top-up that did not post.
      if (!r.applied) {
        return redirectWithFlash(
          form,
          noticeFlash(
            `Webhook ${eventId} was accepted but did not post — nothing was topped up.`,
            { tone: 'warn', form: 'pipeline-webhook' },
          ),
        );
      }
      return redirectWithFlash(
        form,
        noticeFlash(
          `Webhook ${eventId} accepted — topped up ${who} by ${amount} credits.`,
        ),
      );
    }

    return redirectWithFlash(
      form,
      faultFlash(new Error(`Unknown pipeline op: ${op}.`)),
    );
  } catch (err) {
    return redirectWithFlash(form, faultFlash(err));
  }
}
