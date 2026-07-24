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

import type { Operation } from '#src/contract.ts';

// One typed builder per operation kind, so a caller writes `topUp({ ... })` instead of hand-writing
// the tagged union and its `kind` string. Each builder's argument is the operation's fields minus
// `kind`, derived from the union itself, so a new arm or a changed field flows through here with no
// edit. The single cast is sound: kind plus every non-kind field is exactly the arm.

type OpOf<K extends Operation['kind']> = Extract<Operation, { kind: K }>;
type FieldsOf<K extends Operation['kind']> = Omit<OpOf<K>, 'kind'>;

function define<K extends Operation['kind']>(kind: K) {
  return (fields: FieldsOf<K>): OpOf<K> => ({ kind, ...fields }) as OpOf<K>;
}

/**
 * Builds a `topUp` operation: a buyer's cleared cash becomes spendable credit. On commit it
 * credits the user's `spendable` account against `STORED_VALUE`, and a second posting books the
 * backing USD into `TRUST_CASH` at par with the buy-vs-par spread recognized in `REVENUE_USD` —
 * the USD paid is derived from the CREDIT-to-USD buy rate, never passed in. The `source` selects
 * the new credits' maturity horizon; an unrecognized source falls back to the long default. With
 * a purchase catalog configured, an off-catalog `amount` faults `OP.MALFORMED`. Restricted to a
 * `system` or `operator` actor — an end user can never mint credit — and it rejects only with
 * `RISK_DENIED` when the user's recent top-up volume crosses the velocity window. A retried
 * submit under the same `idempotencyKey` returns the original transaction as `duplicate`.
 *
 * @example
 * const outcome = await economy.submit(topUp({
 *   idempotencyKey: idempotencyKey('purchase', 'evt_5521'),
 *   actor: systemActor('payments'),
 *   userId: 'usr_buyer',
 *   amount: toAmount('CREDIT', 60_000n), // 600 credits
 *   source: 'card',
 * }));
 */
export const topUp = define('topUp');

/**
 * Builds a `spend` operation: a marketplace purchase that charges the buyer, pays the sellers,
 * and grants the `sku` in one balanced transaction. The buyer's `promo` balance is drawn first,
 * then `spendable`; each recipient's `earned` account is credited its share of the net, and the
 * platform fee plus any rounding leftover goes to `REVENUE` (the promo-funded part carries no
 * fee). Rejects with `INSUFFICIENT_FUNDS`, `FUNDS_IMMATURE` (credits still in a settlement
 * hold), `DUPLICATE_ORDER` (a sale already exists for this `orderId` under a different key),
 * `RISK_DENIED`, or `ECONOMY_PAUSED`. A `user` actor must be the buyer; `system` and `operator`
 * actors can buy on anyone's behalf. `idempotencyKey` drops exact retries as `duplicate`, while
 * `orderId` is the purchase's identity — the key a later refund names.
 *
 * @example
 * const outcome = await economy.submit(spend({
 *   idempotencyKey: idempotencyKey('order', 'ord_8821'),
 *   actor: userActor('usr_buyer'),
 *   orderId: 'ord_8821',
 *   buyerId: 'usr_buyer',
 *   sku: 'wrld_pass',
 *   price: toAmount('CREDIT', 40_000n), // 400 credits
 *   recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
 * }));
 */
export const spend = define('spend');

/**
 * Builds a `refund` operation: reverses the completed sale recorded under `orderId`, leg for
 * leg. The buyer gets the full price back; each seller's `earned` clawback is capped at the
 * balance they still hold, with any uncollectable remainder booked to `RECEIVABLE` so no user
 * account goes negative. The same transaction revokes the buyer's (or gift recipient's)
 * entitlement to the SKU. Restricted to a `system` or `operator` actor — a self-serve refund
 * would be a fraud vector. Rejects only with `UNKNOWN_ORDER`. An order is reversed at most once:
 * refund and an order-tied clawback share a `reversed:<orderId>` claim, so a second reversal of
 * the same order returns the recorded transaction as `duplicate`, as does a retry under the same
 * `idempotencyKey`.
 *
 * @example
 * const outcome = await economy.submit(refund({
 *   idempotencyKey: idempotencyKey('refund', 'ord_8821'),
 *   actor: systemActor('support'),
 *   orderId: 'ord_8821',
 *   reason: 'buyer request',
 * }));
 */
export const refund = define('refund');

