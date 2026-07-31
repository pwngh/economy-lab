/**
 * @pwngh/economy-client
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { createClient as createWireClient } from '@pwngh/economy-lab/client';

import type { EconomyClient } from '@pwngh/economy-lab/client';

/**
 * A token read fresh for every request. Use it when the bearer rotates — a session that
 * refreshes, or a short-lived token minted per call — so the client outlives the token
 * rather than being rebuilt around each new one.
 */
export type TokenSource = () => string | Promise<string>;

export type ClientOptions = {
  /** Where the economy answers, e.g. `https://api.example.com`. A trailing slash is fine. */
  readonly baseUrl: string;

  /**
   * The bearer for every call, either fixed or read per request. In a browser this is only
   * ever a user token; system and operator tokens stay server-side.
   */
  readonly token?: string | TokenSource;

  /** Stand-in transport, for tests and for runtimes that route fetch through their own. */
  readonly fetch?: typeof fetch;

  /**
   * Extra headers on every request, e.g. a tracing id. A non-empty bearer overwrites
   * `authorization`; otherwise an `authorization` set here is the one that goes out.
   */
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * Builds a client over a remote economy. Every method is the lab's own — this factory
 * settles the transport and the bearer, then hands both to it.
 *
 * @example
 * let client = createClient({ baseUrl: 'https://api.example.com', token: session.token });
 * await client.wallet(); // { spendable: 'CREDIT:600.00', earned: 'CREDIT:0.00', ... }
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   the routes, tokens, and paging this speaks to.
 */
export function createClient(options: ClientOptions): EconomyClient {
  const { token, headers } = options;

  if (typeof token !== 'function' && headers === undefined) {
    return createWireClient({
      baseUrl: options.baseUrl,
      ...(token === undefined ? {} : { token }),
      fetch: options.fetch ?? boundGlobalFetch(),
    });
  }

  // No `token` goes to the wire client on this path: the transport already wrote the header, and
  // passing it twice would let a stale fixed token overwrite a fresh read one.
  return createWireClient({
    baseUrl: options.baseUrl,
    fetch: createTransport(options),
  });
}

/** What {@link createTransport} stamps on the requests it forwards. */
export type TransportOptions = {
  /** The bearer, fixed or read per request. An empty one sends no `authorization` header. */
  readonly token?: string | TokenSource;

  /** Extra headers on every request, e.g. a tracing id. A non-empty bearer wins `authorization`. */
  readonly headers?: Readonly<Record<string, string>>;

  readonly fetch?: typeof fetch;
};

/**
 * A `fetch` carrying the same bearer and headers {@link createClient} sends, for the requests
 * that do not go through it. A host's own routes are the case: they take the caller's session but
 * speak the host's vocabulary rather than the wire contract, so they cannot ride a client method
 * and must not grow a second copy of the header rules.
 *
 * @example
 * let post = createTransport({ token: () => session.token });
 * await post('/checkout', { method: 'POST', body: JSON.stringify({ sku: 'sku_hat' }) });
 */
export function createTransport(options: TransportOptions): typeof fetch {
  // Called detached below, which a browser refuses for its own fetch, so bind it here.
  const transport = options.fetch ?? boundGlobalFetch();
  const { token, headers } = options;

  return async (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers ?? {})) {
      merged.set(name, value);
    }
    if (token !== undefined) {
      const bearer = typeof token === 'function' ? await token() : token;
      // `Bearer` with nothing behind it is a malformed header, not an anonymous call.
      if (bearer !== '') {
        merged.set('authorization', `Bearer ${bearer}`);
      }
    }
    return transport(input, { ...init, headers: merged });
  };
}

// A runtime with no global fetch is a supported place to run; forgetting the option there is
// what needs saying, rather than a TypeError about reading a property of undefined.
function boundGlobalFetch(): typeof fetch {
  if (typeof globalThis.fetch !== 'function') {
    throw new TypeError(
      'createClient found no global fetch in this runtime; pass one as options.fetch.',
    );
  }
  return globalThis.fetch.bind(globalThis);
}
