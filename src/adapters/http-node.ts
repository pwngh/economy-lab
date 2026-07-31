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

import { sanitizeClientIp } from '#src/server.ts';

import type { FetchHandler } from '#src/server.ts';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Where {@link serveNode} binds. */
export interface ServeNodeOptions {
  /**
   * The port to bind. `0` takes whatever the operating system hands out, and the bound number
   * comes back on {@link NodeServer.port}. Default `0`.
   */
  readonly port?: number;

  /**
   * The interface to bind. Omitted, the listener answers on every interface; pass `'127.0.0.1'`
   * to stay on loopback.
   */
  readonly host?: string;
}

/**
 * A listener {@link serveNode} opened, and the only handle that closes it.
 *
 * The framework opened this socket, so the framework closes it: there is no variant of
 * {@link serveNode} that takes a server the caller already has, and so no handle here that
 * closes something the caller still owns.
 */
export interface NodeServer {
  /** The bound port, resolved — the number the operating system gave out when `port` was `0`. */
  readonly port: number;

  /** The origin a client reaches this listener on, e.g. `http://127.0.0.1:53312`. */
  readonly url: string;

  /**
   * Stops accepting, then ends what is still open.
   *
   * `drainMs` is how long a request already in flight has to finish; past it the connection is
   * cut. The default of `0` cuts immediately, so a caller with nothing to drain cannot be held
   * open by a request that is never going to be answered. Calling it again returns the same
   * shutdown rather than starting a second one.
   */
  close(drainMs?: number): Promise<void>;
}

/**
 * Serves a Fetch handler on Node's HTTP server.
 *
 * The lab's `createServer` answers `Request` with `Response`, which is the surface Bun, Deno and
 * Cloudflare Workers already speak; Node is the one that does not, and this is the adapter for it.
 * Bun and Deno take the handler directly (`Bun.serve`, `Deno.serve`) and need nothing from here.
 *
 * ```ts
 * const live = await serveNode(createServer({ economy, ports, authenticate }), {
 *   port: 8080,
 * });
 * console.warn(live.url); // http://127.0.0.1:8080
 * await live.close(5_000); // drain for five seconds, then cut
 * ```
 *
 * The request body is handed through as a stream rather than buffered here, so the byte ceiling
 * and read deadline stay where the lab enforces them (`readBounded`, and the `maxBodyBytes` and
 * `readTimeoutMs` a host sets on `ServerOptions`). Whatever arrived in `CLIENT_IP_HEADER` is
 * replaced by the socket's peer address, because the socket is the only party that knows it.
 *
 * A port already in use rejects the returned promise; it does not hang.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 * the routes the served handler answers.
 */
export async function serveNode(
  handler: FetchHandler,
  options: ServeNodeOptions = {},
): Promise<NodeServer> {
  // Imported here rather than at the top so this module stays loadable on the runtimes that have
  // no node:http at all; only calling serveNode requires Node.
  const { createServer } = await import('node:http');
  const drain: Drain = { started: false };
  const server = createServer((request, response) => {
    // Once a shutdown is under way, a connection that has just gone idle is one nothing is
    // waiting on. Without this, close() sits on every keep-alive socket for its whole timeout.
    response.on('close', () => {
      if (drain.started) {
        server.closeIdleConnections();
      }
    });
    void answer(handler, request, response);
  });
  return new Promise<NodeServer>((listening, failed) => {
    // A taken port raises 'error' and never raises 'listening', so without this the promise
    // never settles.
    server.once('error', failed);
    server.listen({ port: options.port ?? 0, host: options.host }, () => {
      server.removeListener('error', failed);
      const address = server.address() as AddressInfo;
      listening({
        port: address.port,
        url: originOf(address),
        close: closer(server, drain),
      });
    });
  });
}

async function answer(
  handler: FetchHandler,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const answered = await handler(toRequest(request));
    const body =
      answered.body === null
        ? undefined
        : new Uint8Array(await answered.arrayBuffer());
    const headers: Record<string, string> = {};
    answered.headers.forEach((value, name) => {
      headers[name] = value;
    });
    // A Response carries no content-length, and Node frames a lengthless answer chunked. The
    // body is whole in hand, so its length is stated and this bridge frames the way the
    // framework mounts do. 204 and 304 carry no body to frame.
    if (
      headers['content-length'] === undefined &&
      headers['transfer-encoding'] === undefined &&
      answered.status !== 204 &&
      answered.status !== 304
    ) {
      headers['content-length'] = String(body?.byteLength ?? 0);
    }
    response.writeHead(answered.status, headers);
    response.end(body);
  } catch {
    // The handler is the whole application, so there is nothing here that could say more than
    // that it failed. Anything already written to the socket is past recall; end it either way
    // rather than leaving the connection open on a half-sent answer.
    if (!response.headersSent) {
      response.writeHead(500);
    }
    response.end();
  }
}

function toRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const one of value) {
        headers.append(name, one);
      }
    }
  }
  sanitizeClientIp(headers, request.socket.remoteAddress);
  const method = request.method ?? 'GET';
  return new Request(
    `http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`,
    {
      method,
      headers,
      // A GET or HEAD carries no body, and handing one an empty stream is rejected outright.
      // duplex: 'half' is what lets the socket be the body instead of a buffer of it.
      body:
        method === 'GET' || method === 'HEAD'
          ? undefined
          : (request as unknown as ReadableStream<Uint8Array>),
      duplex: 'half',
    } as RequestInit,
  );
}

/** Whether a shutdown has been asked for, shared by the listener and the closer. */
interface Drain {
  started: boolean;
}

function closer(
  server: Server,
  drain: Drain,
): (drainMs?: number) => Promise<void> {
  let closing: Promise<void> | undefined;
  return (drainMs = 0) => {
    closing ??= new Promise<void>((down, failed) => {
      drain.started = true;
      const cut =
        drainMs > 0
          ? setTimeout(() => server.closeAllConnections(), drainMs)
          : undefined;
      cut?.unref();
      server.close((error) => {
        clearTimeout(cut);
        if (error) {
          failed(error);
        } else {
          down();
        }
      });
      // close() alone waits for every open connection, and a keep-alive socket sitting idle is
      // open. Idle ones go now; in-flight ones get drainMs.
      server.closeIdleConnections();
      if (drainMs <= 0) {
        server.closeAllConnections();
      }
    });
    return closing;
  };
}

// An address bound to every interface reports '::' or '0.0.0.0', and neither is somewhere a
// client can connect to. Loopback is, and it is the one interface every bind covers.
function originOf(address: AddressInfo): string {
  const unspecified =
    address.address === '' ||
    address.address === '::' ||
    address.address === '0.0.0.0';
  const host = unspecified ? '127.0.0.1' : address.address;
  return host.includes(':')
    ? `http://[${host}]:${address.port}`
    : `http://${host}:${address.port}`;
}
