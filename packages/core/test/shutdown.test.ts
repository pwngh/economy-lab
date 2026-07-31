/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createApp } from '../src/app.js';
import { withDev } from '../src/index.js';
import type { RouteHandler } from '../src/index.js';

/**
 * What `close()` has to do to the sockets underneath it. `server.close()` on its own keeps the
 * handle until every connection ends, so an unanswered request holds it forever and a keep-alive
 * socket that goes idle mid-shutdown holds it for the keep-alive timeout — an operator's stop
 * that hangs instead of draining. Both tests here count the sockets the close ended, because a
 * close that resolves with nothing open proves nothing about either.
 */

/** Node's own keep-alive timeout, which is what an idle socket costs a close that waits on it. */
const KEEP_ALIVE_MS = 5_000;

/** Long enough to see a hang, short enough that seeing one costs seconds. */
const NEVER_SETTLES_MS = 3_000;

async function within<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, blew) => {
        timer = setTimeout(
          () => blew(new Error(`${what} did not settle within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A raw keep-alive connection, so the test holds the socket the server is deciding about. */
interface Wire {
  readonly socket: net.Socket;
  /** Settles when the server ends this connection — the observable form of "drained". */
  readonly ended: Promise<void>;
  /** Whatever has come back so far. */
  read(): string;
}

/**
 * A connection the test owns, and gives back at the end of the test whatever the close did with
 * it. The hand-back is not tidiness: a socket this test still holds keeps the server's handle
 * alive, so a regression here would hang the whole file instead of failing the one assertion
 * that caught it.
 */
function wire(t: TestContext, port: number, path: string): Wire {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const chunks: Buffer[] = [];
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('connect', () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`,
    );
  });
  return {
    socket,
    ended: new Promise<void>((done) => socket.on('close', () => done())),
    read: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** A promise plus the callback that settles it, for "the handler has the request now". */
function arrival(): { at: Promise<void>; reached: () => void } {
  let reached!: () => void;
  return { at: new Promise<void>((r) => (reached = r)), reached };
}

const openApp = (routes: Record<string, RouteHandler>, shutdownMs: number) =>
  createApp(withDev({ authenticate: false, worker: false, routes }), {
    env: {},
    flags: { SHUTDOWN_TIMEOUT_MS: shutdownMs },
  });

test('close() ends a request that is never answered instead of waiting on it forever', async (t) => {
  const parked = arrival();
  const app = await openApp(
    {
      'GET /park': (() =>
        new Promise<Response>(() => parked.reached())) satisfies RouteHandler,
    },
    250,
  );
  const { port } = await app.listen(0, '127.0.0.1');
  const held = wire(t, port, '/park');
  await within(
    parked.at,
    NEVER_SETTLES_MS,
    'the parked request reaching the handler',
  );

  assert.equal(
    held.socket.destroyed,
    false,
    'nothing was open when close() was called, so this run would prove nothing',
  );
  const started = Date.now();
  await within(
    app.close(),
    NEVER_SETTLES_MS,
    'app.close() with a request in flight',
  );
  const elapsed = Date.now() - started;

  await within(held.ended, NEVER_SETTLES_MS, 'the parked connection being cut');
  assert.equal(held.socket.destroyed, true, '1 socket held, 0 drained');
  assert.ok(
    elapsed < 2_000,
    `close() took ${elapsed} ms with one unanswered request; the drain budget was 250 ms`,
  );
  assert.equal(
    held.read(),
    '',
    'the parked request was answered, so it was never the thing close() had to cut',
  );
});

test('close() drains an answer in flight and does not wait on an idle socket', async (t) => {
  const slow = arrival();
  const app = await openApp(
    {
      'GET /ping': (() =>
        new Response('pong', {
          headers: { 'content-type': 'text/plain', 'content-length': '4' },
        })) satisfies RouteHandler,
      'GET /slow': (async () => {
        slow.reached();
        await new Promise((r) => setTimeout(r, 150));
        return new Response('drained-not-severed', {
          headers: {
            'content-type': 'text/plain',
            'content-length': '19',
          },
        });
      }) satisfies RouteHandler,
    },
    // Far longer than both the keep-alive timeout and the work, so a close that returns fast
    // returned because the work finished and not because a clock ran out.
    30_000,
  );
  const { port } = await app.listen(0, '127.0.0.1');

  // Answered and left open: the keep-alive socket nothing is waiting on.
  const idle = wire(t, port, '/ping');
  await within(
    (async () => {
      while (!idle.read().includes('pong')) {
        await new Promise((r) => setTimeout(r, 5));
      }
    })(),
    NEVER_SETTLES_MS,
    'the idle connection getting its answer',
  );
  // Mid-answer: the handler has the request and has not returned.
  const answering = wire(t, port, '/slow');
  await within(
    slow.at,
    NEVER_SETTLES_MS,
    'the slow request reaching the handler',
  );

  const open = [idle, answering].filter((w) => !w.socket.destroyed);
  assert.equal(
    open.length,
    2,
    'both connections are open, so close() has 2 to drain',
  );

  await within(
    app.close(),
    NEVER_SETTLES_MS,
    `app.close() with an answer in flight — waiting on the idle socket costs ${KEEP_ALIVE_MS} ms ` +
      'and waiting out the drain budget costs 30000 ms',
  );

  // Read after the connection ends, never before: the answer is delivered to this end of the
  // socket ahead of its close, and reading on close() resolving races that delivery.
  for (const w of open) {
    await within(
      w.ended,
      NEVER_SETTLES_MS,
      'the connection being ended by close()',
    );
  }
  assert.deepEqual(
    open.map((w) => w.socket.destroyed),
    [true, true],
    '2 sockets held, fewer than 2 drained',
  );

  const answer = answering.read();
  assert.match(
    answer,
    /^HTTP\/1\.1 200 /,
    'the request mid-answer was cut rather than drained',
  );
  assert.ok(
    answer.endsWith('drained-not-severed'),
    `the answer arrived truncated: ${JSON.stringify(answer.slice(-40))}`,
  );
});
