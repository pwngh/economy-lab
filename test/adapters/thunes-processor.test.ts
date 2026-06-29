/// <reference types="node" />
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  thunesProcessor,
  decodeThunesPayoutCallback,
} from '#src/adapters/thunes-processor.ts';
import { decodeAmount, encodeAmount } from '#src/money.ts';
import { EconomyError } from '#src/errors.ts';

import type {
  ThunesProcessorConfig,
  ThunesRecipient,
} from '#src/adapters/thunes-processor.ts';
import type { FetchLike } from '#src/adapters/processor.ts';

// One captured `fetch` call (URL + options), so a test can assert what the adapter sent:
// method, path, headers, body, signal.
interface Recorded {
  input: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}

// A single queued HTTP response: the Thunes status + the raw body string the adapter will parse.
interface Reply {
  ok: boolean;
  status: number;
  body: string;
}

// Fake `fetch` that replays `replies` in order (the adapter makes up to four calls per payout) and
// records each call into `calls`. The adapter takes `fetch` as config, so this never touches the
// global fetch or a live provider.
function stubFetch(replies: Reply[], calls: Recorded[]): FetchLike {
  let next = 0;
  return async (input, init) => {
    calls.push({ input, init });
    let reply = replies[next++];
    if (reply === undefined) {
      throw new Error(`stubFetch: no queued reply for call ${next}`);
    }
    return {
      ok: reply.ok,
      status: reply.status,
      text: async () => reply.body,
    };
  };
}

// Fake `fetch` that always throws: failed DNS, dropped connection, or cancelled request.
function throwingFetch(error: unknown): FetchLike {
  return async () => {
    throw error;
  };
}

// A 2xx JSON reply carrying `{ id }`, the shape quotation/transaction responses take.
function withId(id: string): Reply {
  return { ok: true, status: 200, body: JSON.stringify({ id }) };
}

// A non-2xx reply carrying the Thunes error envelope `{ errors: [{ code }] }`.
function withErrorCode(status: number, code: string): Reply {
  return { ok: false, status, body: JSON.stringify({ errors: [{ code }] }) };
}

// Fixed Thunes routing for a recipient, so the resolver is deterministic and never hits a real store.
function recipient(): ThunesRecipient {
  return {
    payerId: 'payer_gh_wallet',
    creditPartyIdentifier: { msisdn: '+233200000000' },
    beneficiary: { lastname: 'Mensah', country_iso_code: 'GHA' },
    destinationCurrency: 'GHS',
  };
}

// Build the adapter over the queued replies. Credentials and sender are fixed; `resolveRecipient`
// returns the fixed routing above. Tests override only the field under test.
function config(over: { fetch: FetchLike }): ThunesProcessorConfig {
  return {
    baseUrl: 'https://api.thunes.test',
    apiKey: 'key_abc',
    apiSecret: 'secret_xyz',
    sender: { name: 'Platform Payouts Ltd' },
    resolveRecipient: async () => recipient(),
    fetch: over.fetch,
  };
}

// Default USD payout request. `key` is the saga id and the idempotency key (Thunes' external_id), so
// a retry runs the flow at most once. Tests reuse this and override key/amount only when under test.
function payout(over?: { key?: string; amount?: string }): {
  key: string;
  userId: string;
  amount: ReturnType<typeof decodeAmount>;
} {
  return {
    key: over?.key ?? 'pay_0',
    userId: 'usr_seller',
    amount: decodeAmount(over?.amount ?? '1.00', 'USD'),
  };
}

// The happy three-call flow: quotation -> transaction -> confirm, returning the transaction id as the
// provider reference.
async function submitDrivesQuotationTransactionConfirm(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    [withId('quo_1'), withId('txn_1'), { ok: true, status: 200, body: '' }],
    calls,
  );
  let processor = thunesProcessor(config({ fetch }));

  let result = await processor.submitPayout(payout({ key: 'pay_1' }));

  assert.deepEqual(result, { providerRef: 'txn_1' });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => `${c.init?.method} ${c.input}`),
    [
      'POST https://api.thunes.test/v2/money-transfer/quotations',
      'POST https://api.thunes.test/v2/money-transfer/quotations/quo_1/transactions',
      'POST https://api.thunes.test/v2/money-transfer/transactions/txn_1/confirm',
    ],
  );
}

