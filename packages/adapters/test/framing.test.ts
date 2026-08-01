/**
 * @pwngh/economy-adapters
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
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Fastify from 'fastify';
import { economyExpress } from '../src/express.js';
import { economyFastify } from '../src/fastify.js';
import type { FetchLike } from '../src/lib/mount.js';
import { framingOf } from '../../../test/support/framing.js';
import type { Framed } from '../../../test/support/framing.js';

// Every response shape the adapters have to agree on. A transport that invents a body or a
// content type is answering something the economy did not say.
const ANSWERS: readonly {
  readonly name: string;
  readonly response: () => Response;
}[] = [
  {
    name: 'null body 404 — both scaffold templates return exactly this',
    response: () => new Response(null, { status: 404 }),
  },
  {
    name: 'null body 200',
    response: () => new Response(null, { status: 200 }),
  },
  {
    name: 'problem document',
    response: () =>
      new Response(JSON.stringify({ title: 'Not found.', status: 404 }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }),
  },
  {
    name: 'json outcome',
    response: () =>
      new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
];

/** What a client can actually observe, so a difference here is a difference on the wire. */
interface Observed {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: number;
}

const observe = async (response: Response): Promise<Observed> => ({
  status: response.status,
  contentType: response.headers.get('content-type'),
  bytes: (await response.arrayBuffer()).byteLength,
});

const observed = async (origin: string): Promise<Observed> =>
  observe(await fetch(`${origin}/anything`));

async function throughExpress<T>(
  handler: FetchLike,
  probe: (origin: string) => Promise<T>,
): Promise<T> {
  const server = express();
  server.use(economyExpress(handler));
  const listening = server.listen(0, '127.0.0.1');
  await once(listening, 'listening');
  const { port } = listening.address() as AddressInfo;
  try {
    return await probe(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => listening.close(() => done()));
  }
}

async function throughFastify<T>(
  handler: FetchLike,
  probe: (origin: string) => Promise<T>,
): Promise<T> {
  const server = Fastify();
  await server.register(economyFastify(handler) as never);
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  try {
    return await probe(address);
  } finally {
    await server.close();
  }
}

for (const answer of ANSWERS) {
  test(`both adapters frame the same: ${answer.name}`, async () => {
    const handler: FetchLike = () => Promise.resolve(answer.response());
    const source = await observe(answer.response());
    const viaExpress = await throughExpress(handler, observed);
    const viaFastify = await throughFastify(handler, observed);
    assert.deepEqual(
      viaFastify,
      viaExpress,
      'express and fastify hand the same Response to the client',
    );
    assert.deepEqual(
      viaExpress,
      source,
      'and it is the Response the economy returned, not one the transport rebuilt',
    );
  });
}

// The comparison above holds a decoded Response, so it cannot see the framing at all. The reader
// that can is shared with the lab's own bridge suite, which frames the same answers at its door.
const wired = (origin: string): Promise<Framed> =>
  framingOf(`${origin}/anything`);

// The body is whole before either mount writes, so its length is known and stated: every answer
// carries content-length and none falls back to transfer-encoding: chunked.
test('both adapters frame every answer with its content-length on the wire', async () => {
  let examined = 0;
  for (const answer of ANSWERS) {
    const handler: FetchLike = () => Promise.resolve(answer.response());
    const bytes = (await answer.response().arrayBuffer()).byteLength;
    const doors = [
      ['express', await throughExpress(handler, wired)],
      ['fastify', await throughFastify(handler, wired)],
    ] as const;
    for (const [door, framed] of doors) {
      assert.equal(
        framed.transferEncoding,
        undefined,
        `${door} chunked "${answer.name}"`,
      );
      assert.equal(
        framed.contentLength,
        String(bytes),
        `${door} framed "${answer.name}" as ${framed.contentLength}`,
      );
      assert.equal(
        framed.bytes,
        bytes,
        `${door} changed the body of "${answer.name}"`,
      );
      examined += 1;
    }
  }
  assert.equal(
    examined,
    ANSWERS.length * 2,
    `read ${examined} answers off the wire`,
  );
});

test('the framing table covers every answer shape it claims to', () => {
  assert.equal(ANSWERS.length, 4, 'four response shapes compared per adapter');
});
