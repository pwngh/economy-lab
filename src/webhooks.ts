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

// Maps an inbound purchase callback from a billing provider to a ledger credit. A verified
// callback means the user paid real money; this module turns it into a `topUp` that credits
// the buyer's spendable balance exactly once, regardless of provider redeliveries.
//
// The HTTP edge decodes the raw body into a `WebhookEvent`; `handlePurchaseWebhook` turns that
// into the topUp it submits to the economy.
//
// Duplicate suppression spans two layers. The edge claims the provider's `eventId` in a replay
// store to drop redeliveries before they reach here, running that claim only after checking
// signature and freshness so a forged/stale delivery can't waste a real eventId. This module
// assumes those checks already passed and adds a second guard (see `webhookIdempotencyKey`).
//
// A purchase never increases "revenue": crediting a user for cash is a topUp against the
// stored-value pool (credits owed to users), so "revenue" stays platform fee income only.

import { ERROR_CODES, fault } from '#src/errors.ts';
import { decodeAmount } from '#src/money.ts';

import type { Amount } from '#src/money.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { Options } from '#src/ports.ts';

/**
 * A verified inbound purchase event from a billing provider (Steam / Meta / Apple / Google, or
 * any payment processor). `eventId` keys duplicate-delivery detection. `amount` is an
 * {@link Amount}, not a number, so it carries its currency and stays an exact integer (money is
 * never a float or JSON number). `sku` is optional: a credit-pack purchase has none, a product
 * purchase carries the product id.
 */
export type WebhookEvent = {
  // Which provider sent the callback (the `:provider` path segment, e.g. 'steam', 'billing').
  provider: string;

  // Provider's globally-unique id for this delivery, and the basis for crediting at most once:
  // the server claims it in its replay store, and the topUp's dedup key is derived from it.
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
 * Builds the dedup key for a webhook-driven topUp. Derived purely from the provider `eventId`,
 * so the credit applies once even if the caller forgets its own key. The `whk:` prefix
 * namespaces it so it can't collide with a caller-supplied key for another operation.
 *
 * Second guard behind the server's replay store. The store usually drops a redelivery first,
 * but it can lag (a claim may not be visible yet to a concurrent request), so two deliveries
 * can slip through at once; this key catches the duplicate at the ledger.
 */
export function webhookIdempotencyKey(eventId: string): string {
  return `whk:${eventId}`;
}

/**
 * Builds the `topUp` that credits the buyer from a verified {@link WebhookEvent}. The dedup key
 * comes from `eventId`, so the credit applies at most once. `eventId` / `sku` / `provider` ride
 * along as provenance so the ledger entry can be traced back to the callback. Amount and user
 * pass straight through. The credit hits the stored-value pool, not fee revenue.
 */
export function toTopUp(event: WebhookEvent): Operation {
  // Provenance carried on the operation so the topUp handler can attach eventId/sku/provider to
  // the ledger entry, pointing each entry back to its provider callback for reconciliation.
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
    // Provenance for the ledger entry. The `topUp` type has no `meta` field yet, so attach it
    // here and loosen the type with the cast below; the topUp handler reads it back and writes
    // it onto the entry. See the matching note in contract.ts / operations/topUp.ts.
    meta: provenance,
  } as unknown as Operation;
}

/**
 * Handles a verified purchase webhook: builds the topUp, submits it, returns the {@link Outcome}.
 * The server edge has already checked signature and freshness and claimed `eventId` in the
 * replay store, so the event is trusted and normally a first-time delivery. A duplicate that
 * still reaches here credits at most once: the topUp's dedup key derives from the same
 * `eventId`, so the economy returns a `duplicate` Outcome without posting anything.
 */
export async function handlePurchaseWebhook(
  economy: Economy,
  event: WebhookEvent,
  options?: Options,
): Promise<Outcome> {
  return economy.submit(toTopUp(event), options);
}

/**
 * Decodes an already-parsed webhook body into a typed {@link WebhookEvent}. Decodes the money
 * field with the same decimal-string codec the rest of the API uses, so the amount survives
 * exactly and never passes through a JSON number. `provider` comes from the URL route, not the
 * body, so the caller can't spoof it. A wrong-shape body or missing/invalid amount throws,
 * letting the server reply 400 before anything reaches the ledger.
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

// Required string field, or throw a malformed-event error naming the field. Rejects wrong shapes
// at the edge rather than coercing them into a bad event.
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw malformedEvent(`Webhook field '${field}' must be a string.`);
  }
  return value;
}

// Decode the `amount` field from its wire string (e.g. 'CREDIT:10.00') into an Amount: currency
// before the colon, decimal after, the same format the rest of the API uses. A non-string or
// unparseable value throws, keeping "wrong shape" and "wrong amount" distinct (the latter raised
// by the money decoder).
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

// Error for a wrong-shape webhook body, treated as a bad client request like a malformed /submit
// body. Carries the MALFORMED_OPERATION code so the server maps it to 400, not 500.
function malformedEvent(message: string): ReturnType<typeof fault> {
  return fault(ERROR_CODES.MALFORMED_OPERATION, message);
}
