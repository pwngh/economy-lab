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

// Turns an inbound purchase callback from a billing provider into a ledger credit. A verified
// callback means "this user paid real money"; this module maps it to a `topUp` (the operation
// that grants new credits to a user) that credits the buyer's spendable balance once and only
// once, no matter how many times the provider redelivers the same callback.
//
// The typed `WebhookEvent` and the code that consumes it both live here: the server's HTTP
// edge decodes the raw request body into a `WebhookEvent`, and `handlePurchaseWebhook` turns
// that into the topUp operation it submits to the economy.
//
// Stopping duplicate deliveries is split across two layers. The server's edge claims the
// provider's `eventId` in a replay store so a redelivery is recognized and dropped before it
// reaches this module; it runs that claim only AFTER checking the request's signature and
// freshness, so a forged or stale delivery can never consume (and waste) a real eventId. This
// module assumes the event handed to it has already passed those checks, and adds a second
// guard of its own (see `webhookIdempotencyKey`).
//
// A purchase never increases "revenue". Crediting a user for cash is a topUp against the
// platform's stored-value pool (the credits it owes users), so "revenue" keeps meaning
// platform fee income only, and is never inflated by money a user paid in.

import { ERROR_CODES, fault } from '#src/errors.ts';
import { decodeAmount } from '#src/money.ts';

import type { Amount } from '#src/money.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { Options } from '#src/ports.ts';

/**
 * A verified inbound purchase event from a billing provider (Steam / Meta / Apple / Google, or
 * any payment processor). The provider's own `eventId` is the key used to recognize and drop
 * duplicate deliveries; `amount` is a real {@link Amount} rather than a plain number, so it
 * carries its currency and stays an exact integer (money is never held in a floating-point or
 * JSON number). `sku` is optional — a plain credit-pack purchase carries none, a product
 * purchase carries the product id.
 */
export type WebhookEvent = {
  // Which provider sent the callback (the `:provider` path segment, e.g. 'steam', 'billing').
  provider: string;

  // The provider's globally-unique id for this delivery, and the basis for crediting at most
  // once: the server claims it in its replay store, and the topUp's deduplication key (the
  // value that makes a retried operation apply only once) is derived from it.
  eventId: string;

  // The end user whose spendable balance the purchase credits.
  userId: string;

  // How much to grant, in the platform's CREDIT currency. Decoded from the request body's
  // decimal string at the server edge before it reaches this module.
  amount: Amount;

  // Where the money came from, recorded on the topUp (e.g. 'card', 'steam'). Free-form.
  source: string;

  // The product purchased, when the event is a product buy rather than a bare credit pack.
  sku?: string;
};

/**
 * Builds the deduplication key for a webhook-driven topUp — the value the ledger uses to apply
 * a retried operation at most once. It is derived purely from the provider `eventId`, so the
 * credit happens only once even if the calling code forgets to pass its own key. The `whk:`
 * prefix keeps it in a separate namespace so it can never collide with a key a caller supplied
 * for some other operation.
 *
 * This is a SECOND guard behind the server's replay store. The replay store usually drops a
 * redelivery before it reaches the handler, but because that store can lag (a claim may not be
 * visible yet to a concurrent request), two deliveries can occasionally slip through at once;
 * this key catches the duplicate again at the ledger so only one credit is posted.
 */
export function webhookIdempotencyKey(eventId: string): string {
  return `whk:${eventId}`;
}

/**
 * Builds the `topUp` operation that credits the buyer from a verified {@link WebhookEvent}.
 * The operation's deduplication key comes from the provider `eventId`, so the credit applies
 * at most once. The event's `eventId` / `sku` / `provider` are carried along as a record of
 * origin, so the ledger entry this produces can later be traced back to the callback that
 * caused it. The amount and user pass straight through. The credit is issued against the
 * platform's stored-value pool (the credits it owes users), not its fee revenue.
 */
