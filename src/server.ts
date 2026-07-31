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
 * The HTTP surface: the server and the webhook intake.
 *
 * @module server
 */

import { decodeWire, encodeWire } from '#src/adapters/http-wire.ts';
import {
  ERROR_CODES,
  EconomyError,
  fault,
  normalizeError,
  statusForError,
  wireDetail,
} from '#src/errors.ts';

import type { ErrorCode } from '#src/errors.ts';
import { checkedConfig } from '#src/config.ts';
import { SYSTEM, isWalletAccount, ownerOf } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { fromBase64Url, fromHex, toBase64Url, toHex } from '#src/bytes.ts';
import { decodeWebhookEvent } from '#src/webhooks.ts';
import { FIELDS, hasWireShape } from '#src/wire-contract.ts';
import type { BaseSpec, Spec } from '#src/wire-contract.ts';

import { encodeAmounts } from '#src/money.ts';
import { SAGA_STATES, SUBSCRIPTION_STATES } from '#src/ports.ts';
import type {
  RateLimiter,
  RateVerdict,
  ReplayStore,
  Ports,
} from '#src/ports.ts';
import type { Economy, Operation, Outcome, Principal } from '#src/contract.ts';
import type { InstanceEconomies, InstancePurchase } from '#src/instance.ts';
import { WIRE_LIST_KEY } from '#src/client.ts';
import type { WireListName } from '#src/client.ts';

/**
 * Host handler for inbound provider callbacks (webhooks), e.g. a payment processor reporting a
 * settlement or dispute. Takes the URL's provider name and the request, and returns the HTTP
 * response.
 *
 * By the time the handler runs, the server has verified signature and freshness — the bytes
 * are trusted. `request` is a fresh `Request` over the same raw body, re-readable without
 * double-consuming.
 */
export type WebhookHandler = (
  provider: string,
  request: Request,
) => Promise<Response>;

/**
 * Authenticates `/submit`. Maps the request to the acting principal, or null to refuse with
 * 401. The server stamps the result onto the operation and rejects a body that carries its
 * own `actor`.
 */
export type Authenticate = (request: Request) => Promise<Principal | null>;

export type { CatalogOffer, CatalogPort } from '#src/ports.ts';

/** What the HTTP layer needs from the bag. A full Ports is assignable. */
export type ServerPorts = Pick<
  Ports,
  'config' | 'secrets' | 'clock' | 'meter' | 'logger' | 'rates'
>;

/** What {@link createServer} returns: a Fetch-native handler for any WinterCG runtime. */
export type FetchHandler = (request: Request) => Promise<Response>;

/**
 * Admission control for `/submit`. Each request counts against a caller key, and a denial
 * answers 429 with retry-after. The default key is the authenticated principal, else the
 * client address the Node bridge stamps. A throwing limiter fails open — degraded protection,
 * not degraded availability — and counts `economy.ratelimit.degraded`.
 *
 * **The default identifies the caller only where the peer address is the caller's.** Behind a
 * load balancer the peer is the balancer on every request, so one caller can exhaust the limit
 * for all of them; where nothing stamps an address the key is `ip:unknown` and does the same.
 * The lab will not read a forwarded address on the host's behalf — which header the deployment's
 * front sets and how many hops it trusts is knowledge the host has and the lab does not, and a
 * header any caller can write is not an identity. What it does instead is stop being quiet:
 * both cases count `economy.ratelimit.pooled`, tagged `forwarded` or `unstamped`.
 *
 * A host behind a proxy answers with `keyFor`, which replaces the key entirely — compose
 * {@link principalKey} for the authenticated half rather than re-deriving it.
 */
export type RateLimitConfig = {
  limiter: RateLimiter;
  keyFor?: (request: Request, principal?: Principal) => string;
};

/**
 * Everything {@link createServer} accepts. `economy`, `ports`, and the `authenticate` posture are
 * required. The rest are opt-in edge behavior: when absent, CORS stays off, admission control is
 * off, and the webhook and instance routes answer 404.
 */
export interface ServerOptions {
  economy: Economy;

  /**
   * The routes read only this narrow pick: config for webhook policy and the catalog bundles,
   * secrets for the webhook HMAC, clock for freshness, meter for the counters, rates for
   * `/v1/rates`.
   */
  ports: ServerPorts;

  /**
   * This is a required posture, not a default. A function authenticates `/submit`. An explicit
   * `false` declares the body's actor is trusted — safe only for in-process hosts, never for a
   * network-exposed handler. Omitting it entirely refuses to construct.
   */
  authenticate?: Authenticate | false;

  /**
   * Handler for verified provider callbacks on `POST /webhooks/:provider`. When absent, the
   * route answers 404.
   */
  webhook?: WebhookHandler;

  /**
   * `false` declares admission control off. Absent means off too (infra silence is allowed
   * here, unlike authentication).
   */
  rateLimit?: RateLimitConfig | false;

  /**
   * Dedup store for provider `eventId`s: a repeat delivery returns 200 without invoking the
   * handler. When absent, the host dedups.
   */
  replay?: ReplayStore;

  /**
   * Browser origins allowed by CORS, matched exactly. Absent means no CORS headers at all;
   * cross-origin browser calls fail closed.
   */
  cors?: { origins: ReadonlyArray<string> };

  /**
   * The instance-economy lane manager. When present, the server exposes
   * `POST /instances/:scope/purchase` — the transport an unprivileged game server calls to
   * request in-world purchases. The lane lives in this tier. When absent, the routes answer 404.
   */
  instances?: InstanceEconomies;

  /**
   * `false` unmounts the `/v1` read family; absent means mounted. The reads answer under
   * the same limiter as `/submit` and scope by principal: a user token reads only itself.
   */
  reads?: false;

  /**
   * Byte ceiling on request bodies. Past it the reply is 413. Defaults to
   * {@link DEFAULT_MAX_BODY_BYTES}, which every legitimate operation fits well under.
   */
  maxBodyBytes?: number;

  /**
   * Deadline on reading a request body. Past it the reply is 408 — a trickled body cannot
   * hold the handler open. Defaults to {@link DEFAULT_READ_TIMEOUT_MS}.
   */
  readTimeoutMs?: number;
}

/** Default byte ceiling on request bodies. The Node host bridge enforces the same limit. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** Default deadline on reading a request body. The Node host bridge enforces the same limit. */
export const DEFAULT_READ_TIMEOUT_MS = 10_000;

