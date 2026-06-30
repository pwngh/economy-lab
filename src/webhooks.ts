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

// Inbound provider-callback dispatch. This module maps a verified callback to the ledger Operation
// its kind should apply, then persists that Operation to the transactional inbox (the inbound mirror
// of the outbox) for the apply worker to submit later. The kinds map as follows:
//   - a cleared purchase  -> `topUp`        (credit the buyer's spendable balance)
//   - a settled payout    -> `settlePayout` (the SUBMITTED -> SETTLED step for the named saga)
//   - a dispute/chargeback -> `clawback`    (reclaim the disputed credits)
//
// Duplicate suppression spans two layers, identically for every kind. The edge claims the
// provider's `eventId` in a replay store to drop redeliveries before they reach here. It runs that
// claim only after checking signature and freshness, so a forged or stale delivery cannot waste a
// real eventId. This module assumes those checks already passed and adds a second guard: the inbox
// dedupes on the provider `eventId` as the row `key` (see `webhookIdempotencyKey`), so a redelivery
// that slips past the replay store enqueues no second row and applies at most once.
//
// A purchase never increases "revenue": crediting a user for cash is a topUp against the
// stored-value pool (credits owed to users), so "revenue" stays platform fee income only.

import { ERROR_CODES, fault } from '#src/errors.ts';
import { decodeAmount } from '#src/money.ts';

import type { Amount } from '#src/money.ts';
import type { Operation } from '#src/contract.ts';
import type { Clock, Ids, InboxEntry, Options, Store } from '#src/ports.ts';

/**
 * Fields every verified provider callback carries, whatever its kind. `provider` comes from the
 * URL route, not the body, so it cannot be spoofed. `eventId` is the provider's globally-unique id
 * for this delivery and the basis for applying at most once: the server claims it in its replay
 * store, and the mapped operation's dedup key is derived from it.
 */
type WebhookBase = {
  // Which provider sent the callback (the `:provider` path segment, e.g. 'steam', 'billing').
  provider: string;

  // Provider's globally-unique id for this delivery. It is the basis for applying at most once, as
  // the type doc above explains.
  eventId: string;
};

/**
 * A verified inbound purchase event from a billing provider (Steam / Meta / Apple / Google, or
 * any payment processor): the user paid real money and their spendable balance should be credited.
 * `amount` is an {@link Amount}, not a number, so it carries its currency and stays an exact
 * integer (money is never a float or JSON number). `sku` is optional: a credit-pack purchase has
 * none, a product purchase carries the product id. `kind` is optional and defaults to `'purchase'`
 * so a bare purchase object (the original webhook shape) remains a valid `WebhookEvent`.
 */
