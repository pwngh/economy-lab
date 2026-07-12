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
import { runProcessorConformance } from '#test/conformance/processor.ts';
import { fakeProcessor } from '#test/support/capabilities.ts';

import type { FetchLike } from '#src/adapters/processor.ts';

interface Recorded {
  input: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}

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

function throwingFetch(error: unknown): FetchLike {
  return async () => {
    throw error;
  };
}

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

describe('Processor Conformance: http', () => {
  test('submits a payout and returns the provider reference', async () => {
    const calls: Recorded[] = [];
    const fetch = stubFetch(
      { ok: true, status: 200, body: JSON.stringify({ providerRef: 'po_1' }) },
      calls,
    );
    const processor = httpProcessor({
      endpoint: 'https://provider/payouts',
      fetch,
    });

    const result = await processor.submitPayout(
      payout({ key: 'idem_payout_1' }),
    );

    assert.deepEqual(result, { providerRef: 'po_1' });
  });

  test('encodes the amount as a decimal string and posts the idempotency key', async () => {
    const calls: Recorded[] = [];
    const fetch = stubFetch(
      { ok: true, status: 200, body: JSON.stringify({ providerRef: 'po_2' }) },
      calls,
    );
    const processor = httpProcessor({
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
  });

  test('forwards the abort signal on the request', async () => {
    const calls: Recorded[] = [];
    const fetch = stubFetch(
      { ok: true, status: 200, body: JSON.stringify({ providerRef: 'po_3' }) },
      calls,
    );
    const processor = httpProcessor({
      endpoint: 'https://provider/payouts',
      fetch,
    });
    const controller = new AbortController();

    await processor.submitPayout(payout({ key: 'idem_payout_3' }), {
      signal: controller.signal,
    });

    assert.equal(calls[0]!.init?.signal, controller.signal);
  });

  test('throws a retryable provider fault on a non-2xx response', async () => {
    const calls: Recorded[] = [];
    const fetch = stubFetch(
      { ok: false, status: 503, body: 'upstream down' },
      calls,
    );
    const processor = httpProcessor({
      endpoint: 'https://provider/payouts',
      fetch,
    });

    const error = await processor
      .submitPayout(payout({ key: 'idem_payout_4' }))
      .catch((caught: unknown) => caught);

    assert.ok(error instanceof EconomyError);
    assert.equal(error.code, 'PROVIDER.FAILURE');
    assert.equal(error.retryable, true);
  });

  test('throws a retryable provider fault preserving cause on a transport error', async () => {
    const underlying = new Error('connection reset');
    const processor = httpProcessor({
      endpoint: 'https://provider/payouts',
      fetch: throwingFetch(underlying),
    });

    const error = await processor
      .submitPayout(payout({ key: 'idem_payout_5' }))
      .catch((caught: unknown) => caught);

    assert.ok(error instanceof EconomyError);
    assert.equal(error.code, 'PROVIDER.FAILURE');
    assert.equal(error.retryable, true);
    assert.equal((error.cause as EconomyError).cause, underlying);
  });

  test('throws a non-retryable fault when a 2xx body omits providerRef', async () => {
    const calls: Recorded[] = [];
    const fetch = stubFetch(
      { ok: true, status: 200, body: JSON.stringify({ status: 'accepted' }) },
      calls,
    );
    const processor = httpProcessor({
      endpoint: 'https://provider/payouts',
      fetch,
    });

    const error = await processor
      .submitPayout(payout({ key: 'idem_payout_6' }))
      .catch((caught: unknown) => caught);

    assert.ok(error instanceof EconomyError);
    assert.equal(error.code, 'PROVIDER.FAILURE');
    assert.equal(error.retryable, false);
  });
});

function respondingProcessor(response: {
  ok: boolean;
  status: number;
  body: string;
}): ReturnType<typeof httpProcessor> {
  return httpProcessor({
    endpoint: 'https://provider/payouts',
    fetch: stubFetch(response, []),
  });
}

runProcessorConformance('httpProcessor', {
  accepted: () =>
    respondingProcessor({
      ok: true,
      status: 200,
      body: JSON.stringify({ providerRef: 'po_contract' }),
    }),
  indeterminate: () =>
    respondingProcessor({ ok: false, status: 503, body: 'upstream down' }),
  rejected: () => respondingProcessor({ ok: true, status: 200, body: '{}' }),
});

runProcessorConformance('fakeProcessor (the lab test double)', {
  accepted: () => fakeProcessor(),
});