/**
 * Where the measured peer address rides.
 *
 * The lab reads it and never writes it: the host that owns the socket strips whatever arrived
 * and stamps the peer address, which `@pwngh/economy-core`'s Node bridge does for every mount.
 * A host that neither strips nor stamps is handing the rate limiter a caller-chosen bucket key.
 *
 * It carries the peer, not the caller — behind a proxy those differ, and this stays the peer.
 * That is the property `@pwngh/economy-auth`'s loopback-only dev tokens rest on, so nothing
 * derived from a forwarded header may ever be written here. A host that needs the caller's own
 * address reads it in {@link RateLimitConfig.keyFor}, where trusting a hop is its decision.
 */
export const CLIENT_IP_HEADER = 'x-economy-client-ip';

/**
 * Replaces whatever arrived in {@link CLIENT_IP_HEADER} with the address the host measured.
 *
 * Strip then stamp, in that order and unconditionally: a host that stamps without stripping
 * leaves an inbound spoof in place on any request it cannot measure a peer for, and that header
 * is what gates the loopback-only dev tokens and keys the rate limiter. Passing no peer strips
 * and stamps nothing, which is the honest answer for a transport with no address to report.
 *
 * The header is mutated in place, so a host calls this on the `Headers` it is about to hand to
 * `new Request`.
 */
export function sanitizeClientIp(
  headers: Headers,
  peer: string | undefined,
): void {
  headers.delete(CLIENT_IP_HEADER);
  if (peer) {
    headers.set(CLIENT_IP_HEADER, peer);
  }
}

/** Where the correlation id is accepted and echoed on `/submit`, the instance purchase, and the `/v1` reads. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Whether a caller-supplied token is one this server will accept and echo: word characters, dot,
 * colon and hyphen, 1 to 128 of them.
 *
 * Three things arrive spelled this way — the {@link REQUEST_ID_HEADER} value, an instance
 * purchase scope, and the idempotency key a host's own routes read off the same headers. They
 * are one grammar because they end up in the same places: a log line, a cache key, a URL. A host
 * that spells the check itself answers differently from the lab's routes on the same header,
 * which is a difference nobody sees until a caller's id is echoed by one route and refused by
 * the next.
 */
export function isCallerToken(value: string): boolean {
  return /^[\w.:-]{1,128}$/.test(value);
}

/** Where an inbound provider callback carries its HMAC, as lowercase hex. */
export const SIGNATURE_HEADER = 'x-signature';

/** The provider's send time in epoch milliseconds, used to reject stale deliveries. */
export const TIMESTAMP_HEADER = 'x-timestamp';

/**
 * The HTTP entry point for an {@link Economy}. Takes a Fetch `Request` and returns a `Response`. Uses only
 * Fetch globals (no Node APIs), so it runs on Node, Bun, Deno, and Cloudflare Workers.
 *
 * Routes these paths, 404s the rest:
 * - `POST /submit` reads one operation from the JSON body, runs it, returns the result.
 * - `POST /instances/:scope/purchase` (only with `instances` configured) hands an in-world
 *   purchase to the scope's fast-lane session — the transport an unprivileged game server calls.
 * - `POST /webhooks/:provider` verifies the callback, then hands it to the injected handler.
 * - `GET /v1/...` — the storefront read family (wallet, entitlements, subscriptions, payouts,
 *   rates, catalog, posting/{txnId}); `reads: false` unmounts it.
 * - `GET /healthz` reports liveness without touching storage.
 * - `GET /readyz` reports readiness via one cheap store-touching read through the economy.
 *
 * A thrown {@link EconomyError} becomes an RFC 9457 problem+json response: {@link statusForError} maps
 * the status, `title` carries the caller-safe message, and the stable `code` and `retryable` ride
 * as extensions. `detail`, `cause`, and stack never leave the server.
 *
 * `/submit` authenticates through `authenticate` when configured. Every body reads under a byte
 * ceiling and deadline. CORS stays off unless `cors` lists origins.
 *
 * The route accepts one submit at a time on purpose. `Economy.submitBatch` and the submit
 * coalescer are in-process surface for the host composing the economy, not a route — a shared
 * batch transaction cannot carry each request's own correlation id.
 *
 * @example
 * const handler = createServer({
 *   economy,
 *   ports,
 *   authenticate: async (request) => {
 *     const userId = await verifyToken(request.headers.get('authorization'));
 *     return userId === null ? null : userActor(userId); // null answers 401
 *   },
 *
 *   // Edge behavior, all optional: each one absent means that surface stays off.
 *   webhook: async (provider, request) => { // optional: absent 404s POST /webhooks/:provider
 *     const event = decodeWebhookEvent(provider, await request.json());
 *     await economy.submit(toOperation(event));
 *     return new Response(null, { status: 200 });
 *   },
 *   rateLimit: { // optional (or false): absent means admission control off
 *     limiter,
 *     // optional: only a host behind a proxy needs this, and only it knows how many hops
 *     // to trust. Left out, every caller behind the proxy shares one bucket.
 *     keyFor: (request, principal) =>
 *       principal === undefined
 *         ? `ip:${myTrustedClientAddress(request)}`
 *         : principalKey(principal),
 *   },
 *   replay: replayStore, // optional: dedups provider eventIds; absent means the host dedups
 *   cors: { origins: ['https://app.example.com'] }, // optional: absent sends no CORS headers
 *   instances: lanes, // optional: exposes POST /instances/:scope/purchase
 *
 *   // Body limits, optional: the defaults shown here.
 *   maxBodyBytes: 64 * 1024, // optional
 *   readTimeoutMs: 10_000, // optional
 * });
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   the routes, codec, and webhook gate.
 */
export function createServer(options: ServerOptions): FetchHandler {
  // Authentication is a posture, never a default: require the host to choose a verifier or to
  // state in code that the body's actor is trusted.
  if (options.authenticate === undefined) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      "createServer requires 'authenticate': pass a verifier, or false to trust the body's actor (in-process hosts only).",
      { retryable: false },
    );
  }
  // ServerPorts is a Pick a host fills in by hand, so nothing has held its config to the knob
  // bounds. Hold it here, because a bad knob does not fail loudly: a freshness window outside the
  // bound reads every inbound webhook as stale and answers 200 duplicate, so the provider stops
  // redelivering and a settlement rail goes quiet with nothing in the log.
  //
  // The field keeps the type `Config`. ServerPorts ships on `.` and `./server`, so branding it
  // would break the hand-built bag this refusal exists to catch.
  checkedConfig(options.ports.config);
  const economy = options.economy;
  return async (request) => {
    const origin = allowedOrigin(request, options);
    if (request.method === 'OPTIONS' && options.cors !== undefined) {
      return preflightResponse(request, origin);
    }
    const response = await route(economy, options, request);
    if (origin !== null) {
      response.headers.set('access-control-allow-origin', origin);
      response.headers.append('vary', 'origin');
    }
    return response;
  };
}