export function toTopUp(event: WebhookEvent): Operation {
  // The origin details to record alongside the credit. Carried on the operation so the topUp
  // handler can attach them (eventId/sku/provider) to the ledger entry it writes, giving each
  // entry a pointer back to the provider callback that caused it for later reconciliation.
  let provenance: Record<string, unknown> = {
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
    // The origin details, to be recorded on the ledger entry. The `topUp` operation type does
    // not declare a `meta` field yet, so it is attached here and the type is loosened with a
    // cast (below); the topUp handler reads it back off and writes it onto the entry. See the
    // matching note in contract.ts / operations/topUp.ts.
    meta: provenance,
  } as unknown as Operation;
}

/**
 * Handles a verified purchase webhook: builds the topUp and submits it to the economy,
 * returning the resulting {@link Outcome}. The caller (the server edge) has already verified
 * the request's signature, checked that it is recent, and claimed its `eventId` in the replay
 * store, so by the time this runs the event is trusted and is normally a first-time delivery.
 * Should a duplicate delivery still reach here, it credits at most once, because the topUp's
 * deduplication key is derived from the same `eventId`: the economy recognizes the repeat and
 * returns a `duplicate` Outcome without posting anything further.
 */
export async function handlePurchaseWebhook(
  economy: Economy,
  event: WebhookEvent,
  options?: Options,
): Promise<Outcome> {
  return economy.submit(toTopUp(event), options);
}

/**
 * Decodes an already-parsed webhook request body into a typed {@link WebhookEvent}. It decodes
 * the money field with the same decimal-string encoder/decoder the rest of the API uses, so the
 * amount survives the trip exactly and no money ever passes through a JSON number. `provider`
 * comes from the URL (the `:provider` part of the route), not from the body, so it cannot be
 * spoofed by the caller. A body of the wrong shape, or with a missing/invalid amount, throws,
 * letting the server reply 400 — a malformed callback never reaches the ledger.
 */
export function decodeWebhookEvent(
  provider: string,
  body: unknown,
): WebhookEvent {
  if (body === null || typeof body !== 'object') {
    throw malformedEvent('Webhook body must be a JSON object.');
  }
  let row = body as Record<string, unknown>;
  let eventId = requireString(row.eventId, 'eventId');
  let userId = requireString(row.userId, 'userId');
  let source = requireString(row.source, 'source');
  let amount = decodeAmountField(row.amount);
  let sku = row.sku === undefined ? undefined : requireString(row.sku, 'sku');
  return {
    provider,
    eventId,
    userId,
    amount,
    source,
    ...(sku === undefined ? {} : { sku }),
  };
}

// Pull a required string field off the body, or throw a malformed-event error naming the field
// so the wrong shape is rejected at the edge rather than coerced into a bad event.
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw malformedEvent(`Webhook field '${field}' must be a string.`);
  }
  return value;
}

// Decode the `amount` field from its on-the-wire string (e.g. 'CREDIT:10.00') into an Amount.
// The string puts the currency before the colon and the decimal value after it, the same
// format the rest of the API uses, so the value decodes identically on any runtime. A value
// that is not a string, or that the money decoder cannot parse, throws — keeping "wrong shape"
// and "wrong amount" as two distinct errors, the latter raised by the money decoder itself.
function decodeAmountField(value: unknown): Amount {
  if (typeof value !== 'string') {
    throw malformedEvent(
      "Webhook field 'amount' must be an encoded amount string.",
    );
  }
  let colon = value.indexOf(':');
  if (colon < 0) {
    throw malformedEvent("Webhook field 'amount' must be 'CURRENCY:decimal'.");
  }
  return decodeAmount(
    value.slice(colon + 1),
    value.slice(0, colon) as Amount['currency'],
  );
}

// Builds the error thrown for a webhook body of the wrong shape — treated as a bad client
// request, the same way a malformed /submit body is. It returns an EconomyError carrying the
// MALFORMED_OPERATION code so the server, which chooses the HTTP status from that code, answers
// 400 (client error) rather than treating it as a 500 (server fault).
function malformedEvent(message: string): ReturnType<typeof fault> {
  return fault(ERROR_CODES.MALFORMED_OPERATION, message);
}
