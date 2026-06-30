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

import { httpDispatcher } from '#src/adapters/http-dispatcher.ts';
import { runDispatcherConformance } from '#test/conformance/dispatcher.ts';

import type { EconomyEvent } from '#src/ports.ts';
import type { DispatcherHarness } from '#test/conformance/dispatcher.ts';

// Sample event to dispatch.
const event: EconomyEvent = {
  id: 'evt_1',
  type: 'economy.sale.completed',
  version: 1,
  occurredAt: 0,
  subject: 'usr_1',
  data: { orderId: 'ord_1' },
  audience: 'internal',
};

// Returns a fetch stub that records every call and then returns a canned response or throws to simulate a network failure. It opens no real socket.
function stubFetch(outcome: { ok: boolean; status: number } | Error): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function isRetryableProviderFailure(error: unknown): boolean {
  const e = error as { code?: string; retryable?: boolean };
  return e.code === 'PROVIDER.FAILURE' && e.retryable === true;
}

describe('httpDispatcher', () => {
  test('POSTs the event envelope with the event id as the idempotency key', async () => {
    const { fetch, calls } = stubFetch({ ok: true, status: 200 });
    const dispatch = httpDispatcher({
      url: 'https://bus.internal/economy',
      fetch,
    });

    await dispatch(event);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://bus.internal/economy');
    assert.equal(calls[0].init.method, 'POST');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['idempotency-key'], 'evt_1');
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.id, 'evt_1');
    assert.equal(body.subject, 'usr_1');
    assert.deepEqual(body.data, { orderId: 'ord_1' });
  });

  test('a non-2xx response throws a retryable PROVIDER.FAILURE', async () => {
    const { fetch } = stubFetch({ ok: false, status: 503 });
    const dispatch = httpDispatcher({
      url: 'https://bus.internal/economy',
      fetch,
    });

    await assert.rejects(dispatch(event), isRetryableProviderFailure);
  });

  test('a network error throws a retryable PROVIDER.FAILURE', async () => {
    const { fetch } = stubFetch(new Error('ECONNREFUSED'));
    const dispatch = httpDispatcher({
      url: 'https://bus.internal/economy',
      fetch,
    });

    await assert.rejects(dispatch(event), isRetryableProviderFailure);
  });
});

// Builds a harness that runs the shared Dispatcher contract against the HTTP adapter over a fake fetch.
function httpHarness(): DispatcherHarness {
  const bodies: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let fail: Error | null = null;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    signals.push(init.signal ?? undefined);
    if (fail) {
      const error = fail;
      fail = null;
      throw error;
    }
    bodies.push(init.body as string);
    return { ok: true, status: 200 } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    dispatcher: httpDispatcher({
      url: 'https://bus.internal/economy',
      fetch: fetchFn,
    }),
    bodies,
    signals,
    failNext: (error) => {
      fail = error;
    },
  };
}

runDispatcherConformance('http', httpHarness);
