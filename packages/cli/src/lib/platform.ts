/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeClientIp } from '@pwngh/economy-lab/server';

export type Runtime = 'node' | 'bun' | 'deno';

interface BunServer {
  port: number;
  // `stop()` stops accepting and leaves in-flight requests alone; `stop(true)` terminates them.
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}
interface BunLike {
  serve(options: {
    port: number;
    hostname?: string;
    fetch(
      request: Request,
      server: { requestIP?(request: Request): { address: string } | null },
    ): Promise<Response>;
  }): BunServer;
}
interface DenoLike {
  serve(
    options: {
      port: number;
      hostname?: string;
      // Aborting this is Deno's only non-graceful close: it ends the server and every
      // connection, where `shutdown()` waits for pending requests with no deadline.
      signal?: AbortSignal;
      onListen(addr: { port: number }): void;
    },
    handler: (
      request: Request,
      info: { remoteAddr?: { hostname?: string } },
    ) => Promise<Response>,
  ): {
    addr: { port: number };
    /** Resolves once the server is finished, including when the signal above was aborted. */
    finished: Promise<void>;
    shutdown(): Promise<void>;
  };
  /** Deno's error classes. Optional because a caller injecting these globals for a test supplies
   *  what it drives, and only the taken-port classification reads this one. */
  errors?: { AddrInUse: new (...args: never[]) => Error };
}
/** The runtime globals, injectable so the Bun and Deno legs are testable under Node. */
export interface RuntimeGlobals {
  Bun?: BunLike;
  Deno?: DenoLike;
}

export function detectRuntime(
  g: RuntimeGlobals = globalThis as RuntimeGlobals,
): Runtime {
  if (g.Bun) return 'bun';
  if (g.Deno) return 'deno';
  return 'node';
}

export interface PlatformOwner {
  /** How the refusal names the deploy shape — "a Cloudflare Worker". */
  readonly platform: string;
  /** The platform's own run command, printed verbatim in the refusal. */
  readonly command: string;
}

// Detected from the files on disk, never a knob: a wrangler config or a Next app means
// the platform owns the server and `economy serve` would be a second, half-working one.
export function platformOwner(dir: string): PlatformOwner | null {
  if (
    ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((f) =>
      existsSync(join(dir, f)),
    )
  ) {
    return { platform: 'a Cloudflare Worker', command: 'wrangler dev' };
  }
  const nextConfig = [
    'next.config.ts',
    'next.config.js',
    'next.config.mjs',
  ].some((f) => existsSync(join(dir, f)));
  return nextConfig || hasDependency(dir, 'next')
    ? { platform: 'a Next.js app', command: 'next dev' }
    : null;
}

function hasDependency(dir: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return (
      name in (pkg.dependencies ?? {}) || name in (pkg.devDependencies ?? {})
    );
  } catch {
    return false;
  }
}

function withClientIp(request: Request, ip: string | undefined): Request {
  const headers = new Headers(request.headers);
  sanitizeClientIp(headers, ip);
  return new Request(request, { headers });
}

/**
 * A listener one of the Fetch runtimes opened, and the only handle that closes it.
 *
 * `close` is the contract the lab's `NodeServer.close` states, so all three runtimes `economy
 * serve` binds on shut down the same way: stop accepting, give an answer already in flight
 * `drainMs` to finish, then cut what is left. The default of `0` cuts at once, and `economy serve`
 * passes `SHUTDOWN_TIMEOUT_MS` — the drain `App.close()` gives the Node listener.
 */
export interface FetchServer {
  readonly port: number;
  close(drainMs?: number): Promise<void>;
}

// Draining and severing are different shutdowns and each runtime spells them apart, so both
// arrive as callbacks. The cut is awaited, never raced, so this resolves with the listener down
// rather than with a request nobody will answer still holding it.
async function drainThenCut(
  drainMs: number,
  drain: () => Promise<void>,
  cut: () => Promise<void>,
): Promise<void> {
  if (drainMs <= 0) {
    await cut();
    return;
  }
  const draining = drain();
  // Not unref'd: past the deadline this timer is the only thing that cuts, and an unref'd timer
  // is skipped outright when it is the last handle the loop is holding.
  let deadline: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((fire) => {
    deadline = setTimeout(() => fire(false), drainMs);
  });
  const drained = await Promise.race([draining.then(() => true), expired]);
  clearTimeout(deadline);
  if (!drained) await cut();
}

/**
 * A bind refused because something else already holds the port.
 *
 * Node raises this shape itself, so it is the one shape the CLI reads on all three runtimes. The
 * port comes from what was asked for, not from the throw: Deno's error states no number, and Bun
 * puts it only in the message text.
 */
export class PortInUse extends Error {
  readonly code = 'EADDRINUSE';

  constructor(
    readonly port: number,
    options: { cause: unknown },
  ) {
    super(`listen EADDRINUSE: address already in use :${port}`, options);
    this.name = 'PortInUse';
  }
}

/** True for the taken-port shape every runtime's bind failure reaches the CLI in. */
export function isPortInUse(
  error: unknown,
): error is { code: string; port?: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

// Both runtimes bind synchronously inside serve(), so this is the one step that can find the port
// taken, and the one place that knows which port was asked for.
function bind<T>(port: number, g: RuntimeGlobals, open: () => T): T {
  try {
    return open();
  } catch (error) {
    if (addressInUse(error, g)) throw new PortInUse(port, { cause: error });
    throw error;
  }
}

// Each Fetch runtime names a taken port its own way, and neither states which port. Bun raises
// Node's `code: 'EADDRINUSE'`; Deno raises `Deno.errors.AddrInUse`, documented as extending the
// base Error, so the class and the `name` it sets are everything it says.
function addressInUse(error: unknown, g: RuntimeGlobals): boolean {
  const AddrInUse = g.Deno?.errors?.AddrInUse;
  if (AddrInUse !== undefined && error instanceof AddrInUse) return true;
  return (
    isPortInUse(error) ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AddrInUse')
  );
}

/** Binds the handler on the runtime's own server — Bun.serve or Deno.serve; Node binds through app.listen(). */
// max-params 5: the bind inputs are passed positionally; an options object is the register's
// form and the change belongs with a caller sweep, not this pass.
// eslint-disable-next-line max-params
export async function serveFetch(
  runtime: Exclude<Runtime, 'node'>,
  handler: (request: Request) => Promise<Response>,
  port: number,
  host: string | undefined,
  g: RuntimeGlobals = globalThis as RuntimeGlobals,
): Promise<FetchServer> {
  if (runtime === 'bun') {
    const server = bind(port, g, () =>
      g.Bun!.serve({
        port,
        ...(host ? { hostname: host } : {}),
        fetch: (request, server_) =>
          handler(withClientIp(request, server_.requestIP?.(request)?.address)),
      }),
    );
    return {
      port: server.port,
      close: (drainMs = 0) =>
        drainThenCut(
          drainMs,
          async () => {
            await server.stop();
          },
          async () => {
            await server.stop(true);
          },
        ),
    };
  }
  const severed = new AbortController();
  const server = bind(port, g, () =>
    g.Deno!.serve(
      {
        port,
        ...(host ? { hostname: host } : {}),
        signal: severed.signal,
        onListen: () => {},
      },
      (request, info) =>
        handler(withClientIp(request, info.remoteAddr?.hostname)),
    ),
  );
  return {
    port: server.addr.port,
    close: (drainMs = 0) =>
      drainThenCut(
        drainMs,
        () => server.shutdown(),
        () => {
          severed.abort();
          return server.finished;
        },
      ),
  };
}
