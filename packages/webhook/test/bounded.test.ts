/**
 * @pwngh/economy-webhook
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_READ_TIMEOUT_MS,
} from '@pwngh/economy-lab/server';

import {
  createWebhookVerifier,
  signBody,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../src/index.js';

const SECRET = 'ba9d1c07e4f8a3b5';
const NOW = 1753574400000;

function gate(options: { maxBodyBytes?: number; readTimeoutMs?: number } = {}) {
  return createWebhookVerifier({
    secrets: [SECRET],
    now: () => NOW,
    ...options,
  });
}

/**
 * A body that reports what the gate did to it: how many chunks it pulled, and whether it
 * cancelled. A gate that reads to the end pulls every chunk and cancels nothing.
 */
function chunkedBody(chunkBytes: number, chunks: number) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    pulled: () => pulled,
    cancelled: () => cancelled,
    bytes: chunkBytes * chunks,
  };
}

/** A body that hands over one chunk and then never says another word. */
function stalledBody() {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

function delivery(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://api.example.com/webhooks/steam', {
    method: 'POST',
    headers: new Headers({ [TIMESTAMP_HEADER]: String(NOW), ...headers }),
    body,
    // @ts-expect-error duplex is required for a stream body and is not in the lib types yet
    duplex: 'half',
  });
}

/** Resolves to the sentinel when the gate is still reading, so a hang fails instead of hanging. */
async function within<T>(
  ms: number,
  work: Promise<T>,
): Promise<T | 'still reading'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'still reading'>((resolve) => {
        timer = setTimeout(() => resolve('still reading'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a body past the ceiling is refused, and the stream is not read to the end', async () => {
  const body = chunkedBody(16 * 1024, 64);
  assert.ok(
    body.bytes > DEFAULT_MAX_BODY_BYTES,
    'the fixture body has to be larger than the ceiling it is testing',
  );

  const result = await within(
    3_000,
    gate().verify('steam', delivery(body.stream)),
  );

  assert.notEqual(result, 'still reading');
  assert.ok(typeof result === 'object' && result.status === 'refused');
  assert.equal(result.reason, 'oversize');
  assert.match(result.message, /65536/);
  assert.ok(body.cancelled(), 'the oversize stream was left open');
  assert.ok(
    body.pulled() < 64,
    `the gate pulled all ${body.pulled()} chunks of a body it refused`,
  );
});

// The ceiling has to settle before the signature, or a forged 32 MiB body still buys 32 MiB of
// buffer. The reason names which check answered, so the order is observable.
test('the ceiling answers before the signature does, signed or not', async () => {
  const unsigned = await within(
    3_000,
    gate().verify('steam', delivery(chunkedBody(16 * 1024, 64).stream)),
  );
  assert.ok(typeof unsigned === 'object' && unsigned.status === 'refused');
  assert.equal(
    unsigned.reason,
    'oversize',
    'an oversize body was answered by the signature check',
  );

  const raw = new Uint8Array(
    DEFAULT_MAX_BODY_BYTES + 1,
  ) as Uint8Array<ArrayBuffer>;
  const honest = await gate().verifyDelivery({
    provider: 'steam',
    raw,
    signature: await signBody(raw, SECRET),
    timestamp: NOW,
  });
  assert.ok(honest.status === 'refused');
  assert.equal(
    honest.reason,
    'oversize',
    'a correctly signed body past the ceiling was let through',
  );
});

// Counting alone answers only after the bytes have arrived. The declaration is what lets the
// gate say no while the body is still on the wire, so it has to be read on its own terms — a
// body small enough to pass the count is still refused for declaring more than the ceiling.
test('a declared content-length past the ceiling is refused on the declaration alone', async () => {
  const small = chunkedBody(64, 1);
  const declared = await within(
    3_000,
    gate().verify(
      'steam',
      delivery(small.stream, { 'content-length': String(16 * 1024 * 64) }),
    ),
  );

  assert.ok(typeof declared === 'object' && declared.status === 'refused');
  assert.equal(declared.reason, 'oversize');
  assert.match(declared.message, /65536/);

  // The same 64 bytes with nothing declared get as far as the signature, so the refusal above
  // is the declaration and not the body.
  const undeclared = await within(
    3_000,
    gate().verify('steam', delivery(chunkedBody(64, 1).stream)),
  );
  assert.ok(typeof undeclared === 'object' && undeclared.status === 'refused');
  assert.equal(undeclared.reason, 'signature');
});

test('a stalled stream is refused at the deadline and reclaimed', async () => {
  const body = stalledBody();
  const result = await within(
    3_000,
    gate({ readTimeoutMs: 50 }).verify('steam', delivery(body.stream)),
  );

  assert.notEqual(
    result,
    'still reading',
    'the gate is still holding a stalled stream',
  );
  assert.ok(typeof result === 'object' && result.status === 'refused');
  assert.equal(result.reason, 'timeout');
  assert.match(result.message, /50ms/);
  assert.ok(body.cancelled(), 'the stalled stream was left open');
});

// `Number(process.env.MAX_BODY_BYTES)` on an unset variable is NaN, and every comparison against
// NaN is false — the ceiling off, silently. Infinity is the same hole spelled differently.
test('a ceiling or a deadline that is not a real quantity is refused at construction', () => {
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createWebhookVerifier({ secrets: [SECRET], maxBodyBytes: bad }),
      /body ceiling/,
      `a ceiling of ${String(bad)} built a verifier`,
    );
    assert.throws(
      () => createWebhookVerifier({ secrets: [SECRET], readTimeoutMs: bad }),
      /read deadline/,
      `a deadline of ${String(bad)} built a verifier`,
    );
  }
  assert.ok(createWebhookVerifier({ secrets: [SECRET], maxBodyBytes: 0 }));
  assert.ok(createWebhookVerifier({ secrets: [SECRET], readTimeoutMs: 0 }));
});

// The gate and the lab's own route refuse at the same size because they read the same constant.
test('the ceiling sits exactly on the lab default, and one byte decides it', async () => {
  const at = async (byteLength: number) => {
    const raw = new Uint8Array(byteLength) as Uint8Array<ArrayBuffer>;
    const result = await gate().verifyDelivery({
      provider: 'steam',
      raw,
      signature: await signBody(raw, SECRET),
      timestamp: NOW,
    });
    return result.status === 'refused' ? result.reason : result.status;
  };

  assert.equal(
    await at(DEFAULT_MAX_BODY_BYTES),
    'malformed',
    'the ceiling refused a body that is exactly its own size',
  );
  assert.equal(await at(DEFAULT_MAX_BODY_BYTES + 1), 'oversize');
});

test('a body inside both bounds still verifies', async () => {
  const purchase = {
    eventId: 'evt_8123',
    userId: 'usr_ada',
    amount: 'CREDIT:600.00',
    source: 'steam',
  };
  const raw = new TextEncoder().encode(JSON.stringify(purchase));
  const signature = await signBody(raw, SECRET);
  const request = new Request('https://api.example.com/webhooks/steam', {
    method: 'POST',
    headers: new Headers({
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: String(NOW),
    }),
    body: raw,
  });

  const result = await gate().verify('steam', request);

  assert.equal(result.status, 'verified');
  assert.ok(DEFAULT_READ_TIMEOUT_MS > 0);
});
