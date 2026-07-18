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

import { httpAnchor } from '#src/adapters/http-anchor.ts';
import { ERROR_CODES } from '#src/errors.ts';
import { hasCode } from '#test/support/capabilities.ts';

import type { Checkpoint } from '#src/ports.ts';

const checkpoint: Checkpoint = {
  id: 'chk_anchor_1',
  root: 'a'.repeat(64),
  signature: 'bb'.repeat(32),
  count: 2,
  at: 1_000,
  v: 2,
  sum: '0',
  kid: 'feedfacefeedface',
};

describe('httpAnchor', () => {
  test('POSTs the checkpoint as JSON under its id as the idempotency key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const anchor = httpAnchor({
      url: 'https://log.example/anchors',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('ok');
      }) as unknown as typeof fetch,
    });

    await anchor.publish(checkpoint);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://log.example/anchors');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['idempotency-key'], 'chk_anchor_1');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), checkpoint);
  });

  test('a non-2xx response throws a retryable provider fault', async () => {
    const anchor = httpAnchor({
      url: 'https://log.example/anchors',
      fetch: (async () =>
        new Response('no', { status: 500 })) as unknown as typeof fetch,
    });

    await assert.rejects(
      anchor.publish(checkpoint),
      hasCode(ERROR_CODES.PROVIDER_FAILURE),
    );
  });

  test('a network error throws a retryable provider fault', async () => {
    const anchor = httpAnchor({
      url: 'https://log.example/anchors',
      fetch: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });

    await assert.rejects(
      anchor.publish(checkpoint),
      hasCode(ERROR_CODES.PROVIDER_FAILURE),
    );
  });
});
