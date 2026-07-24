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

// Inbound webhook event types and the dispatch that turns a verified provider callback into an
// inbox Operation.
// See https://economy-lab-docs.pages.dev/economy/ports/processor/ for the
// verified-callback-to-operation flow.

import { ERROR_CODES, fault } from '#src/errors.ts';
import { decodeAmountWire } from '#src/money.ts';

import type { Amount } from '#src/money.ts';
import type { Operation } from '#src/contract.ts';
import type {
  Clock,
  Ids,
  InboxMessage,
  Meter,
  CallOptions,
  Store,
} from '#src/ports.ts';

/**
 * Fields every verified provider callback carries, whatever its kind. `provider` comes from the
 * URL route, not the body, so it cannot be spoofed. `eventId` is the provider's globally-unique id
 * for this delivery and the basis for applying at most once: the server claims it in its replay
 * store, and the mapped operation's dedup key is derived from it.
 */
type WebhookBase = {
  provider: string;

  eventId: string;
};

/**
 * A verified inbound purchase event from a billing provider (Steam / Meta / Apple / Google, or
 * any payment processor): the user paid real money and their spendable balance should be
 * credited. `kind` is optional and defaults to `'purchase'` so a bare purchase object is a valid
 * `WebhookEvent`.
 */
export type PurchaseEvent = WebhookBase & {
  kind?: 'purchase';

  /** The end user whose spendable balance the purchase credits. */
  userId: string;

  /** How much to grant, in the platform's CREDIT currency. */
  amount: Amount;

  /** Where the money came from, recorded on the topUp (e.g. 'card', 'steam'). Free-form. */
  source: string;

  /** The product purchased, when the event is a product buy rather than a bare credit pack. */
  sku?: string;
};

/**
 * A verified payout-settled callback: the payout rail reports it disbursed the USD for one of our
 * submitted payouts. It drives the SUBMITTED -> SETTLED saga step via `settlePayout`;
 * `providerRef`/`providerAmount` are audit-trail only — the posted figures are the rate-derived
 * ones `settlePayout` computes.
 */
export type PayoutSettledEvent = WebhookBase & {
  kind: 'payoutSettled';

  /** The payout saga (pay_<uuid>) this settlement clears. */
  sagaId: string;

  /** The rail's own reference for this disbursement, recorded for the audit trail. */
  providerRef: string;

  /**
   * The USD the provider reported settling, when the callback carries one. Recorded for
   * reconciliation only.
   */
  providerAmount?: Amount;
};

/**
 * A verified payout-failed callback: the payout rail reports it will not disburse one of our
 * submitted payouts. It drives `reversePayout` with `providerReported` set, so the seller's
 * reserve returns as soon as the rail gives up rather than after the `maxPayoutAgeMs` timeout.
 */
export type PayoutFailedEvent = WebhookBase & {
  kind: 'payoutFailed';

  /** The payout saga (id of the form pay_<uuid>) whose disbursement the provider gave up on. */
  sagaId: string;

  /**
   * The seller the payout belongs to. The submit pipeline locks accounts by this id, and
   * `reversePayout` refuses the operation if it does not match the saga's own user.
   */
  userId: string;

  /** The rail's own reference for the failed disbursement, recorded for the audit trail. */
  providerRef?: string;

  /** The rail's failure reason (e.g. its status code or a human string), recorded on the reversal. */
  reason?: string;
};

/**
 * A verified dispute / chargeback callback: the user's bank reversed a charge, so the credits
 * that purchase issued must be reclaimed via `clawback`. Carries the disputed order when the
 * provider names one, so the clawback and a refund of the same order stay mutually exclusive.
 */
export type DisputeEvent = WebhookBase & {
  kind: 'dispute';

  /** The user whose credits the chargeback reclaims. */
  userId: string;

  /** How much to reclaim, in the platform's CREDIT currency. */
  amount: Amount;

  /** The order the chargeback disputes, when the provider ties the dispute to one. */
  orderId?: string;

  /** Free-form reason recorded on the clawback (e.g. the network's chargeback reason code). */
  reason?: string;
};

/**
 * A verified inbound provider callback, tagged by `kind`. The webhook edge decodes the raw body
 * into one of these and {@link handleWebhook} dispatches it by kind to the operation it applies. A
 * purchase may omit its `kind` (see {@link PurchaseEvent}).
 */
export type WebhookEvent =
  | PurchaseEvent
  | PayoutSettledEvent
  | PayoutFailedEvent
  | DisputeEvent;

/**
 * Dedup key for a webhook-driven operation, derived from the provider `eventId` and namespaced
 * with `whk:` so it can't collide with a caller-supplied key. Second guard behind the replay
 * store: a claim may not be visible yet to a concurrent redelivery, and this key catches that
 * duplicate at the ledger.
 */
