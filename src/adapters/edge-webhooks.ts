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

import { toAmount } from '#src/money.ts';

import type { CanonicalPayoutEvent } from '@pwngh/economy-edge';
import type { Amount, Currency } from '#src/money.ts';
import type { Options, Saga, Store } from '#src/ports.ts';
import type { PayoutFailedEvent, PayoutSettledEvent } from '#src/webhooks.ts';

export type SagaLookup = (
  providerRef: string,
  options?: Options,
) => Promise<Saga | null>;

export function sagaByProviderRef(store: Store): SagaLookup {
  return (providerRef, options) =>
    store.sagas.findByProviderRef(providerRef, options);
}

// Tilia documents no webhook event id, so the dedupe key is the (provider, ref, transition)
// triple: any redelivery of the same status transition lands on the same inbox key, however the
// rail re-serializes the callback. Null when the event names no payout, which the host skips.
export function payoutEventIdOf(event: CanonicalPayoutEvent): string | null {
  if (event.ref === undefined) {
    return null;
  }
  return `${event.provider}:${event.ref.id}:${event.type}`;
}

export async function edgePayoutWebhookEvent(
  event: CanonicalPayoutEvent,
  input: { eventId: string },
  lookup: SagaLookup,
): Promise<PayoutSettledEvent | PayoutFailedEvent | null> {
  if (event.ref === undefined) {
    return null;
  }
  if (
    event.type !== 'SETTLED' &&
    event.type !== 'FAILED' &&
    event.type !== 'RETURNED'
  ) {
    return null;
  }
  const saga = await lookup(event.ref.id);
  if (saga === null) {
    return null;
  }
  if (event.type === 'SETTLED') {
    const reported = settledAmountOf(event);
    return {
      kind: 'payoutSettled',
      provider: event.provider,
      eventId: input.eventId,
      sagaId: saga.id,
      providerRef: event.ref.id,
      ...(reported === null ? {} : { providerAmount: reported }),
    };
  }
  return {
    kind: 'payoutFailed',
    provider: event.provider,
    eventId: input.eventId,
    sagaId: saga.id,
    userId: saga.userId,
    providerRef: event.ref.id,
    ...(event.type === 'RETURNED'
      ? { reason: 'payout.provider_returned' }
      : {}),
  };
}

function settledAmountOf(event: CanonicalPayoutEvent): Amount | null {
  const gross = event.settlement?.gross;
  if (gross === undefined) {
    return null;
  }
  if (gross.currency !== 'USD' && gross.currency !== 'CREDIT') {
    return null;
  }
  return toAmount(gross.currency as Currency, gross.minor);
}