async function route(
  economy: Economy,
  options: ServerOptions,
  request: Request,
): Promise<Response> {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);

  if (
    request.method === 'GET' &&
    segments.length === 1 &&
    segments[0] === 'healthz'
  ) {
    return livenessRoute();
  }
  if (
    request.method === 'GET' &&
    segments.length === 1 &&
    segments[0] === 'readyz'
  ) {
    return readinessRoute(economy);
  }
  if (
    request.method === 'GET' &&
    segments[0] === 'v1' &&
    options.reads !== false
  ) {
    return readRoute(economy, options, segments.slice(1), request);
  }
  if (request.method === 'POST') {
    return postRoute(economy, options, segments, request);
  }
  return problemResponse(404, 'Not found.');
}

// --- /v1 reads --------------------------------------------------------------------

// Every read scopes by principal: a user token reads only itself, system and operator
// tokens name any user with ?userId=. A list answers a page plus the `cursor` that resumes
// it; the scope comes from the principal on every page, never from the cursor.
async function readRoute(
  economy: Economy,
  options: ServerOptions,
  rest: string[],
  request: Request,
): Promise<Response> {
  const correlationId = correlationOf(request);
  const response = await runRead(economy, options, rest, request);
  response.headers.set(REQUEST_ID_HEADER, correlationId);
  return response;
}

async function runRead(
  economy: Economy,
  options: ServerOptions,
  rest: string[],
  request: Request,
): Promise<Response> {
  let principal: Principal | undefined;
  if (options.authenticate !== undefined && options.authenticate !== false) {
    let verdict: Principal | null;
    try {
      verdict = await options.authenticate(request);
    } catch (error) {
      return faultResponse(error);
    }
    if (verdict === null) {
      return faultResponse(
        fault(ERROR_CODES.UNAUTHORIZED, 'Request is not authenticated.'),
      );
    }
    principal = verdict;
  }
  const denied = await admitSubmit(options, request, principal);
  if (denied !== null) {
    return denied;
  }
  try {
    const params = new URL(request.url).searchParams;
    return await dispatchRead(economy, options, { rest, params, principal });
  } catch (error) {
    return faultResponse(error);
  }
}

type ReadRequest = {
  rest: string[];
  params: URLSearchParams;
  principal: Principal | undefined;
};

async function dispatchRead(
  economy: Economy,
  options: ServerOptions,
  read: ReadRequest,
): Promise<Response> {
  const { rest, params, principal } = read;
  if (rest.length === 1 && rest[0] === 'rates') {
    const rates = options.ports.rates;
    return jsonResponse(
      200,
      encodeAmounts({
        buy: rates.buy('CREDIT'),
        par: rates.par('CREDIT'),
        payout: await rates.payout('CREDIT', 'USD', options.ports.clock.now()),
      }),
    );
  }
  if (rest.length === 1 && rest[0] === 'catalog') {
    const bundles = (options.ports.config.topUpBundlesMinor ?? []).map(
      (minor) => toAmount('CREDIT', minor),
    );
    return jsonResponse(200, encodeAmounts({ bundles, skus: [] }));
  }
  if (rest.length === 2 && rest[0] === 'posting') {
    return postingRead(economy, rest[1]!, principal);
  }
  if (rest.length !== 1) {
    return problemResponse(404, 'Not found.');
  }
  const who = readSubject(params, principal);
  if (who instanceof Response) {
    return who;
  }
  return userRead(economy, rest[0]!, who, {
    limit: readLimit(params),
    state: params.get('state'),
    cursor: params.get('cursor'),
  });
}

async function userRead(
  economy: Economy,
  kind: string,
  who: string,
  page: { limit: number; state: string | null; cursor: string | null },
): Promise<Response> {
  const { limit, state, cursor } = page;
  switch (kind) {
    case 'wallet':
      return jsonResponse(
        200,
        encodeAmounts(
          (await economy.read.wallet(who)) as unknown as Record<
            string,
            unknown
          >,
        ),
      );
    case 'entitlements': {
      const resume = readCursor(cursor, 'entitlements');
      if (resume instanceof Response) {
        return resume;
      }
      return pageOf(economy.read.entitlements(who), {
        list: 'entitlements',
        limit,
        resume,
      });
    }
    case 'subscriptions': {
      const filter = readState(state, SUBSCRIPTION_STATES);
      if (filter instanceof Response) {
        return filter;
      }
      const resume = readCursor(cursor, 'subscriptions');
      if (resume instanceof Response) {
        return resume;
      }
      return pageOf(
        economy.read.subscriptions(who),
        { list: 'subscriptions', limit, resume },
        (sub) => filter === null || sub.state === filter,
      );
    }
    case 'payouts': {
      const filter = readState(state, SAGA_STATES);
      if (filter instanceof Response) {
        return filter;
      }
      const resume = readCursor(cursor, 'payouts');
      if (resume instanceof Response) {
        return resume;
      }
      return pageOf(
        economy.read.payouts({
          userId: who,
          ...(filter === null ? {} : { states: [filter] }),
        }),
        { list: 'payouts', limit, resume },
      );
    }
    default:
      return problemResponse(404, 'Not found.');
  }
}

// With the in-process trust posture there is no principal, so the subject must ride ?userId=.
function readSubject(
  params: URLSearchParams,
  principal: Principal | undefined,
): string | Response {
  const asked = params.get('userId');
  if (principal?.kind === 'user') {
    if (asked !== null && asked !== principal.userId) {
      return faultResponse(
        fault(ERROR_CODES.UNAUTHORIZED, 'A user token reads only itself.'),
      );
    }
    return principal.userId;
  }
  return asked ?? problemResponse(400, 'userId is required.');
}

// A bad or missing limit collapses to the default page and an oversized ask caps at the
// ceiling: the server, not the caller, bounds what one request can pull.
function readLimit(params: URLSearchParams): number {
  const n = Number(params.get('limit'));
  if (!Number.isSafeInteger(n) || n < 1) {
    return 50;
  }
  return Math.min(n, 200);
}

// An unknown ?state= answers 400 rather than an empty page that reads as "none exist".
function readState<T extends string>(
  raw: string | null,
  states: readonly T[],
): T | null | Response {
  if (raw === null) {
    return null;
  }
  return (
    states.find((state) => state === raw) ??
    problemResponse(400, `state must be one of ${states.join(', ')}.`)
  );
}

