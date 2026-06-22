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

import { httpProcessor } from '#src/adapters/processor.ts';
import { decodeAmount } from '#src/money.ts';
import { EconomyError } from '#src/errors.ts';

import type { FetchLike } from '#src/adapters/processor.ts';

// One captured `fetch` call (URL + options), so a test can assert what the adapter sent:
// method, headers, body, signal.
interface Recorded {
  input: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}

// Fake `fetch` that returns the given response and records each call into `calls`.
// The adapter takes `fetch` as an argument, so this never hits the global fetch or a live provider.
function stubFetch(
  response: { ok: boolean; status: number; body: string },
  calls: Recorded[],
): FetchLike {
  return async (input, init) => {
    calls.push({ input, init });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body,
    };
  };
}

// Fake `fetch` that always throws: failed DNS, dropped connection, or cancelled request.
function throwingFetch(error: unknown): FetchLike {
  return async () => {
    throw error;
  };
}

// Default USD payout request. `key` is an idempotency key: the provider recognizes a repeat
// and won't pay out twice, so a retry runs at most once. Tests reuse this shape and override
// key or amount only when that field is what's under test.
function payout(over?: { key?: string; amount?: string }): {
  key: string;
  userId: string;
  amount: ReturnType<typeof decodeAmount>;
} {
  return {
    key: over?.key ?? 'idem_payout',
    userId: 'usr_seller',
    amount: decodeAmount(over?.amount ?? '1.00', 'USD'),
  };
}

async function submitReturnsProviderRef(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    { ok: true, status: 200, body: JSON.stringify({ providerRef: 'po_1' }) },
    calls,
  );
  let processor = httpProcessor({
    endpoint: 'https://provider/payouts',
    fetch,
  });

  let result = await processor.submitPayout(payout({ key: 'idem_payout_1' }));

  assert.deepEqual(result, { providerRef: 'po_1' });
}

async function submitEncodesAmountAndKey(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    { ok: true, status: 200, body: JSON.stringify({ providerRef: 'po_2' }) },
    calls,
  );
  let processor = httpProcessor({
    endpoint: 'https://provider/payouts',
    fetch,
  });

  await processor.submitPayout(
    payout({ key: 'idem_payout_2', amount: '3.00' }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]!.init!.body!), {
    key: 'idem_payout_2',
    userId: 'usr_seller',
    amount: 'USD:3.00',
  });
}

async function submitForwardsAbortSignal(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    { ok: true, status: 200, body: JSON.stringify({ providerRef: 'po_3' }) },
    calls,
  );
  let processor = httpProcessor({
    endpoint: 'https://provider/payouts',
    fetch,
  });
  let controller = new AbortController();

  await processor.submitPayout(payout({ key: 'idem_payout_3' }), {
    signal: controller.signal,
  });

  assert.equal(calls[0]!.init?.signal, controller.signal);
}

async function submitFaultsRetryablyOnNon2xx(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    { ok: false, status: 503, body: 'upstream down' },
    calls,
  );
  let processor = httpProcessor({
    endpoint: 'https://provider/payouts',
    fetch,
  });

  let error = await processor
    .submitPayout(payout({ key: 'idem_payout_4' }))
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof EconomyError);
  assert.equal(error.code, 'PROVIDER.FAILURE');
  assert.equal(error.retryable, true);
}

async function submitFaultsRetryablyPreservingCause(): Promise<void> {
  let underlying = new Error('connection reset');
  let processor = httpProcessor({
    endpoint: 'https://provider/payouts',
    fetch: throwingFetch(underlying),
  });

  let error = await processor
    .submitPayout(payout({ key: 'idem_payout_5' }))
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof EconomyError);
  assert.equal(error.code, 'PROVIDER.FAILURE');
  assert.equal(error.retryable, true);
  assert.equal((error.cause as EconomyError).cause, underlying);
}

async function submitFaultsTerminallyOnMissingProviderRef(): Promise<void> {
  let calls: Recorded[] = [];
  let fetch = stubFetch(
    { ok: true, status: 200, body: JSON.stringify({ status: 'accepted' }) },
    calls,
  );
  let processor = httpProcessor({
    endpoint: 'https://provider/payouts',
    fetch,
  });

  let error = await processor
    .submitPayout(payout({ key: 'idem_payout_6' }))
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof EconomyError);
  assert.equal(error.code, 'PROVIDER.FAILURE');
  assert.equal(error.retryable, false);
}

describe('Processor Conformance: http', () => {
  test('submits a payout and returns the provider reference', () =>
    submitReturnsProviderRef());
  test('encodes the amount as a decimal string and posts the idempotency key', () =>
    submitEncodesAmountAndKey());
  test('forwards the abort signal on the request', () =>
    submitForwardsAbortSignal());
  test('throws a retryable provider fault on a non-2xx response', () =>
    submitFaultsRetryablyOnNon2xx());
  test('throws a retryable provider fault preserving cause on a transport error', () =>
    submitFaultsRetryablyPreservingCause());
  test('throws a non-retryable fault when a 2xx body omits providerRef', () =>
    submitFaultsTerminallyOnMissingProviderRef());
});