/**
 * Builds a `clawback` operation: books the credit side of a bank chargeback or fraud recovery
 * (the dollars move back at the payment processor, outside this ledger). It debits the user's
 * `spendable` for whatever is still there, books the unrecoverable shortfall to `RECEIVABLE`,
 * and credits the full amount back to `STORED_VALUE`, un-issuing the credits rather than booking
 * revenue the platform never earned. Restricted to a `system` or `operator` actor; in production
 * the verified dispute webhook is the usual caller. It has no rejected path — a well-formed
 * clawback always commits, even against an empty wallet. An `orderId`-tied clawback shares the
 * `reversed:<orderId>` claim with refund, so an already-reversed order returns `duplicate`; for
 * a disputed sale, refund first, then claw back untied from the order.
 *
 * @example
 * const outcome = await economy.submit(clawback({
 *   idempotencyKey: idempotencyKey('whk', 'evt_5521'),
 *   actor: systemActor('webhook:billing'),
 *   userId: 'usr_buyer',
 *   amount: toAmount('CREDIT', 60_000n), // the disputed 600 credits
 *   reason: 'fraudulent_charge',
 * }));
 */
export const clawback = define('clawback');

/**
 * Builds a `requestPayout` operation: opens a seller's cash out. It debits the seller's `earned`
 * account into `PAYOUT_RESERVE` and opens a payout saga in `RESERVED`, storing the USD quote at
 * the request-time CREDIT-to-USD payout rate; the background worker later submits exactly that
 * quote to the rail. No USD moves here and the credits never become spendable — only matured
 * earned credit is payable. Rejects with `BELOW_MINIMUM`, `PAYOUT_TOO_SOON` (carries
 * `retryAfter`), `PAYEE_UNVERIFIED` (when a payee directory is composed in),
 * `INSUFFICIENT_FUNDS`, `FUNDS_IMMATURE` (the matured portion alone must cover the amount;
 * carries `availableAt`), or `ECONOMY_PAUSED` for a `user` actor. A `user` may request only
 * their own payout. The `idempotencyKey` makes a double-tapped cash out open one saga, not two;
 * the committed transaction's `meta.sagaId` names the saga it opened.
 *
 * @example
 * const outcome = await economy.submit(requestPayout({
 *   idempotencyKey: idempotencyKey('payout', 'usr_seller', '2026-07'),
 *   actor: userActor('usr_seller'),
 *   userId: 'usr_seller',
 *   amount: toAmount('CREDIT', 2_500_000n), // cash out 25,000 credits
 * }));
 */
export const requestPayout = define('requestPayout');

/**
 * Builds a `subscribe` operation: charges the first period of a recurring plan, grants the
 * buyer the SKU through the period just billed, and saves the subscription record, all in one
 * transaction; the worker's renewal sweep bills every later period from `spendable` only. The
 * first charge draws `promo` first, then `spendable`, with the platform fee on the spendable
 * part only — the same split as a spend. Rejects with `ALREADY_SUBSCRIBED` (an active
 * subscription already exists for the same buyer, SKU, and seller), `INSUFFICIENT_FUNDS`,
 * `FUNDS_IMMATURE`, `RISK_DENIED`, or `ECONOMY_PAUSED`. A `user` actor may subscribe only their
 * own wallet, and the buyer must differ from the seller. The `price` must sit inside the
 * configured per-period band. A retry under the same `idempotencyKey` returns the first-period
 * transaction as `duplicate`.
 *
 * @example
 * const outcome = await economy.submit(subscribe({
 *   idempotencyKey: idempotencyKey('sub', 'usr_buyer', 'club_pass'),
 *   actor: userActor('usr_buyer'),
 *   userId: 'usr_buyer',
 *   sellerId: 'usr_seller',
 *   sku: 'club_pass',
 *   price: toAmount('CREDIT', 50_000n), // 500 credits per period
 *   periodMs: 2_592_000_000, // 30 days
 * }));
 */
export const subscribe = define('subscribe');

/**
 * Builds a `cancelSubscription` operation: marks the subscription `CANCELED` so the worker's
 * renewal sweep stops billing it. It moves no money — the committed transaction is a lifecycle
 * marker with empty legs — and nothing is refunded or prorated; the remainder of the paid
 * period is forfeited. A `user` actor may cancel only their own subscription (checked against
 * the loaded record); `system` and `operator` actors may cancel anyone's. Rejects with
 * `UNKNOWN_SUBSCRIPTION` when no subscription matches the id or it is already `CANCELED` — the
 * same answer either way, so probing an id never reveals whether it exists — and with
 * `ECONOMY_PAUSED` for a `user` during a maintenance window. Canceling is final for the record;
 * subscribing again opens a fresh one.
 *
 * @example
 * const outcome = await economy.submit(cancelSubscription({
 *   idempotencyKey: idempotencyKey('cancel', 'sub_4f2a'),
 *   actor: userActor('usr_buyer'),
 *   subscriptionId: 'sub_4f2a',
 * }));
 */