// The order each list streams in, read off the field that identifies its rows. A sku-keyed list
// orders on the sku outright; an id-keyed one orders on `updatedAt` and breaks the tie on the id.
// Both are total orders, so a page boundary never skips or repeats a row.
type ListKind = WireListName;

/** A position in one list's own order, carried across pages inside the opaque cursor. */
type Resume = { k: ListKind; s?: string; t?: number; i?: string };

// The token is opaque, not signed. It names a position and never a subject, so the worst a
// forged one can do is start the caller's own page somewhere else.
function encodeCursor(list: ListKind, row: Record<string, unknown>): string {
  const resume: Resume =
    WIRE_LIST_KEY[list] === 'sku'
      ? { k: list, s: String(row.sku) }
      : { k: list, t: Number(row.updatedAt), i: String(row.id) };
  // base64url over UTF-8, so a sku outside ASCII survives the round trip and the token needs no
  // escaping in a query string.
  return toBase64Url(new TextEncoder().encode(JSON.stringify(resume)));
}

// A cursor that does not decode, or one minted by another list, answers 400. Ignoring it
// would silently restart the walk at the top and loop a caller forever.
function readCursor(
  raw: string | null,
  list: ListKind,
): Resume | null | Response {
  // An empty cursor is how a caller spells "none yet", so it reads as absent, not as junk.
  let resume: unknown;
  try {
    resume =
      raw === null || raw === ''
        ? null
        : JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  } catch {
    resume = undefined;
  }
  if (resume === null) {
    return null;
  }
  const held = resume as Resume;
  const shaped =
    typeof held === 'object' &&
    held !== null &&
    held.k === list &&
    (WIRE_LIST_KEY[list] === 'sku'
      ? typeof held.s === 'string'
      : Number.isFinite(held.t) && typeof held.i === 'string');
  return shaped
    ? held
    : problemResponse(400, 'cursor is not a resume token for this list.');
}

// True once the row sorts strictly past the resume point, in that list's own order.
function afterResume(
  list: ListKind,
  row: Record<string, unknown>,
  resume: Resume | null,
): boolean {
  if (resume === null) {
    return true;
  }
  if (WIRE_LIST_KEY[list] === 'sku') {
    return String(row.sku) > resume.s!;
  }
  const at = Number(row.updatedAt);
  return at < resume.t! || (at === resume.t! && String(row.id) < resume.i!);
}

// Collects one page, then looks one row further. That extra row is what makes the returned
// cursor non-null, so a page that lands exactly on the last row still ends the walk.
async function pageOf<T>(
  iterable: AsyncIterable<T>,
  page: { list: ListKind; limit: number; resume: Resume | null },
  keep: (item: T) => boolean = () => true,
): Promise<Response> {
  const items: unknown[] = [];
  let last: Record<string, unknown> | undefined;
  let cursor: string | null = null;
  for await (const item of iterable) {
    const row = item as Record<string, unknown>;
    if (!keep(item) || !afterResume(page.list, row, page.resume)) {
      continue;
    }
    if (items.length >= page.limit) {
      cursor = encodeCursor(page.list, last!);
      break;
    }
    items.push(encodeAmounts(row));
    last = row;
  }
  return jsonResponse(200, { items, cursor });
}

async function postingRead(
  economy: Economy,
  txnId: string,
  principal: Principal | undefined,
): Promise<Response> {
  const posting = await economy.read.posting(txnId);
  const touched = (userId: string) =>
    posting?.legs.some(
      (leg) => isWalletAccount(leg.account) && ownerOf(leg.account) === userId,
    ) ?? false;
  if (
    posting === null ||
    (principal?.kind === 'user' && !touched(principal.userId))
  ) {
    // A foreign transaction reads as absent — own-if-touched never leaks existence.
    return problemResponse(404, 'Not found.');
  }
  return jsonResponse(
    200,
    encodeAmounts(posting as unknown as Record<string, unknown>),
  );
}

function postRoute(
  economy: Economy,
  options: ServerOptions,
  segments: string[],
  request: Request,
): Promise<Response> {
  if (segments.length === 1 && segments[0] === 'submit') {
    return submitRoute(economy, options, request);
  }
  if (segments.length === 2 && segments[0] === 'webhooks') {
    return webhookRoute(options, segments[1]!, request);
  }
  if (
    segments.length === 3 &&
    segments[0] === 'instances' &&
    segments[2] === 'purchase' &&
    options.instances !== undefined
  ) {
    return instancePurchaseRoute(options, segments[1]!, request);
  }
  return Promise.resolve(problemResponse(404, 'Not found.'));
}

// --- /instances/:scope/purchase -----------------------------------------------------

// The game-server edge to the fast lane. Authorization matches /submit: a `user` principal may
// only spend its own wallet. Acting for an arbitrary buyer takes a system or operator
// principal, or the explicit `authenticate: false` in-process trust posture.
async function instancePurchaseRoute(
  options: ServerOptions,
  scopeRaw: string,
  request: Request,
): Promise<Response> {
  const correlationId = correlationOf(request);
  const response = await runInstancePurchase(options, scopeRaw, request);
  response.headers.set(REQUEST_ID_HEADER, correlationId);
  return response;
}

async function runInstancePurchase(
  options: ServerOptions,
  scopeRaw: string,
  request: Request,
): Promise<Response> {
  const scope = decodeURIComponent(scopeRaw);
  if (!isCallerToken(scope)) {
    return problemResponse(400, 'Malformed scope.');
  }
  let principal: Principal | undefined;
  if (options.authenticate !== undefined && options.authenticate !== false) {
    let verdict: Principal | null;
    try {
      verdict = await options.authenticate(request);
    } catch (error) {
      return faultResponse(error);
    }
    if (verdict === null) {
      return faultResponse(
        fault(ERROR_CODES.UNAUTHORIZED, 'Request is not authenticated.'),
      );
    }
    principal = verdict;
  }
  const denied = await admitSubmit(options, request, principal);
  if (denied !== null) {
    return denied;
  }

  const body = await readRouteBody(request, options);
  if ('refusal' in body) {
    return body.refusal;
  }
  const bytes = body.bytes;
  try {
    const purchase = decodeInstancePurchase(parseJson(bytes), principal);
    const outcome = await options.instances!.laneFor(scope).purchase(purchase);
    return jsonResponse(200, outcome as unknown as Record<string, unknown>);
  } catch (error) {
    return faultResponse(error);
  }
}

