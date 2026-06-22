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

// One captured `fetch` call: the URL plus the options it was given. A test stores these
// so it can check exactly what the adapter sent (which method, headers, body, and signal).
interface Recorded {
  input: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}

// Build a fake `fetch` that always returns the given response and appends each call it
// receives to `calls`. The adapter accepts a `fetch` as an argument, so passing this fake
// in means the test never touches the real global `fetch` or calls a live payment provider.
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

// Build a fake `fetch` that always throws, simulating a request that never completes:
// a failed DNS lookup, a dropped connection, or a cancelled request.
function throwingFetch(error: unknown): FetchLike {
  return async () => {
    throw error;
  };
}

// Build the USD payout request each test submits. The `key` is an idempotency key: a value
// that makes a retried request run at most once, since the provider recognizes a repeat with
// the same key and does not pay out twice. Most tests care about how the adapter handles the
// provider's response, not the request, so they reuse this default shape and only override
// the key or amount when that field is what the test checks.
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