// The amount is sent as a Thunes amount object and the saga id rides on every step as external_id.
async function submitEncodesAmountAndThreadsExternalId(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    [withId('quo_2'), withId('txn_2'), { ok: true, status: 200, body: '' }],
    calls,
  );
  let processor = thunesProcessor(config({ fetch }));

  await processor.submitPayout(payout({ key: 'pay_2', amount: '3.00' }));

  let quotation = JSON.parse(calls[0]!.init!.body!);
  assert.deepEqual(quotation.source, { amount: 3, currency: 'USD' });
  assert.equal(quotation.external_id, 'pay_2');
  assert.equal(quotation.payer_id, 'payer_gh_wallet');
  let transaction = JSON.parse(calls[1]!.init!.body!);
  assert.equal(transaction.external_id, 'pay_2');
  assert.deepEqual(transaction.credit_party_identifier, {
    msisdn: '+233200000000',
  });
}

// Every request carries the HTTP Basic authorization header built from the credentials.
async function submitSendsBasicAuth(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    [withId('quo_3'), withId('txn_3'), { ok: true, status: 200, body: '' }],
    calls,
  );
  let processor = thunesProcessor(config({ fetch }));

  await processor.submitPayout(payout({ key: 'pay_3' }));

  let expected = `Basic ${btoa('key_abc:secret_xyz')}`;
  for (let call of calls) {
    assert.equal(call.init?.headers?.authorization, expected);
  }
}

// The caller's abort signal is forwarded onto every underlying request.
async function submitForwardsAbortSignal(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    [withId('quo_4'), withId('txn_4'), { ok: true, status: 200, body: '' }],
    calls,
  );
  let processor = thunesProcessor(config({ fetch }));
  let controller = new AbortController();

  await processor.submitPayout(payout({ key: 'pay_4' }), {
    signal: controller.signal,
  });

  for (let call of calls) {
    assert.equal(call.init?.signal, controller.signal);
  }
}

// A transient (5xx) status is a retryable provider fault, so the worker re-submits next sweep.
async function submitFaultsRetryablyOnTransientStatus(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    [{ ok: false, status: 503, body: 'upstream down' }],
    calls,
  );
  let processor = thunesProcessor(config({ fetch }));

  let error = await processor
    .submitPayout(payout({ key: 'pay_5' }))
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof EconomyError);
  assert.equal(error.code, 'PROVIDER.FAILURE');
  assert.equal(error.retryable, true);
  assert.equal(calls.length, 1); // failed at the quotation step; no transaction was created
}

// A client-error (4xx) status that isn't an idempotent-replay code is terminal: not retryable, so the
// worker stops re-submitting and reverses the seller's reserve rather than burning attempts.
async function submitFaultsTerminallyOnClientStatus(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch([withErrorCode(400, '1003011')], calls);
  let processor = thunesProcessor(config({ fetch }));

  let error = await processor
    .submitPayout(payout({ key: 'pay_6' }))
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof EconomyError);
  assert.equal(error.code, 'PROVIDER.FAILURE');
  assert.equal(error.retryable, false);
}

// A transport failure (thrown fetch) is a retryable provider fault, preserving the original cause.
async function submitFaultsRetryablyPreservingCause(): Promise<void> {
  let underlying = new Error('connection reset');
  let processor = thunesProcessor(config({ fetch: throwingFetch(underlying) }));

  let error = await processor
    .submitPayout(payout({ key: 'pay_7' }))
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof EconomyError);
  assert.equal(error.code, 'PROVIDER.FAILURE');
  assert.equal(error.retryable, true);
  assert.equal((error.cause as EconomyError).cause, underlying);
}