// The wire shape of one purchase request. The price rides as an encoded amount string like every
// other money field on this API. Faults on shape belong to decode. Business "no"s come back as
// 200 rejected outcomes, exactly like /submit.
function decodeInstancePurchase(
  body: unknown,
  principal: Principal | undefined,
): InstancePurchase {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (typeof raw.buyerId !== 'string' || raw.buyerId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'purchase.buyerId must be a non-empty string.',
    );
  }
  if (
    principal !== undefined &&
    principal.kind === 'user' &&
    principal.userId !== raw.buyerId
  ) {
    throw fault(
      ERROR_CODES.UNAUTHORIZED,
      'A user may only purchase with their own wallet.',
    );
  }
  const product = (raw.product ?? {}) as Record<string, unknown>;
  const recipients = Array.isArray(raw.recipients) ? raw.recipients : [];
  return {
    buyerId: raw.buyerId,
    price: decodeWire.amount(raw.price),
    recipients: recipients.map((entry) => {
      const recipient = (entry ?? {}) as Record<string, unknown>;
      // This check lives here because the lane's own share check does not re-test seller ids.
      // An empty id would mint an earned account with an empty owner.
      if (
        typeof recipient.sellerId !== 'string' ||
        recipient.sellerId.trim() === ''
      ) {
        throw fault(
          ERROR_CODES.MALFORMED_OPERATION,
          'purchase.recipients[].sellerId must be a non-empty string.',
        );
      }
      return {
        sellerId: recipient.sellerId,
        shareBps: Number(recipient.shareBps ?? 0),
      };
    }),
    product: {
      sku: String(product.sku ?? ''),
      kind: product.kind as InstancePurchase['product']['kind'],
      ...(product.expiresAt === undefined
        ? {}
        : { expiresAt: Number(product.expiresAt) }),
    },
    ...(raw.orderId === undefined ? {} : { orderId: String(raw.orderId) }),
  };
}

// --- CORS -------------------------------------------------------------------------

// Matches the origin exactly against the allowlist. Null (CORS off, no Origin header, or an unlisted origin)
// means no CORS headers are set, which is the deny.
function allowedOrigin(
  request: Request,
  options: ServerOptions,
): string | null {
  const origin = request.headers.get('origin');
  if (origin === null || options.cors === undefined) {
    return null;
  }
  return options.cors.origins.includes(origin) ? origin : null;
}

// A denied preflight is a bare 204: the browser blocks the caller because the grant headers are
// absent, and the response leaks nothing about the allowlist.
function preflightResponse(request: Request, origin: string | null): Response {
  if (origin === null) {
    return new Response(null, { status: 204 });
  }
  const headers = new Headers({
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  });
  const requested = request.headers.get('access-control-request-headers');
  if (requested !== null) {
    headers.set('access-control-allow-headers', requested);
  }
  return new Response(null, { status: 204, headers });
}

// --- /healthz and /readyz ---------------------------------------------------------

// The route does no I/O, so it answers even when a dependency is down (/readyz covers that case). The Dockerfile
// HEALTHCHECK targets this path.
function livenessRoute(): Response {
  return jsonResponse(200, { status: 'ok' });
}

// The probe is one cheap store-touching read. Any throw reports 503 with no detail, so the error
// stays server-side. It goes through the public read surface because createServer only
// receives an Economy.
async function readinessRoute(economy: Economy): Promise<Response> {
  try {
    await economy.read.balance(SYSTEM.REVENUE);
    return jsonResponse(200, { status: 'ready' });
  } catch {
    return jsonResponse(503, { status: 'unavailable' });
  }
}

// --- /submit ----------------------------------------------------------------------

// Every reply on the submit path echoes the correlation id, problem responses included. A caller
// can quote one id, and an operator can follow it through submit, outbox, and relay logs.
async function submitRoute(
  economy: Economy,
  options: ServerOptions,
  request: Request,
): Promise<Response> {
  const correlationId = correlationOf(request);
  const response = await runSubmit(economy, options, request, correlationId);
  response.headers.set(REQUEST_ID_HEADER, correlationId);
  return response;
}

/**
 * The id this request is correlated by, across this system and the caller's.
 *
 * The trace id of a W3C traceparent header wins, so a caller already running distributed
 * tracing gets one id across both systems. An explicit {@link REQUEST_ID_HEADER} is next.
 * Otherwise one is minted. An all-zero trace id is the W3C invalid value and is skipped.
 *
 * @see {@link https://www.w3.org/TR/trace-context/#traceparent-header W3C Trace Context}
 */
export function correlationOf(request: Request): string {
  const traceparent = request.headers.get('traceparent');
  const traceId = traceparent?.match(
    /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/,
  )?.[1];
  if (traceId !== undefined && traceId !== '0'.repeat(32)) {
    return traceId;
  }
  const supplied = request.headers.get(REQUEST_ID_HEADER);
  if (supplied !== null && isCallerToken(supplied)) {
    return supplied;
  }
  return `req_${crypto.randomUUID()}`;
}

// A `rejected` outcome is not an error: the economy declined a valid request for a business
// reason. The response is a 200 holding the decline. Authentication runs before the body is
// read, so an unauthenticated caller costs no buffering.
async function runSubmit(
  economy: Economy,
  options: ServerOptions,
  request: Request,
  correlationId: string,
): Promise<Response> {
  let principal: Principal | undefined;
  if (options.authenticate !== undefined && options.authenticate !== false) {
    let verdict: Principal | null;
    try {
      verdict = await options.authenticate(request);
    } catch (error) {
      return faultResponse(error);
    }
    if (verdict === null) {
      return faultResponse(
        fault(ERROR_CODES.UNAUTHORIZED, 'Request is not authenticated.'),
      );
    }
    principal = verdict;
  }

  const denied = await admitSubmit(options, request, principal);
  if (denied !== null) {
    return denied;
  }

  const body = await readRouteBody(request, options);
  if ('refusal' in body) {
    return body.refusal;
  }
  const bytes = body.bytes;
  try {
    const operation = decodeOperation(parseJson(bytes), principal);
    return jsonResponse(
      200,
      encodeOutcome(await economy.submit(operation, { correlationId })),
    );
  } catch (error) {
    return faultResponse(error);
  }
}

