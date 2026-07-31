/**
 * @pwngh/economy-events
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { isEventType } from './roster.js';

import type { EconomyEvent, EventType } from '@pwngh/economy-lab';

/** Money in an event is the wire form the ledger encodes, e.g. `CREDIT:600.00`. */
export type EventAmount = string;

/** A credit pack the user bought, or a promo the platform granted. */
export type PostingData = { txnId: string };

/** A completed sale. The gift fields appear only when the buyer bought for someone else. */
export type SaleCompletedData = {
  txnId: string;
  isGift?: true;
  giftTo?: string;
};

/** A refunded sale. `buyerId` is read off the reversing posting, not the operation. */
export type SaleRefundedData = {
  txnId: string;
  orderId: string;
  buyerId: string;
};

/** Credits reclaimed after a chargeback. `orderId` is present when the provider named one. */
export type ClawedBackData = {
  txnId: string;
  userId: string;
  amount: EventAmount;
  orderId?: string;
};

/** A cash-out the seller asked for. The reserve is held from this posting onward. */
export type PayoutRequestedData = {
  txnId: string;
  userId: string;
  amount: EventAmount;
};

/** A cash-out the rail paid. The USD figures are the rate-derived ones, not the rail's report. */
export type PayoutSettledData = {
  sagaId: string;
  userId: string;
  reserve: EventAmount;
  usd: EventAmount;
  payoutFee: EventAmount;
  netUsd: EventAmount;
  rateId: string;
};

/** A cash-out that came back. The reserve is the amount returned to the seller. */
export type PayoutReversedData = {
  sagaId: string;
  reason: string;
  userId: string;
  reserve: EventAmount;
};

/**
 * A subscription's first period. `period` is 1 here and counts up on each renewal.
 *
 * `subscriptionId` is what a consumer joins the four subscription events on: the started, renewed,
 * lapsed and canceled events all name the same one. `(userId, sku)` is not that key, because a
 * user who lapses and subscribes again reuses the pair on a second row.
 */
export type SubscriptionStartedData = {
  txnId: string;
  subscriptionId: string;
  userId: string;
  sku: string;
  period: number;
};

/**
 * A subscription period the billing worker charged. `txnId` is that charge, so the amount billed
 * is readable from the ledger rather than taken on the event's word.
 */
export type SubscriptionRenewedData = {
  txnId: string;
  subscriptionId: string;
  userId: string;
  sku: string;
  period: number;
};

/**
 * A subscription period the billing worker gave up on, because the buyer could not cover it.
 *
 * There is no `txnId` here and there cannot be one: a lapse moves no money. The sweep marks the
 * row, revokes the perk and queues this event in one store transaction, and posts nothing. That is
 * the whole difference from {@link SubscriptionRenewedData}, whose other four fields are these.
 */
export type SubscriptionLapsedData = {
  subscriptionId: string;
  userId: string;
  sku: string;
  period: number;
};

/** A subscription the user canceled. The current period still runs to its end. */
export type SubscriptionCanceledData = {
  txnId: string;
  subscriptionId: string;
};

/** Platform fees moved out of the fee account into the treasury. */
export type FeesSweptData = { swept: EventAmount };

/** One instance session's settlement, netted into chunks or replayed movement by movement. */
export type InstanceSettledData = {
  sessionId: string;
  mode: 'netted' | 'replayed';
  netted: number;
  postings: number;
  rejected: number;
  revoked: number;
};

/**
 * The `data` each type carries. The shapes are the emitters' own, so a field listed optional
 * here is one the emitter omits rather than sends empty.
 */
export type EventDataMap = {
  'economy.credits.topped_up': PostingData;
  'economy.credits.clawed_back': ClawedBackData;
  'economy.promo.granted': PostingData;
  'economy.sale.completed': SaleCompletedData;
  'economy.sale.refunded': SaleRefundedData;
  'economy.subscription.started': SubscriptionStartedData;
  'economy.subscription.renewed': SubscriptionRenewedData;
  'economy.subscription.canceled': SubscriptionCanceledData;
  'economy.subscription.lapsed': SubscriptionLapsedData;
  'economy.payout.requested': PayoutRequestedData;
  'economy.payout.settled': PayoutSettledData;
  'economy.payout.reversed': PayoutReversedData;
  'economy.fees.swept': FeesSweptData;
  'economy.instance.settled': InstanceSettledData;
};

/** One event, pinned to a single type, with the `data` that type carries. */
export type EventOf<T extends EventType> = Omit<
  EconomyEvent,
  'type' | 'data'
> & {
  type: T;
  data: EventDataMap[T];
};

/**
 * The fourteen events as one discriminated union. Switch on `event.type` and each branch's
 * `event.data` is that type's own shape.
 */
export type KnownEvent = { [T in EventType]: EventOf<T> }[EventType];

/**
 * True when `value` has the event shape and a rostered type. The per-type `data` is not
 * inspected — see {@link narrowEvent} for what that means.
 */
export function isEconomyEvent(value: unknown): value is EconomyEvent {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    isEventType(row.type) &&
    typeof row.version === 'number' &&
    typeof row.occurredAt === 'number' &&
    typeof row.subject === 'string' &&
    isDataObject(row.data) &&
    (row.audience === 'internal' || row.audience === 'client')
  );
}

// An array is an object to `typeof`, and no emitter has ever sent one as `data`.
function isDataObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Turns parsed JSON into a value a switch can read, or `null` when it is not an event this
 * roster knows.
 *
 * What it checks is the envelope: the fields above, and a type on the roster. What it takes on
 * the emitter's word is `data` — the shape comes from {@link EventDataMap}, not from an
 * inspection. A handler that will act on a field from an untrusted sender checks that field.
 *
 * @example
 * let event = narrowEvent(JSON.parse(body));
 * if (event?.type === 'economy.payout.settled') {
 *   event.data.netUsd; // 'USD:95.00'
 * }
 */
export function narrowEvent(value: unknown): KnownEvent | null {
  return isEconomyEvent(value) ? (value as KnownEvent) : null;
}

/**
 * Narrows one event to one type, for a handler that cares about a single kind and would
 * rather test than switch.
 *
 * The envelope is checked here too, the same as {@link narrowEvent}. Matching on the type
 * alone would hand back a value whose `data` fields a caller then reads and finds missing.
 *
 * @example
 * if (isEvent(event, 'economy.sale.completed')) {
 *   event.data.giftTo; // string | undefined
 * }
 */
export function isEvent<T extends EventType>(
  event: EconomyEvent,
  type: T,
): event is EventOf<T> {
  return isEconomyEvent(event) && event.type === type;
}