// Idempotent replay of confirm: a re-run whose confirm reports the transaction already confirmed is
// success — the disbursement is in flight — and returns the transaction id as the provider reference.
async function confirmAlreadyConfirmedIsSuccess(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    [withId('quo_8'), withId('txn_8'), withErrorCode(409, '1007002')],
    calls,
  );
  let processor = thunesProcessor(config({ fetch }));

  let result = await processor.submitPayout(payout({ key: 'pay_8' }));

  assert.deepEqual(result, { providerRef: 'txn_8' });
}

// Idempotent replay of transaction creation: a reused external_id means the transaction already
// exists, so the adapter recovers it by partner reference and continues to confirm.
async function reusedExternalIdRecoversTransaction(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    [
      withId('quo_9'),
      withErrorCode(409, '1007001'),
      withId('txn_9'),
      { ok: true, status: 200, body: '' },
    ],
    calls,
  );
  let processor = thunesProcessor(config({ fetch }));

  let result = await processor.submitPayout(payout({ key: 'pay_9' }));

  assert.deepEqual(result, { providerRef: 'txn_9' });
  assert.equal(
    calls[2]!.input,
    'https://api.thunes.test/v2/money-transfer/transactions/ext-pay_9',
  );
  assert.equal(calls[2]!.init?.method, 'GET');
}

// A completed transaction callback maps to the PayoutSettledEvent the webhook edge already applies:
// external_id -> sagaId, transaction id -> providerRef/eventId, source amount -> providerAmount.
function callbackCompletedMapsToSettleEvent(): void {
  let event = decodeThunesPayoutCallback('thunes', {
    id: 'txn_10',
    external_id: 'pay_10',
    status: '70000',
    source: { amount: 12.5, currency: 'USD' },
  });

  assert.ok(event !== null);
  assert.equal(event.kind, 'payoutSettled');
  assert.equal(event.provider, 'thunes');
  assert.equal(event.eventId, 'txn_10');
  assert.equal(event.sagaId, 'pay_10');
  assert.equal(event.providerRef, 'txn_10');
  assert.equal(encodeAmount(event.providerAmount), 'USD:12.50');
}

// An in-flight (non-terminal) status yields no settle event, so the edge acks and waits.
function callbackInFlightYieldsNull(): void {
  let event = decodeThunesPayoutCallback('thunes', {
    id: 'txn_11',
    external_id: 'pay_11',
    status: '50000',
    source: { amount: 12.5, currency: 'USD' },
  });

  assert.equal(event, null);
}

// A wrong-shape callback body is rejected at the edge as a malformed operation (server answers 400).
function callbackRejectsMalformedBody(): void {
  let error = (() => {
    try {
      decodeThunesPayoutCallback('thunes', 'not-an-object');
      return null;
    } catch (caught) {
      return caught;
    }
  })();

  assert.ok(error instanceof EconomyError);
  assert.equal(error.code, 'OP.MALFORMED');
}

describe('Processor Conformance: thunes', () => {
  test('submits a payout via quotation -> transaction -> confirm', () =>
    submitDrivesQuotationTransactionConfirm());
  test('encodes the amount and threads the saga id as external_id', () =>
    submitEncodesAmountAndThreadsExternalId());
  test('authenticates every request with HTTP Basic', () =>
    submitSendsBasicAuth());
  test('forwards the abort signal on every request', () =>
    submitForwardsAbortSignal());
  test('throws a retryable provider fault on a transient status', () =>
    submitFaultsRetryablyOnTransientStatus());
  test('throws a non-retryable provider fault on a client-error status', () =>
    submitFaultsTerminallyOnClientStatus());
  test('throws a retryable provider fault preserving cause on a transport error', () =>
    submitFaultsRetryablyPreservingCause());
  test('treats an already-confirmed transaction as success', () =>
    confirmAlreadyConfirmedIsSuccess());
  test('recovers the transaction when the external_id was already used', () =>
    reusedExternalIdRecoversTransaction());
});

describe('Thunes settlement callback', () => {
  test('maps a completed transaction to a payout-settled event', () =>
    callbackCompletedMapsToSettleEvent());
  test('yields no event for an in-flight transaction', () =>
    callbackInFlightYieldsNull());
  test('rejects a malformed callback body', () =>
    callbackRejectsMalformedBody());
});