// Fail open on a throwing limiter: a down limiter backend should degrade protection, not
// availability. The degraded counter is what makes that trade visible.
async function admitSubmit(
  options: ServerOptions,
  request: Request,
  principal: Principal | undefined,
): Promise<Response | null> {
  const limit = options.rateLimit;
  if (limit === undefined || limit === false) {
    return null;
  }
  let key = limit.keyFor?.(request, principal);
  if (key === undefined) {
    key = limiterKey(request, principal);
    // A host that supplied keyFor has taken this decision and the lab has nothing to say.
    // Left to the default, admission control silently degrades to one bucket for everyone
    // behind the proxy, which reads as working. Counting is the whole remedy available here:
    // the lab cannot trust a forwarded header on the host's behalf, and cannot refuse on one
    // either, because any caller can send it and a refusal would then be theirs to trigger.
    const reason = pooledReason(request, principal);
    if (reason !== undefined) {
      options.ports.meter.count('economy.ratelimit.pooled', 1, { reason });
    }
  }
  let verdict: RateVerdict;
  try {
    verdict = await limit.limiter.allow(key);
  } catch {
    options.ports.meter.count('economy.ratelimit.degraded', 1);
    return null;
  }
  if (verdict.allowed) {
    return null;
  }
  const response = problemResponse(429, 'Too many requests.');
  if (verdict.retryAfterMs !== undefined) {
    response.headers.set(
      'retry-after',
      String(Math.ceil(verdict.retryAfterMs / 1000)),
    );
  }
  return response;
}

/**
 * The rate-limit key for an authenticated caller: the identity, not the kind.
 *
 * Exported because {@link RateLimitConfig.keyFor} replaces the whole key rather than only the
 * unauthenticated half, so a host keying on an address its own deployment knows how to read
 * would otherwise have to re-derive this. Keying on `principal.kind` instead puts every user
 * in one bucket.
 */
export function principalKey(principal: Principal): string {
  switch (principal.kind) {
    case 'user':
      return `user:${principal.userId}`;
    case 'system':
      return `system:${principal.service}`;
    case 'operator':
      return `operator:${principal.operatorId}`;
  }
}

// Headers a hop writes when it rewrites the peer address: the two standards, then nginx's
// and the two CDN spellings a host actually meets. Read as evidence that the deployment is
// proxied, never keyed on — which of them the deployment's own front sets, and how many hops
// are trusted, is knowledge only the host has.
const FORWARDED_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
] as const;

// Why the key the lab derived cannot identify the caller, if it cannot. 'forwarded' means a
// hop rewrote the peer, so the address stamped is the proxy and every caller behind it shares
// one bucket. 'unstamped' means nothing measured a peer at all, so they all share `ip:unknown`.
// Both answer undefined once the caller is authenticated, because the identity keys them apart.
function pooledReason(
  request: Request,
  principal: Principal | undefined,
): 'forwarded' | 'unstamped' | undefined {
  if (principal !== undefined) {
    return undefined;
  }
  if (request.headers.get(CLIENT_IP_HEADER) === null) {
    return 'unstamped';
  }
  return FORWARDED_HEADERS.some((h) => request.headers.get(h) !== null)
    ? 'forwarded'
    : undefined;
}

// The authenticated principal is the fairest key. Without one, the bridge-stamped client
// address stands in. 'unknown' pools every caller a runtime leaves unstamped, so such hosts
// should supply keyFor.
function limiterKey(
  request: Request,
  principal: Principal | undefined,
): string {
  if (principal !== undefined) {
    return principalKey(principal);
  }
  return `ip:${request.headers.get(CLIENT_IP_HEADER) ?? 'unknown'}`;
}

// --- /webhooks/:provider ----------------------------------------------------------

// The body is verified before the handler runs, so a forged request never reaches code that
// changes balances. The checks run in this order: signature, then freshness, then claiming the
// provider `eventId` last. That order keeps a rejected delivery from burning an id and blocking
// a later genuine redelivery. The order is required. Keep it as written.
// See https://economy-lab-docs.pages.dev/economy/reference/http-service/ for the gate.
//
// The raw bytes are read once. Verification, replay decode, and handler all work over that
// buffer, and the handler gets a fresh Request rebuilt from the bytes.
async function webhookRoute(
  options: ServerOptions,
  provider: string,
  request: Request,
): Promise<Response> {
  const handler = options.webhook;
  if (handler === undefined) {
    return problemResponse(404, 'No webhook handler configured.');
  }

  const body = await readRouteBody(request, options);
  if ('refusal' in body) {
    return body.refusal;
  }
  const rawBytes = body.bytes;

  const secret = options.ports.secrets.webhookSecret;
  if (secret === '') {
    // No secret is configured, so keep the bare pass-through (the host owns verification).
    return runHandler(handler, provider, rebuildRequest(request, rawBytes));
  }

  try {
    if (!(await verifyHmac(rawBytes, signatureOf(request), secret))) {
      throw fault(
        ERROR_CODES.INVALID_SIGNATURE,
        'Webhook signature is invalid.',
      );
    }
  } catch (error) {
    return faultResponse(error);
  }

  const now = options.ports.clock.now();
  // `Number(null)` is 0, finite, and would slip past the check below. Map a missing header to NaN so
  // a missing timestamp is rejected rather than read as the epoch.
  const header = request.headers.get(TIMESTAMP_HEADER);
  const timestamp = header === null ? Number.NaN : Number(header);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > options.ports.config.freshnessWindowMs
  ) {
    // The delivery is stale. The signature does not cover this header, so the window bounds skew
    // and nothing else; replayGate below is what refuses a second arrival of the same event.
    // Answer 200 duplicate (no mutation) so the provider stops redelivering, rather than a 5xx
    // that triggers repeated retries.
    options.ports.meter.count('economy.webhook.duplicate', 1, {
      provider,
      layer: 'stale',
    });
    return jsonResponse(200, { status: 'duplicate' });
  }

  const dedup = await replayGate(options, provider, rawBytes);
  if (dedup !== null) {
    return dedup;
  }

  return runHandler(handler, provider, rebuildRequest(request, rawBytes));
}

async function runHandler(
  handler: WebhookHandler,
  provider: string,
  request: Request,
): Promise<Response> {
  try {
    return await handler(provider, request);
  } catch (error) {
    return faultResponse(error);
  }
}

// A no-op when no replay store is wired. Decodes the body only to read its `eventId`. The handler
// still gets the raw verified bytes. Returns a Response to send immediately, or null when the
// event is new and the caller runs.
async function replayGate(
  options: ServerOptions,
  provider: string,
  rawBytes: Uint8Array,
): Promise<Response | null> {
  if (options.replay === undefined) {
    return null;
  }
  let claimed: boolean;
  try {
    const text = new TextDecoder().decode(rawBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // A non-JSON body that passed HMAC is a malformed callback, not a server fault, so answer 400.
      throw malformed('Webhook body is not valid JSON.', error);
    }
    const event = decodeWebhookEvent(provider, parsed);
    claimed = (await options.replay.claim(event.eventId)).claimed;
  } catch (error) {
    return faultResponse(error);
  }
  if (!claimed) {
    // The eventId was already seen. Answer 200 and run nothing, so the credit posts once.
    options.ports.meter.count('economy.webhook.duplicate', 1, {
      provider,
      layer: 'replay',
    });
    return jsonResponse(200, { status: 'duplicate' });
  }
  return null;
}