export function webhookIdempotencyKey(eventId: string): string {
  return `whk:${eventId}`;
}

/**
 * Builds the `topUp` that credits the buyer from a verified {@link PurchaseEvent}.
 * `eventId` / `sku` / `provider` ride along as provenance so the ledger entry can be traced back
 * to the callback.
 */
export function toTopUp(event: PurchaseEvent): Operation {
  const provenance: Record<string, unknown> = {
    eventId: event.eventId,
    provider: event.provider,
    ...(event.sku === undefined ? {} : { sku: event.sku }),
  };
  return {
    kind: 'topUp',
    idempotencyKey: webhookIdempotencyKey(event.eventId),
    actor: { kind: 'system', service: `webhook:${event.provider}` },
    userId: event.userId,
    amount: event.amount,
    source: event.source,
    // The `topUp` type has no `meta` field yet, so attach it here and loosen the type with the
    // cast below; the topUp handler reads it back and writes it onto the entry.
    meta: provenance,
  } as unknown as Operation;
}

/**
 * Builds the `settlePayout` that clears a submitted payout from a verified
 * {@link PayoutSettledEvent}. The actor is `system`, which `settlePayout`'s privileged-only gate
 * (RESTRICTED_TO_PRIVILEGED) requires.
 */
export function toSettlePayout(event: PayoutSettledEvent): Operation {
  return {
    kind: 'settlePayout',
    idempotencyKey: webhookIdempotencyKey(event.eventId),
    actor: { kind: 'system', service: `webhook:${event.provider}` },
    sagaId: event.sagaId,
    providerRef: event.providerRef,
    ...(event.providerAmount === undefined
      ? {}
      : { providerAmount: event.providerAmount }),
  };
}

/**
 * Builds the `reversePayout` that promptly returns a failed payout's reserve from a verified
 * {@link PayoutFailedEvent}. `providerReported` is set here and only here: it waives the
 * still-live SUBMITTED refusal on the rail's own report, and the saga-state compare-and-set still
 * stands down if a settle callback won the race. The reason defaults to the stable
 * `payout.provider_failed` marker when the rail gave none. The actor is `system`, which the
 * privileged-only gate requires.
 */
export function toReversePayout(event: PayoutFailedEvent): Operation {
  return {
    kind: 'reversePayout',
    idempotencyKey: webhookIdempotencyKey(event.eventId),
    actor: { kind: 'system', service: `webhook:${event.provider}` },
    userId: event.userId,
    sagaId: event.sagaId,
    reason: event.reason ?? 'payout.provider_failed',
    providerReported: true,
  };
}

/**
 * Builds the `clawback` that reclaims disputed credits from a verified {@link DisputeEvent}.
 * `orderId` threads through so the clawback shares the `reversed:${orderId}` key with a refund of
 * the same order. The actor is `system`, which `clawback` already allows (system-or-operator).
 */