export const cancelSubscription = define('cancelSubscription');

/**
 * Builds a `grantEntitlement` operation: records that a user owns a SKU. Ownership is a record,
 * not a balance — no money moves, no ledger legs post, and the committed transaction is a
 * lifecycle marker. A spend grants the buyer's entitlement itself; this direct grant is for
 * manual fulfillment, migration, or a comp. The grant is a full overwrite of any prior record
 * for the user and SKU, and the optional `attrs` (quantity, version, expiresAt, source) are
 * stored, not enforced — no sweep expires an entitlement. Restricted to a `system` or
 * `operator` actor. It has no rejected path: a well-formed grant always commits, and a retry
 * under the same `idempotencyKey` returns the earlier marker as `duplicate` without rewriting
 * the record.
 *
 * @example
 * const outcome = await economy.submit(grantEntitlement({
 *   idempotencyKey: idempotencyKey('comp', 'usr_owner', 'wrld_pass'),
 *   actor: systemActor('fulfillment'),
 *   userId: 'usr_owner',
 *   sku: 'wrld_pass',
 * }));
 * // read.entitled('usr_owner', 'wrld_pass') now resolves true
 */
export const grantEntitlement = define('grantEntitlement');

/**
 * Builds a `revokeEntitlement` operation: drops a user's ownership record for a SKU, the mirror
 * of a grant. No money moves and no ledger legs post; once committed, `read.entitled` for that
 * user and SKU returns false. Restricted to a `system` or `operator` actor — a revoke names a
 * user the caller need not own and posts no debit the ownership rule could catch. Rejects only
 * with `NOT_ENTITLED` when the user does not currently own the SKU (the rejection's `detail`
 * carries the `userId` and `sku`). A retry under the same `idempotencyKey` returns the first
 * result as `duplicate`.
 *
 * @example
 * const outcome = await economy.submit(revokeEntitlement({
 *   idempotencyKey: idempotencyKey('revoke', 'usr_owner', 'wrld_pass'),
 *   actor: systemActor('fulfillment'),
 *   userId: 'usr_owner',
 *   sku: 'wrld_pass',
 *   reason: 'chargeback',
 * }));
 */
export const revokeEntitlement = define('revokeEntitlement');

/**
 * Builds a `grantPromo` operation: issues expiring marketing credit. It credits the user's
 * `promo` account against `PROMO_FLOAT`; promo credit needs no USD backing, is drawn before the
 * buyer's own money on the next spend, and is spendable but never paid out. After `expiresAt`
 * the worker's expiry sweep reverses whatever is unspent, so the timestamp must be strictly in
 * the future (a past one would let the sweep claw the credit straight back) and no more than
 * five years out. Restricted to a `system` or `operator` actor — the operation mints credit
 * into an arbitrary account. It has no rejected path: every failure is a thrown fault. A retry
 * under the same `idempotencyKey` returns the original grant as `duplicate`.
 *
 * @example
 * const outcome = await economy.submit(grantPromo({
 *   idempotencyKey: idempotencyKey('promo', 'summer26', 'usr_buyer'),
 *   actor: systemActor('marketing'),
 *   userId: 'usr_buyer',
 *   amount: toAmount('CREDIT', 25_000n), // 250 credits
 *   expiresAt: Date.now() + 30 * 86_400_000,
 * }));
 */
export const grantPromo = define('grantPromo');

/**
 * Builds an `adjust` operation: the operator's manual correction for cases no ordinary
 * operation covers, such as closing a reconciliation gap. It moves one account by the signed
 * `amount` — negative corrects downward — with the offsetting entry posted to `OPENING_EQUITY`
 * so the books stay balanced; revenue and trust are untouched. Operator-only: the handler
 * refuses even a `system` caller, and the required `reason` is stored on the posting's metadata
 * and hashed into the tamper-evident chain. The amount must be `CREDIT` and non-zero (the one
 * operation whose amount may be negative). It has no rejected path; a retry under the same
 * `idempotencyKey` returns the earlier correction as `duplicate` rather than posting twice.
 *
 * @example
 * const outcome = await economy.submit(adjust({
 *   idempotencyKey: idempotencyKey('recon', '2026-07-22', 'usr_a1'),
 *   actor: operatorActor('op_7'),
 *   account: spendable('usr_a1'),
 *   amount: toAmount('CREDIT', -25_000n), // lower by 250 credits
 *   reason: 'reconciliation: double-posted top-up',
 * }));
 */