/**
 * Whether a hex HMAC-SHA-256 signature is this secret's signature over these bytes.
 *
 * `crypto.subtle.verify` compares in constant time and returns a clean false (never throws) on a
 * wrong length or value. A non-hex signature fails fromHex and is also treated as a non-match.
 * One secret per call: a host rotating keys checks the list itself, and every candidate costs the
 * same comparison whether it matches or not.
 */
export async function verifyHmac(
  rawBytes: Uint8Array,
  signature: string,
  secret: string,
): Promise<boolean> {
  let provided: Uint8Array;
  try {
    provided = fromHex(signature);
  } catch {
    return false;
  }
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, provided, rawBytes);
}

/**
 * Signs bytes the way a provider signs a delivery: HMAC-SHA-256, lowercase hex.
 *
 * The outbound half of {@link verifyHmac}, and it exists so a host driving its own endpoint — in
 * a test, or replaying a delivery against a rotated secret — never re-derives the scheme. The two
 * share the key derivation below, so a change to how a secret becomes a key cannot land on one
 * side and leave the other producing signatures that no longer verify.
 *
 * This is the outbound direction. A provider signs its own deliveries; do not sign real outbound
 * traffic with a secret held for verifying inbound.
 */
export async function signHmac(
  rawBytes: Uint8Array,
  secret: string,
): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBytes)));
}

const hmacKey = (
  secret: string,
  usage: 'sign' | 'verify',
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );

// An absent header becomes '', a guaranteed mismatch, so it needs no special-casing.
function signatureOf(request: Request): string {
  return request.headers.get(SIGNATURE_HEADER) ?? '';
}

function rebuildRequest(request: Request, rawBytes: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBytes,
  });
}

// --- Operation codec (money travels as a decimal string) --------------------------

// Money amounts arrive as decimal strings because a JSON number can't safely hold them. An
// authenticated principal replaces the actor outright. A body that names its own actor is
// refused rather than silently overridden, so a caller can never believe a claimed actor was
// honored.
function decodeOperation(body: unknown, principal?: Principal): Operation {
  if (body === null || typeof body !== 'object') {
    throw malformed('Operation body must be a JSON object.');
  }
  const row = body as Record<string, unknown>;
  if (principal !== undefined && 'actor' in row) {
    throw malformed("Operation must not carry 'actor'; the server stamps it.");
  }
  const kind = row.kind;
  if (typeof kind !== 'string' || !(kind in FIELDS)) {
    throw malformed(`Unknown operation kind: ${String(kind)}.`);
  }
  const spec = FIELDS[kind as Operation['kind']] as Record<string, Spec>;

  refuseStrayFields(row, spec, kind);
  if (typeof row.idempotencyKey !== 'string' || row.idempotencyKey === '') {
    throw malformed(
      "Operation field 'idempotencyKey' must be a non-empty string.",
    );
  }
  if (principal === undefined) {
    decodePrincipal(row.actor);
  }

  const decoded: Record<string, unknown> = { ...row };
  if (principal !== undefined) {
    decoded.actor = principal;
  }
  decodeFields(row, spec, decoded);
  return decoded as unknown as Operation;
}

function refuseStrayFields(
  row: Record<string, unknown>,
  spec: Record<string, Spec>,
  kind: string,
): void {
  for (const field of Object.keys(row)) {
    if (field === 'kind' || field === 'idempotencyKey' || field === 'actor')
      continue;
    if (!(field in spec)) {
      throw malformed(`Operation field '${field}' is not part of ${kind}.`);
    }
  }
}

function decodeFields(
  row: Record<string, unknown>,
  spec: Record<string, Spec>,
  decoded: Record<string, unknown>,
): void {
  for (const [field, tag] of Object.entries(spec)) {
    const optional = tag.endsWith('?');
    const value = row[field];
    if (optional && value === undefined) continue;
    decoded[field] = decodeField(
      value,
      field,
      (optional ? tag.slice(0, -1) : tag) as BaseSpec,
    );
  }
}

// The wire shape of one field, checked at the boundary so a wrong-shaped body answers a uniform
// 400 instead of faulting deeper. A trailing `?` marks the field optional. An absent optional
// field stays absent. Semantics (positive amounts, shares summing to 10,000, saga states) stay with the
// operation handlers.
// The wire contract owns the field table and the predicates; this door converts and words the 400.
function decodeField(value: unknown, field: string, tag: BaseSpec): unknown {
  return DECODERS[tag](value, field);
}

const DECODERS: {
  [T in BaseSpec]: (value: unknown, field: string) => unknown;
} = {
  string: (value, field) =>
    shaped('string', value, field, 'a non-empty string'),
  int: (value, field) => shaped('int', value, field, 'an integer'),
  boolean: (value, field) => shaped('boolean', value, field, 'a boolean'),
  // A non-string throws a malformed fault (wrong shape). A bad string throws a money fault
  // (wrong amount). Keeping the two distinct lets the caller tell a shape error from an amount error.
  // This is the one row the shared table cannot answer: an amount arrives as text and leaves branded.
  amount: (value, field) => {
    if (typeof value !== 'string') {
      throw malformed(
        `Operation field '${field}' must be an encoded amount string.`,
      );
    }
    return decodeWire.amount(value);
  },
  recipients: (value, field) => {
    if (!Array.isArray(value)) {
      throw malformed(
        `Operation field '${field}' must be an array of recipients.`,
      );
    }
    if (!hasWireShape('recipients', value)) {
      throw malformed(
        `Operation field '${field}' entries must be { sellerId: string, shareBps: integer }.`,
      );
    }
    return value;
  },
  object: (value, field) => shaped('object', value, field, 'an object'),
};

function shaped(
  tag: BaseSpec,
  value: unknown,
  field: string,
  wanted: string,
): unknown {
  if (!hasWireShape(tag, value)) {
    throw malformed(`Operation field '${field}' must be ${wanted}.`);
  }
  return value;
}

