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
 * The typed client over the wire contract: one write verb mirroring `/submit`, one method
 * per `/v1` read. No domain methods and no invented verbs — the wire's vocabulary is the
 * client's. Browser law: ship only a user token to a browser; system and operator tokens
 * live server-side, and the host session maps to the user principal.
 *
 * @module client
 */

import type { Saga, Subscription, EntitlementGrant } from '#src/ports.ts';
import type { RejectionDetail } from '#src/contract.ts';

/** Amounts on the wire are currency-tagged decimal strings, e.g. `CREDIT:120.00`. */
export type WireAmount = string;

/** The `/submit` body: `kind`, `idempotencyKey`, and the kind's fields. Never `actor` —
 *  the server stamps the authenticated principal. */
export type WireOperation = { kind: string; idempotencyKey: string } & Record<
  string,
  unknown
>;

export type WireOutcome =
  | { status: 'committed' | 'duplicate'; transaction: Record<string, unknown> }
  | {
      status: 'rejected';
      reason: RejectionDetail['reason'];
      detail: Record<string, unknown>;
    };

/** One page of a `/v1` list. Hand `cursor` back to read the next page; null is the end of the
 *  list. The token is opaque: pass it through, never parse it. */
export type WirePage<T> = { items: T[]; cursor: string | null };

/**
 * The field that identifies a row in each `/v1` list.
 *
 * A sku is unique per user, and a row id is unique outright, so each of these is a total order
 * and a page boundary drawn on it never skips or repeats a row. The server orders and resumes
 * the entitlements list on `sku` directly; the other two order on `updatedAt` and break its ties
 * on `id`, which is why `id` is what identifies one of their rows.
 *
 * Exported because it is the wire's answer, not the server's: anything merging two reads of one
 * list — a storefront widening a page, a cache reconciling a poll — needs the same field the
 * cursor was drawn on, and deriving it from a row's shape instead guesses wrong on any row
 * carrying both.
 */
export const WIRE_LIST_KEY = {
  entitlements: 'sku',
  subscriptions: 'id',
  payouts: 'id',
} as const;

/** The three `/v1` reads that answer a {@link WirePage}. */
export type WireListName = keyof typeof WIRE_LIST_KEY;

/**
 * A row's identity within its list, as a string two rows can be compared on.
 *
 * Null for a row carrying no usable value in its list's key field — such a row cannot be matched
 * against another and callers leave it where it is rather than dropping it.
 *
 * The field name is carried in the key, joined on U+0000. That byte cannot occur in a field name,
 * so an `id`-keyed row and a `sku`-keyed row can never produce the same string even when their
 * values are equal. It is written as the `\0` escape and never as a raw byte: a raw NUL makes the
 * whole file binary to `grep`, which then prints nothing at all rather than reporting that it
 * skipped it.
 */
export function wireRowIdentity(
  list: WireListName,
  row: unknown,
): string | null {
  const field = WIRE_LIST_KEY[list];
  const value = (row as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === 'string' ? `${field}\0${value}` : null;
}

/**
 * A base joined to a path with exactly one slash between them.
 *
 * Every trailing slash comes off the base and every leading slash off the path, because one
 * short of that is a live credential leak rather than a cosmetic double slash: `'/'` joined to
 * `'/checkout'` by concatenation is `//checkout`, which a browser reads as protocol-relative and
 * resolves by treating `checkout` as the HOST — so the bearer goes to a machine nobody
 * configured. Stripping exactly one slash from each side leaves `'//'` doing the same thing.
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

// The cross-copy brand, keyed in the global symbol registry the same way EconomyError's is.
const HTTP_BRAND: unique symbol = Symbol.for(
  '@pwngh/economy-lab.EconomyHttpError',
);

/** A transport or auth failure (4xx/5xx). A business "no" is a returned rejection, never a throw.
 *  Match it with {@link EconomyHttpError.is}: `instanceof` misses a throw from a second copy of
 *  this package. */
export class EconomyHttpError extends Error {
  readonly status: number;
  readonly body: string;

  readonly [HTTP_BRAND] = true;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'EconomyHttpError';
    this.status = status;
    this.body = body;
  }

  /** True for an EconomyHttpError thrown by any copy of this package. */
  static is(value: unknown): value is EconomyHttpError {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { [HTTP_BRAND]?: unknown })[HTTP_BRAND] === true
    );
  }
}

export type ClientOptions = {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
};