export const adjust = define('adjust');

/**
 * Builds a `reverse` operation: the operator's manual undo of a prior posting. It loads the
 * transaction named by `txnId`, locks every account it touched, and posts its exact opposite —
 * same accounts, every leg's sign flipped — so the reversal balances without recomputation. A
 * reversal itself cannot be reversed: undoing an undo would let an operator loop money at will,
 * so a `txnId` marked `kind: "reverse"` is refused. Operator-only; the handler refuses even a
 * `system` caller. It has no rejected path — an unknown `txnId` faults `OP.MALFORMED`. A
 * transaction is reversed at most once through the shared `reversed:<txnId>` claim (the same
 * family refund and clawback use): a second reverse, or a retry under the same
 * `idempotencyKey`, returns the first reversal as `duplicate`. For an in-flight payout, use
 * `reversePayout` instead, which unwinds the saga rather than flipping ledger legs.
 *
 * @example
 * const outcome = await economy.submit(reverse({
 *   idempotencyKey: idempotencyKey('undo', 'txn_5f21'),
 *   actor: operatorActor('op_7'),
 *   txnId: 'txn_5f21',
 *   reason: 'reconciliation: duplicate posting',
 * }));
 */
export const reverse = define('reverse');

/**
 * Builds a `reversePayout` operation: undoes a payout that has not yet disbursed USD. In one
 * transaction it marks the saga `FAILED` and moves the full reserve out of `PAYOUT_RESERVE`
 * back to the seller's `earned` account. It applies to a `RESERVED` saga, or a `SUBMITTED` one
 * aged past `maxPayoutAgeMs` — a younger `SUBMITTED` payout is still in the rail's hands and is
 * refused with `SAGA.INVALID_TRANSITION` (the verified payout-failed webhook waives that gate
 * via `providerReported`; never set it by hand), as is a `SETTLED` payout, whose USD already
 * left trust. An already-`FAILED` saga returns `duplicate` with no posting, and the guarded
 * state change means two racing attempts can never both return the same reserve. Restricted to
 * an `operator` or `system` actor; `userId` must match the saga's own seller, since it names
 * the account the engine locks.
 *
 * @example
 * const outcome = await economy.submit(reversePayout({
 *   idempotencyKey: idempotencyKey('unwind', 'pay_9f2c'),
 *   actor: operatorActor('op_7'),
 *   userId: 'usr_seller',
 *   sagaId: 'pay_9f2c',
 *   reason: 'fraud hold',
 * }));
 */
export const reversePayout = define('reversePayout');

/**
 * Builds a `settlePayout` operation: the `SUBMITTED` to `SETTLED` step of the payout saga,
 * driven by the rail's verified "payout settled" webhook — the rail has already paid, and this
 * records it. It posts two balanced entries in one transaction: the reserve empties from
 * `PAYOUT_RESERVE` into `REVENUE`, and the gross USD leaves trust (`USD_CLEARING` against
 * `TRUST_CASH`). The posted figures come from the saga's reserve at its locked payout rate;
 * `providerAmount` is recorded for reconciliation but never posted. Restricted to a `system`
 * or `operator` actor — an end user must never settle their own payout. No rejected path: a
 * missing saga faults `OP.MALFORMED`, a not-yet-submitted or already-`FAILED` saga faults
 * `SAGA.INVALID_TRANSITION` (retryably for the race with the submit sweep). The settlement
 * applies at most once: a redelivered webhook replays as `duplicate` by its event-derived
 * `idempotencyKey`, and a fresh key against an already-`SETTLED` saga answers `duplicate` too.
 *
 * @example
 * const outcome = await economy.submit(settlePayout({
 *   idempotencyKey: idempotencyKey('whk', 'evt_ps_8821'),
 *   actor: systemActor('webhook:tilia'),
 *   sagaId: 'pay_9f2c',
 *   providerRef: 'acct_77/ps_8821',
 * }));
 */
export const settlePayout = define('settlePayout');

/**
 * Mints an idempotency key: `idem_` plus the joined parts when given (so a caller can derive the
 * same key on retry from its own identifiers), else a random UUID for one-shot scripts.
 */
export function idempotencyKey(...parts: ReadonlyArray<string>): string {
  return parts.length > 0
    ? `idem_${parts.join(':')}`
    : `idem_${crypto.randomUUID()}`;
}