function decodePrincipal(value: unknown): void {
  const actor = value as Record<string, unknown> | null;
  const ok =
    actor !== null &&
    typeof actor === 'object' &&
    ((actor.kind === 'user' &&
      typeof actor.userId === 'string' &&
      actor.userId !== '') ||
      (actor.kind === 'system' &&
        typeof actor.service === 'string' &&
        actor.service !== '') ||
      (actor.kind === 'operator' &&
        typeof actor.operatorId === 'string' &&
        actor.operatorId !== ''));
  if (!ok) {
    throw malformed(
      "Operation field 'actor' must be a user, system, or operator principal.",
    );
  }
}

/**
 * The wire shape of an Outcome. A rejected outcome carries both the typed `detail` (branded
 * Amounts and bigints become decimal strings) and a top-level `reason` derived from
 * `detail.reason`. HTTP clients live outside the type system, so the wire keeps the harmless
 * duplicate for stability even though `detail.reason` is the sole discriminant in TypeScript.
 */
export function encodeOutcome(outcome: Outcome): unknown {
  if (outcome.status === 'rejected') {
    return {
      status: outcome.status,
      reason: outcome.detail.reason,
      detail: encodeAmounts(outcome.detail),
    };
  }
  return {
    status: outcome.status,
    transaction: encodeWire.transaction(outcome.transaction),
  };
}

// --- Local helpers ----------------------------------------------------------------

/**
 * Turns any thrown value into the Problem response the lab's own routes answer with.
 *
 * An unknown error goes out as a generic retryable 503; its stack trace and cause never reach
 * the client. `statusForError` owns the code-to-status mapping, and `wireDetail` owns the short
 * per-code allowlist of `detail` fields that may ride along — a `SESSION.MISROUTED` answers 421
 * with the `owner` to try, and every other code publishes nothing from `detail`. A host mounting
 * its own routes beside the lab's calls this so both halves fail the same way — a hand-rolled
 * second version is how one API grows two error shapes.
 */
export function faultResponse(error: unknown): Response {
  const normalized = normalizeError(error);
  return problemResponse(
    statusForError(normalized),
    normalized.message,
    { code: normalized.code, retryable: normalized.retryable },
    wireDetail(normalized),
  );
}

/** What {@link readBounded} answers: the bytes, or which of the two bounds stopped the read. */
export type BoundedBody =
  | { status: 'read'; bytes: Uint8Array }
  | { status: 'oversize' }
  | { status: 'timeout' };

/** The two bounds {@link readBounded} enforces. Each defaults to the lab's own constant. */
export type BodyBounds = { maxBytes?: number; timeoutMs?: number };

/**
 * Reads a whole request body under a byte ceiling and a read deadline.
 *
 * A declared `content-length` past the ceiling is refused before a byte is read; a lying or
 * absent one is caught by counting as chunks arrive. Either bound cancels the stream, so a
 * refused read holds no socket.
 *
 * It answers a verdict rather than throwing because the callers refuse differently — the lab's
 * routes answer 413 and 408, and a webhook gate that must bound its read *before* it
 * authenticates answers its own refusal shape. Bounding before authenticating is why this is
 * exported at all: a package that cannot reach it writes the loop a second time, and two copies
 * of a limit drift into two different limits.
 */
export async function readBounded(
  request: Request,
  bounds: BodyBounds = {},
): Promise<BoundedBody> {
  const maxBytes = bounds.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (Number(request.headers.get('content-length') ?? '0') > maxBytes) {
    return { status: 'oversize' };
  }
  const body = request.body;
  if (body === null) {
    return { status: 'read', bytes: new Uint8Array(0) };
  }
  const reader = body.getReader();
  // A cancel on an already-errored stream rejects; nothing here can act on that, and an
  // unhandled rejection would outlive the verdict.
  const drop = () => void reader.cancel().catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Cancelling resolves the pending read as done, so the loop observes the deadline promptly
  // without racing promises. The deadline is AbortSignal.timeout, not a raw timer. It
  // self-cleans and is a web standard present on every target runtime.
  const deadline = AbortSignal.timeout(
    bounds.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
  );
  deadline.addEventListener('abort', drop);
  for (;;) {
    const { done, value } = await reader.read();
    if (deadline.aborted) {
      return { status: 'timeout' };
    }
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      drop();
      return { status: 'oversize' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: 'read', bytes };
}

// The lab's own routes read under the handler's configured bounds and map the two refusals to
// the statuses RFC 9457 problem responses carry.
async function readRouteBody(
  request: Request,
  options: ServerOptions,
): Promise<{ bytes: Uint8Array } | { refusal: Response }> {
  const body = await readBounded(request, {
    maxBytes: options.maxBodyBytes,
    timeoutMs: options.readTimeoutMs,
  });
  switch (body.status) {
    case 'read':
      return { bytes: body.bytes };
    case 'oversize':
      return { refusal: problemResponse(413, 'Request body is too large.') };
    case 'timeout':
      return {
        refusal: problemResponse(408, 'Request body read timed out.'),
      };
  }
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) {
    throw malformed('Request body is empty.');
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw malformed('Request body is not valid JSON.', error);
  }
}

function malformed(message: string, cause?: unknown): EconomyError {
  return new EconomyError(ERROR_CODES.MALFORMED_OPERATION, message, { cause });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Builds an RFC 9457 problem+json response. `title` is the caller-safe message. When a fault is
 * given, its stable `code` and `retryable` flag ride as extensions, and `extensions` adds further
 * members the caller is meant to act on — what a fault may put there is decided per code by
 * `wireDetail`, never here. `cause` and stack stay server-side and never reach the wire. See
 * https://www.rfc-editor.org/rfc/rfc9457 for the format.
 */
export function problemResponse(
  status: number,
  title: string,
  fault?: { code: ErrorCode; retryable: boolean },
  extensions?: Readonly<Record<string, string | number | boolean>>,
): Response {
  const body = {
    // Extensions are laid down first so the members this function states cannot be overwritten by
    // one — including RFC 9457's own `title` and `status`.
    ...extensions,
    type: fault
      ? 'https://economy-lab-docs.pages.dev/economy/reference/outcomes-and-reason-codes/'
      : 'about:blank',
    title,
    status,
    ...fault,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

// The webhook intake surface rides the /server facet with the HTTP service that fronts it.
export {
  decodeWebhookEvent,
  handlePurchaseWebhook,
  handleWebhook,
  toOperation,
} from '#src/webhooks.ts';
export type {
  DisputeEvent,
  PayoutFailedEvent,
  PayoutSettledEvent,
  PurchaseEvent,
  WebhookEvent,
  WebhookReceipt,
} from '#src/webhooks.ts';