export type PurchaseEvent = WebhookBase & {
  kind?: 'purchase';

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
 * A verified payout-settled callback: the payout rail reports it disbursed the USD for one of our
 * submitted payouts. It drives the SUBMITTED -> SETTLED step of the named saga via `settlePayout`,
 * which empties the seller's reserve into REVENUE and moves the gross USD out of trust. The figures
 * actually posted are the rate-derived ones the worker computes; `providerRef`/`providerAmount`
 * are carried on the operation for the audit trail only.
 */
export type PayoutSettledEvent = WebhookBase & {
  kind: 'payoutSettled';

  // The payout saga (id of the form pay_<uuid>) this settlement clears: the SUBMITTED disbursement
  // the provider just reported paid out.
  sagaId: string;

  // The rail's own reference for this disbursement, recorded for the audit trail.
  providerRef: string;

  // The USD the provider reported settling. Recorded for reconciliation only. The posted figures are
  // the rate-derived ones `settlePayout` computes from the reserve, identical to the worker's.
  providerAmount: Amount;
};

/**
 * A verified dispute / chargeback callback: the user's bank reversed a charge, so the credits that
 * purchase issued must be reclaimed. It maps to `clawback`, which pulls the disputed credits from
 * the user's spendable balance (capping at what's left and booking the rest as a debt) and un-issues
 * them against the stored-value pool. Carries the disputed order when the provider names one, so the
 * clawback and a refund of the same order stay mutually exclusive.
 */
export type DisputeEvent = WebhookBase & {
  kind: 'dispute';

  // The user whose credits the chargeback reclaims.
  userId: string;

  // How much to reclaim, in the platform's CREDIT currency.
  amount: Amount;

  // The order the chargeback disputes, when the provider ties the dispute to one. Threaded onto the
  // clawback so reversing the order once (by refund or chargeback) blocks the other.
  orderId?: string;

  // Free-form reason recorded on the clawback (e.g. the network's chargeback reason code).
  reason?: string;
};

/**
 * A verified inbound provider callback, tagged by `kind`. The webhook edge decodes the raw body
 * into one of these and {@link handleWebhook} dispatches it by kind to the operation it applies. A
 * purchase carries no `kind` (it defaults to `'purchase'`) so the original bare purchase shape is
 * still a valid event.
 */
export type WebhookEvent = PurchaseEvent | PayoutSettledEvent | DisputeEvent;

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
 * Builds the `topUp` that credits the buyer from a verified {@link PurchaseEvent}. The dedup key
 * comes from `eventId`, so the credit applies at most once. `eventId` / `sku` / `provider` ride
 * along as provenance so the ledger entry can be traced back to the callback. Amount and user
 * pass straight through. The credit hits the stored-value pool, not fee revenue.
 */
export function toTopUp(event: PurchaseEvent): Operation {
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
 * Builds the `settlePayout` that clears a submitted payout from a verified {@link PayoutSettledEvent}.
 * The dedup key comes from `eventId`, so the settle applies at most once however many times the rail
 * redelivers. `sagaId` names the payout to settle. `providerRef` and `providerAmount` are carried for
 * the audit trail only. The figures actually posted are the rate-derived ones `settlePayout` computes
 * from the saga's reserve, identical to the worker's settle, so the provider's reported amount is
 * recorded but never trusted as the posted figure. The actor is `system`, which `settlePayout`'s
 * privileged-only gate (RESTRICTED_TO_PRIVILEGED) requires.
 */
export function toSettlePayout(event: PayoutSettledEvent): Operation {
  return {
    kind: 'settlePayout',
    idempotencyKey: webhookIdempotencyKey(event.eventId),
    actor: { kind: 'system', service: `webhook:${event.provider}` },
    sagaId: event.sagaId,
    providerRef: event.providerRef,
    providerAmount: event.providerAmount,
  };
}

/**
 * Builds the `clawback` that reclaims disputed credits from a verified {@link DisputeEvent}. The dedup
 * key comes from `eventId`, so a redelivered chargeback reclaims at most once. `userId` / `amount`
 * pass straight through; `orderId` is threaded on when the provider ties the dispute to an order, so
 * the clawback shares the `reversed:${orderId}` key with a refund of the same order and the two stay
 * mutually exclusive. The actor is `system`, which `clawback` already allows (system-or-operator).
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
 * Dispatches a verified {@link WebhookEvent} to the {@link Operation} it should apply, by its kind:
 * a cleared purchase to a `topUp`, a settled payout to a `settlePayout`, a dispute/chargeback to a
 * `clawback`. This is the single place provider-event kind maps to economy operation; every branch
 * derives the same `eventId`-based dedup key, so whichever kind arrives is applied at most once. A
 * purchase carries no `kind` (treated as `'purchase'`), so the original purchase shape still routes
 * here unchanged.
 */
export function toOperation(event: WebhookEvent): Operation {
  // A purchase event may omit `kind` (the original shape), so check it first via a guard. Pulling
  // the purchase out this way narrows the rest of the union to the kinds with a required `kind`
  // literal, so the switch below exhausts cleanly (the optional purchase discriminant would
  // otherwise defeat the `never` exhaustiveness check).
  if (isPurchase(event)) {
    return toTopUp(event);
  }
  switch (event.kind) {
    case 'payoutSettled':
      return toSettlePayout(event);
    case 'dispute':
      return toClawback(event);
    default:
      // Exhaustiveness guard: a new WebhookEvent variant added without a mapper reaches this branch
      // (its kind is `never`), surfacing the gap as a fault at the edge rather than silently
      // dropping the callback.
      return unreachableEvent(event);
  }
}

// A purchase event carries no `kind` (the original bare purchase shape) or the explicit `'purchase'`.
// Splitting it off with a guard lets `toOperation` narrow the remaining union to the kinds whose
// `kind` is a required literal.
function isPurchase(event: WebhookEvent): event is PurchaseEvent {
  return event.kind === undefined || event.kind === 'purchase';
}

/**
 * The result of accepting a verified webhook. The callback is persisted, not posted: the mapped
 * Operation is enqueued in the transactional inbox for the apply worker (`drainInbox`) to submit
 * later, so the provider gets a fast acknowledgement and the money move settles off the request path.
 * - `accepted`: a fresh provider event; its row was enqueued and will be applied by the next sweep.
 * - `duplicate`: a redelivery of an already-seen `eventId`; the existing row stood and no second was
 *   inserted, so the operation still applies at most once. Mirrors the `duplicate` Outcome the inline
 *   submit used to return when the operation's dedup key was already recorded.
 *
 * `entry` is the stored row (the freshly enqueued one, or the pre-existing one on a duplicate), so
 * the caller can surface the row id without a second read.
 */
export type WebhookAck = {
  status: 'accepted' | 'duplicate';
  entry: InboxEntry;
};

/**
 * Inbound provider-callback dispatch: handles any verified callback. Dispatches the event by its
 * kind to the operation it applies (`topUp` / `settlePayout` / `clawback`, via {@link toOperation}),
 * then persists that operation to the inbox in one transaction and returns immediately. It does NOT
 * post to the ledger inline. The apply worker (`drainInbox`) submits the stored Operation through the
 * normal economy path on its next sweep, so invariants and idempotency apply there, not here.
 *
 * The server edge has already checked signature and freshness and claimed `eventId` in the replay
 * store, so the event is trusted and normally a first-time delivery. A duplicate that still reaches
 * here is enqueued at most once: `enqueueInbound` dedupes on the provider `eventId` (the row `key`),
 * returning the existing row without inserting a second, so the operation applies at most once whether
 * the redelivery is caught here or later by the operation's idempotency key. The status reports which
 * case happened by comparing the returned row id against the one we minted: a returned row carrying a
 * different id means the key was already present.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for how verified callbacks flow through the inbox.
 */
export async function handleWebhook(
  store: Store,
  ctx: { ids: Ids; clock: Clock },
  event: WebhookEvent,
  options?: Options,
): Promise<WebhookAck> {
  // Mint the row inside the same transaction the webhook ingress runs in, mirroring how the outbox
  // enqueues its event in the money move's transaction. `key` is the provider `eventId`, both the
  // dedupe key here and the submitted operation's idempotencyKey (see `toOperation`), so the two
  // layers agree on what "the same event" means whatever the operation kind.
  let row: InboxEntry = {
    id: ctx.ids.next('ibx'),
    key: event.eventId,
    operation: toOperation(event),
    status: 'pending',
    attempts: 0,
    receivedAt: ctx.clock.now(),
    reason: null,
  };
  let stored = await store.transaction(
    (unit) => unit.inbox.enqueueInbound(row, options),
    options,
  );
  // A duplicate provider event is a no-op that returns the row already stored under this key; its id
  // differs from the one we just minted, so an id mismatch is exactly the dedupe case.
  return {
    status: stored.id === row.id ? 'accepted' : 'duplicate',
    entry: stored,
  };
}

/**
 * Handles a verified purchase webhook: the purchase case of {@link handleWebhook}, kept as a named
 * entry point so existing callers (and the original purchase tests) keep working unchanged. It
 * forwards a {@link PurchaseEvent} to the general handler, which maps it to a `topUp` and persists it
 * to the inbox exactly as before. New provider-callback kinds (payout settled, dispute) go through
 * `handleWebhook` directly.
 */
export async function handlePurchaseWebhook(
  store: Store,
  ctx: { ids: Ids; clock: Clock },
  event: PurchaseEvent,
  options?: Options,
): Promise<WebhookAck> {
  return handleWebhook(store, ctx, event, options);
}

/**
 * Decodes an already-parsed purchase webhook body into a typed {@link PurchaseEvent}. Decodes the
 * money field with the same decimal-string codec the rest of the API uses, so the amount survives
 * exactly and never passes through a JSON number. `provider` comes from the URL route, not the
 * body, so the caller can't spoof it. A wrong-shape body or missing/invalid amount throws,
 * letting the server reply 400 before anything reaches the ledger.
 *
 * This decodes the purchase shape specifically (the existing, only wired-up edge). The new
 * settle/dispute kinds map straight from a {@link WebhookEvent} via {@link toOperation}; a decoder
 * for their bodies is additive and not part of this change.
 */
export function decodeWebhookEvent(
  provider: string,
  body: unknown,
): PurchaseEvent {
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

// Returns a required string field, or throws a malformed-event error naming the field. This rejects
// wrong shapes at the edge rather than coercing them into a bad event.
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw malformedEvent(`Webhook field '${field}' must be a string.`);
  }
  return value;
}

// Decodes the `amount` field from its wire string (e.g. 'CREDIT:10.00') into an Amount. The currency
// comes before the colon and the decimal after, the same format the rest of the API uses. A
// non-string value throws here, keeping "wrong shape" and "wrong amount" distinct (the money decoder
// raises the latter on an unparseable value).
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

// Builds the fault for a wrong-shape webhook body, treated as a bad client request like a malformed
// /submit body. It carries the MALFORMED_OPERATION code so the server maps it to 400, not 500.
function malformedEvent(message: string): ReturnType<typeof fault> {
  return fault(ERROR_CODES.MALFORMED_OPERATION, message);
}

// Throws for a WebhookEvent variant `toOperation` has no mapper for. The unmapped kind is `never`
// here, so the call fails to compile until a mapper is added. It is reachable only if a new event
// kind is added to the union without a branch, where it stands in for "decoded a callback kind we
// cannot dispatch". That is a bad request at the edge, so it carries MALFORMED_OPERATION and the
// server answers 400.
function unreachableEvent(event: never): never {
  let kind = (event as { kind?: unknown }).kind;
  throw fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `Webhook event has an unknown kind: ${String(kind)}.`,
    { detail: { kind } },
  );
}