export function toClawback(event: DisputeEvent): Operation {
  return {
    kind: 'clawback',
    idempotencyKey: webhookIdempotencyKey(event.eventId),
    actor: { kind: 'system', service: `webhook:${event.provider}` },
    userId: event.userId,
    amount: event.amount,
    ...(event.orderId === undefined ? {} : { orderId: event.orderId }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  };
}

/**
 * Dispatches a verified {@link WebhookEvent} to the {@link Operation} it applies — the single
 * place provider-event kind maps to economy operation. Every branch derives the same
 * `eventId`-based dedup key, so whichever kind arrives is applied at most once.
 */
export function toOperation(event: WebhookEvent): Operation {
  // Split the purchase off first: its optional `kind` would otherwise defeat the `never`
  // exhaustiveness check on the switch below.
  if (isPurchase(event)) {
    return toTopUp(event);
  }
  switch (event.kind) {
    case 'payoutSettled':
      return toSettlePayout(event);
    case 'payoutFailed':
      return toReversePayout(event);
    case 'dispute':
      return toClawback(event);
    default:
      return unreachableEvent(event);
  }
}

function isPurchase(event: WebhookEvent): event is PurchaseEvent {
  return event.kind === undefined || event.kind === 'purchase';
}

/**
 * The result of accepting a verified webhook.
 * - `accepted`: a fresh provider event, enqueued for the next sweep.
 * - `duplicate`: a redelivery of an already-seen `eventId`; the existing row stood.
 *
 * `entry` is the stored row, so the caller can surface its id without a second read.
 */
export type WebhookReceipt = {
  status: 'accepted' | 'duplicate';
  entry: InboxMessage;
};

/**
 * Maps a verified callback to the operation it applies (via {@link toOperation}), persists that
 * to the inbox in one transaction, and returns. It does NOT post to the ledger inline; the apply
 * worker (`drainInbox`) submits the stored Operation later, so invariants and idempotency apply
 * there.
 *
 * @example
 * const receipt = await handleWebhook(ports.store, ports, {
 *   provider: 'steam',
 *   eventId: 'evt_8123',
 *   userId: 'u_42',
 *   amount: toAmount('CREDIT', 12_000n), // a $100 credit pack
 *   source: 'steam',
 * });
 * // receipt.status is 'accepted' now, 'duplicate' on any redelivery of evt_8123
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   the verification gate the edge runs first.
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for how
 *   verified callbacks flow through the inbox.
 */
export async function handleWebhook(
  store: Store,
  ctx: { ids: Ids; clock: Clock; meter?: Meter },
  event: WebhookEvent,
  options?: CallOptions,
): Promise<WebhookReceipt> {
  // `key` is the provider `eventId` — the inbox dedupe key and the basis of the operation's
  // idempotencyKey (see `toOperation`) — so the two layers agree on what "the same event" means.
  const row: InboxMessage = {
    id: ctx.ids.next('ibx'),
    key: event.eventId,
    operation: toOperation(event),
    status: 'pending',
    attempts: 0,
    receivedAt: ctx.clock.now(),
    reason: null,
  };
  const stored = await store.transaction(
    (unit) => unit.inbox.enqueueInbound(row, options),
    options,
  );
  // A duplicate provider event is a no-op that returns the row already stored under this key; its id
  // differs from the one we just minted, so an id mismatch is exactly the dedupe case.
  const duplicate = stored.id !== row.id;
  if (duplicate) {
    // The layer tag separates this deep-dedupe catch from the edge's stale/replay gates; a storm
    // landing here means redeliveries are getting past the edge.
    ctx.meter?.count('economy.webhook.duplicate', 1, {
      provider: event.provider,
      layer: 'inbox',
    });
  }
  return {
    status: duplicate ? 'duplicate' : 'accepted',
    entry: stored,
  };
}

/**
 * The purchase case of {@link handleWebhook}, kept as a named entry point for callers that only
 * deal in purchases.
 */
export async function handlePurchaseWebhook(
  store: Store,
  ctx: { ids: Ids; clock: Clock; meter?: Meter },
  event: PurchaseEvent,
  options?: CallOptions,
): Promise<WebhookReceipt> {
  return handleWebhook(store, ctx, event, options);
}

/**
 * Decodes an already-parsed purchase webhook body into a typed {@link PurchaseEvent}. The money
 * field uses the same decimal-string codec as the rest of the API, so the amount never passes
 * through a JSON number; a wrong-shape body or bad amount throws, letting the server reply 400
 * before anything reaches the ledger. Purchase is the only kind with a body decoder — the other
 * kinds map straight from a {@link WebhookEvent} via {@link toOperation}.
 */
export function decodeWebhookEvent(
  provider: string,
  body: unknown,
): PurchaseEvent {
  if (body === null || typeof body !== 'object') {
    throw malformedEvent('Webhook body must be a JSON object.');
  }
  const row = body as Record<string, unknown>;
  const eventId = requireString(row.eventId, 'eventId');
  const userId = requireString(row.userId, 'userId');
  const source = requireString(row.source, 'source');
  const amount = decodeAmountField(row.amount);
  const sku = row.sku === undefined ? undefined : requireString(row.sku, 'sku');
  return {
    provider,
    eventId,
    userId,
    amount,
    source,
    ...(sku === undefined ? {} : { sku }),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw malformedEvent(`Webhook field '${field}' must be a string.`);
  }
  return value;
}

// A non-string or colon-less value throws here, keeping "wrong shape" distinct from the money
// decoder's "wrong amount".
function decodeAmountField(value: unknown): Amount {
  if (typeof value !== 'string') {
    throw malformedEvent(
      "Webhook field 'amount' must be an encoded amount string.",
    );
  }
  if (value.indexOf(':') < 0) {
    throw malformedEvent("Webhook field 'amount' must be 'CURRENCY:decimal'.");
  }
  return decodeAmountWire(value);
}

// MALFORMED_OPERATION so the server maps a wrong-shape body to 400, not 500.
function malformedEvent(message: string): ReturnType<typeof fault> {
  return fault(ERROR_CODES.MALFORMED_OPERATION, message);
}

// The unmapped kind is `never` here, so this fails to compile until a mapper is added; if reached
// at runtime it is a bad request (MALFORMED_OPERATION -> 400).
function unreachableEvent(event: never): never {
  const kind = (event as { kind?: unknown }).kind;
  throw fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `Webhook event has an unknown kind: ${String(kind)}.`,
    { detail: { kind } },
  );
}