export type EconomyClient = {
  healthy(): Promise<boolean>;
  submit(operation: WireOperation): Promise<WireOutcome>;
  wallet(userId?: string): Promise<Record<string, WireAmount>>;
  entitlements(
    userId?: string,
    limit?: number,
    cursor?: string,
  ): Promise<WirePage<EntitlementGrant>>;
  subscriptions(
    userId?: string,
    opts?: { state?: Subscription['state']; limit?: number; cursor?: string },
  ): Promise<WirePage<Record<string, unknown>>>;
  payouts(
    userId?: string,
    opts?: { state?: Saga['state']; limit?: number; cursor?: string },
  ): Promise<WirePage<Record<string, unknown>>>;
  rates(): Promise<Record<string, unknown>>;
  catalog(): Promise<{ bundles: WireAmount[]; skus: unknown[] }>;
  posting(txnId: string): Promise<Record<string, unknown> | null>;
};

// Maps a 404 to null. Only posting() opts in: the route answers 404 for unknown and
// foreign transactions alike, and that absence is its contract. Every other method
// surfaces a 404 as the transport error it is.
async function nullIfAbsent<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (EconomyHttpError.is(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
}

// Builds a read's query string. It takes the whole option bag rather than named fields, so a
// field added to a read reaches the wire instead of being dropped here. An undefined value is
// left off entirely.
function query(
  userId?: string,
  extra: Record<string, string | number | undefined> = {},
): string {
  const params = new URLSearchParams();
  if (userId !== undefined) params.set('userId', userId);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

/**
 * An HTTP client for an economy running behind {@link createServer}, over `fetch`.
 *
 * ```ts
 * const economy = createClient({
 *   baseUrl: 'https://economy.example.com',
 *   token: 'usr_ada_session_token',
 * });
 *
 * const outcome = await economy.submit({
 *   kind: 'spend',
 *   idempotencyKey: 'idem_ord_918',
 *   buyerId: 'usr_ada',
 *   sku: 'aurora_avatar',
 *   price: 'CREDIT:500.00',
 *   recipients: [{ sellerId: 'usr_nova', shareBps: 10000 }],
 *   orderId: 'ord_918',
 * });
 * const balances = await economy.wallet('usr_ada');
 * ```
 *
 * `token` is a fixed string. A bearer that rotates belongs to `@pwngh/economy-client`, whose
 * client reads one per request; passing a function here throws rather than sending
 * `Bearer () => 'tok'`. `fetch` defaults to the global, bound, because a browser refuses a
 * detached call to its own.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service}
 *   for the routes behind each method.
 */
export function createClient(options: ClientOptions): EconomyClient {
  if (options.token !== undefined && typeof options.token !== 'string') {
    throw new TypeError(
      'createClient takes a string bearer. A TokenSource belongs to @pwngh/economy-client, whose createClient reads one per request.',
    );
  }
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const response = await doFetch(joinUrl(options.baseUrl, path), {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new EconomyHttpError(response.status, text);
    }
    // A proxy or captive portal answers 200 with HTML. That is a transport failure, so it
    // reads as one, and the body rides along for whoever has to debug it.
    try {
      return JSON.parse(text);
    } catch {
      throw new EconomyHttpError(response.status, text);
    }
  };

  return {
    // Any HTTP error status reads as unhealthy; only a failing fetch itself escapes.
    healthy: async () => {
      try {
        const body = (await request('GET', '/healthz')) as { status?: string };
        return body.status === 'ok';
      } catch (error) {
        if (EconomyHttpError.is(error)) {
          return false;
        }
        throw error;
      }
    },
    submit: (operation) =>
      request('POST', '/submit', operation) as Promise<WireOutcome>,
    wallet: (userId) =>
      request('GET', `/v1/wallet${query(userId)}`) as Promise<
        Record<string, WireAmount>
      >,
    entitlements: (userId, limit, cursor) =>
      request(
        'GET',
        `/v1/entitlements${query(userId, { limit, cursor })}`,
      ) as Promise<WirePage<EntitlementGrant>>,
    subscriptions: (userId, opts) =>
      request(
        'GET',
        `/v1/subscriptions${query(userId, { ...opts })}`,
      ) as Promise<WirePage<Record<string, unknown>>>,
    payouts: (userId, opts) =>
      request('GET', `/v1/payouts${query(userId, { ...opts })}`) as Promise<
        WirePage<Record<string, unknown>>
      >,
    rates: () =>
      request('GET', '/v1/rates') as Promise<Record<string, unknown>>,
    catalog: () =>
      request('GET', '/v1/catalog') as Promise<{
        bundles: WireAmount[];
        skus: unknown[];
      }>,
    posting: (txnId) =>
      nullIfAbsent(
        request('GET', `/v1/posting/${encodeURIComponent(txnId)}`) as Promise<
          Record<string, unknown>
        >,
      ),
  };
}
