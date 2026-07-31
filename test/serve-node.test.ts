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

/**
 * The Node host bridge: a Fetch handler answering on a real socket.
 *
 * Everything here runs against loopback rather than a double, because the whole subject is the
 * seam between Node's `http` types and the Fetch types — a double would be the seam re-spelled.
 * The socket also decides two things nothing else can: which address the client actually came
 * from, and whether `close` ever returns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as nodeHttpServer } from 'node:http';

import { serveNode } from '#src/adapters/http-node.ts';
import { CLIENT_IP_HEADER, readBounded } from '#src/server.ts';
import type { FetchHandler } from '#src/server.ts';
import { framingOf } from '#test/support/framing.ts';

const LOOPBACK = { host: '127.0.0.1' } as const;

const ok: FetchHandler = async () => new Response('ok');

test('a handler answers on a real socket, and the bound port is reported back', async () => {
  const live = await serveNode(
    async (request) =>
      new Response(`answered ${new URL(request.url).pathname}`, {
        status: 201,
        headers: { 'x-from': 'handler' },
      }),
    LOOPBACK,
  );
  try {
    assert.ok(live.port > 0, `bound port is ${live.port}`);
    assert.equal(live.url, `http://127.0.0.1:${live.port}`);

    const response = await fetch(`${live.url}/hello`);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-from'), 'handler');
    assert.equal(await response.text(), 'answered /hello');
  } finally {
    await live.close();
  }
});

test('the request crosses whole: method, path, query, repeated headers, body', async () => {
  let seen: {
    method: string;
    url: string;
    accept: string | null;
    body: string;
  } | null = null;
  const live = await serveNode(async (request) => {
    seen = {
      method: request.method,
      url: new URL(request.url).pathname + new URL(request.url).search,
      accept: request.headers.get('accept'),
      body: await request.text(),
    };
    return new Response(null, { status: 204 });
  }, LOOPBACK);
  try {
    const headers = new Headers();
    headers.append('accept', 'text/plain');
    headers.append('accept', 'application/json');
    const response = await fetch(`${live.url}/v1/thing?a=1&b=2`, {
      method: 'POST',
      headers,
      body: 'the-body-bytes',
    });
    assert.equal(response.status, 204);
    assert.deepEqual(seen, {
      method: 'POST',
      url: '/v1/thing?a=1&b=2',
      accept: 'text/plain, application/json',
      body: 'the-body-bytes',
    });
  } finally {
    await live.close();
  }
});

// The header that gates the loopback-only dev tokens and keys the rate limiter. A bridge that
// forwards what arrived hands an attacker both.
test('the client address is the socket peer, not the one the caller sent', async () => {
  let stamped: string | null = null;
  const live = await serveNode(async (request) => {
    stamped = request.headers.get(CLIENT_IP_HEADER);
    return new Response('ok');
  }, LOOPBACK);
  try {
    await fetch(live.url, { headers: { [CLIENT_IP_HEADER]: '203.0.113.9' } });
    assert.equal(stamped, '127.0.0.1');
  } finally {
    await live.close();
  }
});

// The bridge hands the socket through rather than buffering it, so the byte ceiling and read
// deadline stay where the lab enforces them. A bridge that buffers first has already spent the
// memory the ceiling exists to refuse.
test('the body arrives as a stream, so the lab decides the bounds', async () => {
  let verdict: string | null = null;
  let declared: string | null = 'unset';
  const live = await serveNode(async (request) => {
    declared = request.headers.get('content-length');
    verdict = (await readBounded(request, { maxBytes: 1024 })).status;
    return new Response('ok');
  }, LOOPBACK);
  try {
    // Chunked on purpose: a declared content-length lets readBounded refuse before it reads a
    // byte, and then the verdict says nothing about whether the bytes ever crossed.
    await fetch(live.url, {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(chunks) {
          for (let sent = 0; sent < 4; sent += 1) {
            chunks.enqueue(new TextEncoder().encode('x'.repeat(1024)));
          }
          chunks.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    assert.equal(
      declared,
      null,
      'the caller declared a length, so nothing streamed',
    );
    assert.equal(verdict, 'oversize');
  } finally {
    await live.close();
  }
});

// An app's listen() serves its handler on this bridge, so what is framed here is what
// `economy serve` puts on the wire. fetch decodes chunked transfer away, so the framing fields
// are read off the socket raw — the body is whole before the bridge writes, and stating its
// length is what keeps this door framed the same as the express and fastify mounts.
test('an answer is framed with its content-length, never chunked', async () => {
  const answers = [
    {
      name: 'json body',
      response: () =>
        new Response(JSON.stringify({ status: 'committed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
    {
      name: 'null body 404',
      response: () => new Response(null, { status: 404 }),
    },
  ];
  let examined = 0;
  for (const answer of answers) {
    const live = await serveNode(async () => answer.response(), LOOPBACK);
    try {
      const bytes = (await answer.response().arrayBuffer()).byteLength;
      const framed = await framingOf(live.url);
      assert.equal(
        framed.transferEncoding,
        undefined,
        `${answer.name} was chunked`,
      );
      assert.equal(
        framed.contentLength,
        String(bytes),
        `${answer.name} framed as ${framed.contentLength}`,
      );
      assert.equal(framed.bytes, bytes, `${answer.name} body changed`);
      examined += 1;
    } finally {
      await live.close();
    }
  }
  assert.equal(examined, 2, `read ${examined} answers off the socket`);
});

test('a handler that throws answers 500 rather than leaving the socket open', async () => {
  const live = await serveNode(async () => {
    throw new Error('the handler blew up');
  }, LOOPBACK);
  try {
    // Bounded, because the failure being ruled out is a request nobody ever answers, and an
    // unbounded fetch turns that into a hung run instead of a red one.
    const response = await fetch(live.url, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 500);
    await response.arrayBuffer();
  } finally {
    await live.close();
  }
});

test('close takes the listener down and frees the port', async () => {
  const live = await serveNode(ok, LOOPBACK);
  const { port, url } = live;
  await live.close();

  await assert.rejects(() => fetch(url), TypeError);

  // The port is free, which is the property "closed" means to whatever binds next.
  const again = await serveNode(ok, { host: '127.0.0.1', port });
  try {
    assert.equal(again.port, port);
  } finally {
    await again.close();
  }
});

// A close that waits on a request nobody is going to answer never returns, and a shutdown path
// that never returns is the leak this whole handle exists to prevent.
test('close returns with a request parked, and returns again if called twice', async () => {
  const reached = Promise.withResolvers<void>();
  const live = await serveNode(async () => {
    reached.resolve();
    return new Promise<Response>(() => {});
  }, LOOPBACK);
  const parked = fetch(live.url).then(
    () => 'answered',
    () => 'socket cut',
  );
  await reached.promise;

  // Raced rather than awaited, both times: a close that waits on the parked request never
  // returns, and the failure has to report itself rather than hang the run.
  const within = (attempt: Promise<void>) =>
    Promise.race([
      attempt.then(() => 'closed'),
      new Promise((late) => setTimeout(() => late('still waiting'), 5_000)),
    ]);

  assert.equal(await within(live.close()), 'closed');
  assert.equal(await within(live.close()), 'closed', 'the second close hung');
  assert.equal(await parked, 'socket cut');
});

test('close(drainMs) waits for work already in flight', async () => {
  let finished = false;
  const live = await serveNode(async () => {
    await new Promise((done) => setTimeout(done, 150));
    finished = true;
    return new Response('done');
  }, LOOPBACK);

  const inFlight = fetch(live.url);
  // The handler has to be inside the delay before close is asked to drain it.
  await new Promise((done) => setTimeout(done, 50));
  const started = Date.now();
  await live.close(5_000);
  const elapsed = Date.now() - started;

  assert.equal(finished, true, 'close(drainMs) returned before the work did');
  assert.equal(await (await inFlight).text(), 'done');
  // It waits for the work and for nothing else. A keep-alive socket left idle behind the answer
  // holds the listener open for its own timeout, which is seconds after the drain is done.
  assert.ok(
    elapsed < 1_000,
    `close(5000) took ${elapsed}ms after 100ms of work`,
  );
});

// Without this the promise never settles and the caller reports a hang where the real answer is
// "something else already holds that port".
test('a taken port rejects instead of never settling', async () => {
  const holder = nodeHttpServer();
  await new Promise<void>((bound) => holder.listen(0, '127.0.0.1', bound));
  const taken = (holder.address() as { port: number }).port;
  try {
    await assert.rejects(
      () => serveNode(ok, { host: '127.0.0.1', port: taken }),
      /EADDRINUSE/,
    );
  } finally {
    holder.close();
  }
});
