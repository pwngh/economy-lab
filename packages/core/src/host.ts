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

import type { IncomingMessage } from 'node:http';
import { sanitizeClientIp } from '@pwngh/economy-lab/server';

// The two halves of the Node/Fetch conversion, published on ./internal for the express and
// fastify seams to compose. Binding a socket is not done here: `listen()` serves the handler on
// the lab's `serveNode`. What keeps this pair package-local is the `rawBody` override below —
// a framework hands over a request whose stream a body parser already drained, and the lab's
// converter hands the socket straight through and so cannot take one.

/** Node request → Fetch Request. `rawBody` overrides the stream when a framework already
 *  buffered it — the one legal way past a body parser that consumed the stream. */
export function toRequest(req: IncomingMessage, rawBody?: Uint8Array): Request {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) for (const one of v) headers.append(k, one);
  }
  sanitizeClientIp(headers, req.socket?.remoteAddress);
  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : rawBody !== undefined
        ? (rawBody as BodyInit)
        : (req as unknown as ReadableStream);
  return new Request(url, {
    method: req.method,
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
}

export async function writeResponse(
  response: Response,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const body = response.body
    ? Buffer.from(await response.arrayBuffer())
    : undefined;
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  // A Response carries no content-length, and Node frames a lengthless answer chunked. The
  // body is whole in hand, so its length is stated and every transport frames one Response
  // the same way. 204 and 304 carry no body to frame.
  if (
    headers['content-length'] === undefined &&
    headers['transfer-encoding'] === undefined &&
    response.status !== 204 &&
    response.status !== 304
  ) {
    headers['content-length'] = String(body?.byteLength ?? 0);
  }
  res.writeHead(response.status, headers);
  res.end(body);
}
