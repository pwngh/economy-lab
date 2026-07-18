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

import { decodeWire, encodeWire } from '#src/adapters/http-wire.ts';
import {
  ERROR_CODES,
  EconomyError,
  fault,
  normalizeError,
  statusForError,
} from '#src/errors.ts';

import type { ErrorCode } from '#src/errors.ts';
import { SYSTEM } from '#src/accounts.ts';
import { fromHex } from '#src/bytes.ts';
import { decodeWebhookEvent } from '#src/webhooks.ts';

import { encodeAmounts } from '#src/money.ts';
import type { Amount } from '#src/money.ts';
import type {
  Clock,
  Meter,
  RateLimiter,
  RateVerdict,
  ReplayStore,
} from '#src/ports.ts';
import type { Config } from '#src/config.ts';
import type { Economy, Operation, Outcome, Principal } from '#src/contract.ts';

/**
 * Host handler for inbound provider callbacks (webhooks), e.g. a payment processor reporting a
 * settlement or dispute. Takes the URL's provider name and the request, returns the HTTP response.
 *
 * The server verifies signature and freshness before the handler runs, so the bytes are trusted.
 * `request` is a fresh `Request` over the same raw body, re-readable without double-consuming.
 */
export type WebhookHandler = (
  provider: string,
  request: Request,
) => Promise<Response>;

export interface ServerOptions {
  webhook?: WebhookHandler;

  // When present, the server verifies inbound webhooks (signature and freshness) before the
  // handler runs. When absent, the webhook path is a bare pass-through and the host verifies.
  config?: Config;

  // Clock for webhook freshness. Time is read only through this, never `Date.now()`, so tests can
  // freeze it. Defaults to wall-clock when verification is enabled and no clock is given.
  clock?: Clock;

  // Dedup store for provider `eventId`s: a repeat delivery returns 200 without invoking the
  // handler. When absent, the host dedups. The claim-last ordering lives at webhookRoute.
  replay?: ReplayStore;

  // Failure sink for the rate limiter: a throwing limiter fails open and counts
  // `economy.ratelimit.degraded` here.
  meter?: Meter;

  // Authentication for `/submit`: maps the request to the acting principal, or null to refuse
  // with 401. When set, the server stamps the result onto the operation and rejects a body that
  // carries its own `actor`. When absent, the body's actor is trusted — safe only for in-process
  // hosts, never for a network-exposed handler.
  authenticate?: (request: Request) => Promise<Principal | null>;

  // Byte ceiling on request bodies; past it the reply is 413. Defaults to
  // DEFAULT_MAX_BODY_BYTES, which every legitimate operation fits well under.
  maxBodyBytes?: number;

  // Deadline on reading a request body; past it the reply is 408, so a trickled body cannot
  // hold the handler open. Defaults to DEFAULT_READ_TIMEOUT_MS.
  readTimeoutMs?: number;

  // Browser origins allowed by CORS, matched exactly. Absent means no CORS headers at all, so
  // cross-origin browser calls fail closed.
  cors?: { origins: ReadonlyArray<string> };

  // Admission control for `/submit`: each request counts against a caller key and a denial
  // answers 429 with retry-after. The default key is the authenticated principal, else the
  // client address the Node bridge stamps; hosts on other runtimes supply keyFor.
  rateLimit?: {
    limiter: RateLimiter;
    keyFor?: (request: Request, principal?: Principal) => string;
  };
}

/** Default byte ceiling on request bodies. The Node host bridge enforces the same limit. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** Default deadline on reading a request body. The Node host bridge enforces the same limit. */
export const DEFAULT_READ_TIMEOUT_MS = 10_000;

/**
 * Where the trusted client address rides. The Node bridge stamps this from the socket,
 * overwriting anything inbound, so a caller can't spoof it.
 */
export const CLIENT_IP_HEADER = 'x-economy-client-ip';

/** Where the correlation id is accepted and echoed on `/submit`. */
export const REQUEST_ID_HEADER = 'x-request-id';

const SIGNATURE_HEADER = 'x-signature';

// The provider's send time in epoch milliseconds, used to reject stale deliveries.
const TIMESTAMP_HEADER = 'x-timestamp';

/**
 * HTTP entry point for an {@link Economy}: takes a Fetch `Request`, returns a `Response`. Uses only
 * Fetch globals (no Node APIs), so it runs on Node, Bun, Deno, and Cloudflare Workers.
 *
 * Routes these paths, 404s the rest:
 * - `POST /submit` reads one operation from the JSON body, runs it, returns the result.
 * - `POST /webhooks/:provider` verifies the callback, then hands it to the injected handler.
 * - `GET /healthz` reports liveness without touching storage.
 * - `GET /readyz` reports readiness via one cheap store-touching read through the economy.
 *
 * A thrown {@link EconomyError} becomes an RFC 9457 problem+json response: {@link statusForError} maps
 * the status, `title` carries the caller-safe message, and the stable `code` and `retryable` ride
 * as extensions. `detail`, `cause`, and stack never leave the server.
 *
 * `/submit` authenticates through `authenticate` when configured; every body reads under a byte
 * ceiling and deadline; CORS stays off unless `cors` lists origins.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   the routes, codec, and webhook gate.
 */
export function createServer(
  economy: Economy,
  options: ServerOptions = {},
): (request: Request) => Promise<Response> {
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
    request.method === 'POST' &&
    segments.length === 1 &&
    segments[0] === 'submit'
  ) {
    return submitRoute(economy, options, request);
  }
  if (
    request.method === 'POST' &&
    segments.length === 2 &&
    segments[0] === 'webhooks'
  ) {
    return webhookRoute(options, segments[1]!, request);
  }
  return problemResponse(404, 'Not found.');
}

// --- CORS -------------------------------------------------------------------------

// Exact-match against the allowlist. Null (CORS off, no Origin header, or an unlisted origin)
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

// No I/O, so it answers even when a dependency is down (/readyz covers that case). The Dockerfile
// HEALTHCHECK targets this path.
function livenessRoute(): Response {
  return jsonResponse(200, { status: 'ok' });
}

// One cheap store-touching read; any throw reports 503 with no detail so the error stays
// server-side. The probe goes through the public read surface because createServer only
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

// Every reply on the submit path echoes the correlation id, problem responses included, so a
// caller can quote one id and an operator can follow it through submit, outbox, and relay logs.
async function submitRoute(
  economy: Economy,
  options: ServerOptions,
  request: Request,
): Promise<Response> {
  const correlationId = correlationOf(request);
  const response = await runSubmit(economy, options, request);
  response.headers.set(REQUEST_ID_HEADER, correlationId);
  return response;
}

// The trace id of a W3C traceparent header wins, so a caller already running distributed
// tracing gets one id across both systems; an explicit x-request-id is next; otherwise mint.
function correlationOf(request: Request): string {
  const traceparent = request.headers.get('traceparent');
  const traceId = traceparent?.match(
    /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/,
  )?.[1];
  if (traceId !== undefined && traceId !== '0'.repeat(32)) {
    return traceId;
  }
  const supplied = request.headers.get(REQUEST_ID_HEADER);
  if (supplied !== null && /^[\w.:-]{1,128}$/.test(supplied)) {
    return supplied;
  }
  return `req_${crypto.randomUUID()}`;
}

// A `rejected` outcome is not an error: the economy declined a valid request for a business
// reason, and the response is a 200 holding the decline. Authentication runs before the body is
// read, so an unauthenticated caller costs no buffering.
async function runSubmit(
  economy: Economy,
  options: ServerOptions,
  request: Request,
): Promise<Response> {
  let principal: Principal | undefined;
  if (options.authenticate !== undefined) {
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

  let bytes: Uint8Array;
  try {
    bytes = await readBounded(request, options);
  } catch (error) {
    return bodyFault(error);
  }
  try {
    const operation = decodeOperation(parseJson(bytes), principal);
    return jsonResponse(200, encodeOutcome(await economy.submit(operation)));
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
  if (limit === undefined) {
    return null;
  }
  const key =
    limit.keyFor?.(request, principal) ?? limiterKey(request, principal);
  let verdict: RateVerdict;
  try {
    verdict = await limit.limiter.allow(key);
  } catch {
    options.meter?.count('economy.ratelimit.degraded', 1);
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

// The authenticated principal is the fairest key; without one, the bridge-stamped client
// address stands in. 'unknown' pools every caller a runtime leaves unstamped, so such hosts
// should supply keyFor.
function limiterKey(
  request: Request,
  principal: Principal | undefined,
): string {
  if (principal !== undefined) {
    switch (principal.kind) {
      case 'user':
        return `user:${principal.userId}`;
      case 'system':
        return `system:${principal.service}`;
      case 'operator':
        return `operator:${principal.operatorId}`;
    }
  }
  return `ip:${request.headers.get(CLIENT_IP_HEADER) ?? 'unknown'}`;
}

// --- /webhooks/:provider ----------------------------------------------------------

// The body is verified before the handler runs, so a forged request never reaches code that
// changes balances. The checks run in this order: signature, then freshness, then claiming the
// provider `eventId` last, so a rejected delivery does not burn an id and block a later genuine
// redelivery. This order is required; keep it as written.
// See https://economy-lab-docs.pages.dev/economy/reference/http-service/ for the gate.
//
// The raw bytes are read once; verification, replay decode, and handler all work over that
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

  let rawBytes: Uint8Array;
  try {
    rawBytes = await readBounded(request, options);
  } catch (error) {
    return bodyFault(error);
  }

  const config = options.config;
  if (config === undefined || config.webhookSecret === '') {
    // No secret configured: keep the bare pass-through (the host owns verification).
    return runHandler(handler, provider, rebuildRequest(request, rawBytes));
  }

  try {
    if (
      !(await verifyHmac(rawBytes, signatureOf(request), config.webhookSecret))
    ) {
      throw fault(
        ERROR_CODES.INVALID_SIGNATURE,
        'Webhook signature is invalid.',
      );
    }
  } catch (error) {
    return faultResponse(error);
  }

  const now = (options.clock ?? systemClock).now();
  // `Number(null)` is 0, finite, and would slip past the check below. Map a missing header to NaN so
  // a missing timestamp is rejected rather than read as the epoch.
  const header = request.headers.get(TIMESTAMP_HEADER);
  const timestamp = header === null ? Number.NaN : Number(header);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > config.replayWindowMs
  ) {
    // Stale or replayed: 200 duplicate (no mutation) so the provider stops redelivering, not a 5xx
    // that triggers repeated retries.
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

// A no-op when no replay store is wired. Decodes the body only to read its `eventId`; the handler
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
      // A non-JSON body that passed HMAC is a malformed callback, not a server fault: 400.
      throw malformed('Webhook body is not valid JSON.', error);
    }
    const event = decodeWebhookEvent(provider, parsed);
    claimed = (await options.replay.claim(event.eventId)).claimed;
  } catch (error) {
    return faultResponse(error);
  }
  if (!claimed) {
    // Redelivery of a seen eventId: 200 and run nothing, so the credit posts once.
    return jsonResponse(200, { status: 'duplicate' });
  }
  return null;
}

// `crypto.subtle.verify` compares in constant time and returns a clean false (never throws) on a
// wrong length/value; a non-hex signature fails fromHex and is also treated as a non-match.
async function verifyHmac(
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
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, provided, rawBytes);
}

// Absent header -> '', a guaranteed mismatch, so it needs no special-casing.
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

// Defined here, not imported from runtime.ts, so this file pulls in no Node/signing/hashing deps and
// stays cross-runtime (Node, Bun, Deno, Cloudflare Workers).
const systemClock: Clock = { now: () => Date.now() };

// --- Operation codec (money travels as a decimal string) --------------------------

// Money amounts arrive as decimal strings because a JSON number can't safely hold them. An
// authenticated principal replaces the actor outright, and a body that names its own is refused
// rather than silently overridden, so a caller can never believe a claimed actor was honored.
function decodeOperation(body: unknown, principal?: Principal): Operation {
  if (body === null || typeof body !== 'object') {
    throw malformed('Operation body must be a JSON object.');
  }
  const row = body as Record<string, unknown>;
  if (principal !== undefined && 'actor' in row) {
    throw malformed("Operation must not carry 'actor'; the server stamps it.");
  }
  const kind = row.kind;
  if (typeof kind !== 'string' || !(kind in AMOUNT_FIELDS)) {
    throw malformed(`Unknown operation kind: ${String(kind)}.`);
  }
  const decoded: Record<string, unknown> = { ...row };
  if (principal !== undefined) {
    decoded.actor = principal;
  }
  for (const field of AMOUNT_FIELDS[kind]!) {
    decoded[field] = decodeAmountField(row[field], field);
  }
  return decoded as unknown as Operation;
}

// Non-string field -> malformed fault (wrong shape); a bad string -> a money fault (wrong amount).
// Keeping the two distinct lets the caller tell a shape error from an amount error.
function decodeAmountField(value: unknown, field: string): Amount {
  if (typeof value !== 'string') {
    throw malformed(
      `Operation field '${field}' must be an encoded amount string.`,
    );
  }
  return decodeWire.amount(value);
}

// Every valid kind has an entry (some empty), so this map also gates known-vs-unknown kinds: a body
// whose kind is absent here is rejected as malformed before it reaches submit.
const AMOUNT_FIELDS: Record<string, ReadonlyArray<string>> = {
  topUp: ['amount'],
  spend: ['price'],
  refund: [],
  clawback: ['amount'],
  requestPayout: ['amount'],
  subscribe: ['price'],
  cancelSubscription: [],
  grantEntitlement: [],
  revokeEntitlement: [],
  grantPromo: ['amount'],
  adjust: ['amount'],
  reverse: [],
  reversePayout: [],
};

function encodeOutcome(outcome: Outcome): unknown {
  if (outcome.status === 'rejected') {
    // The detail's branded Amounts (bigint minors) become decimal strings on the wire.
    return outcome.detail === undefined
      ? outcome
      : { ...outcome, detail: encodeAmounts(outcome.detail) };
  }
  return {
    status: outcome.status,
    transaction: encodeWire.transaction(outcome.transaction),
  };
}

// --- Local helpers ----------------------------------------------------------------

// An unknown error goes out as a generic retryable 503; its stack trace and cause never reach
// the client. statusForError (errors.ts) owns the code-to-status mapping.
function faultResponse(error: unknown): Response {
  const normalized = normalizeError(error);
  return problemResponse(statusForError(normalized), normalized.message, {
    code: normalized.code,
    retryable: normalized.retryable,
  });
}

// Local verdicts, not EconomyErrors: they map to 413/408 in bodyFault and never leave the file.
class BodyTooLarge extends Error {}
class BodyTimeout extends Error {}

// Reads the whole body under the byte ceiling and read deadline. A declared content-length past
// the ceiling is refused before any byte is read; a lying or absent declaration is caught by
// counting as chunks arrive.
async function readBounded(
  request: Request,
  options: ServerOptions,
): Promise<Uint8Array> {
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (Number(request.headers.get('content-length') ?? '0') > maxBytes) {
    throw new BodyTooLarge();
  }
  const body = request.body;
  if (body === null) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Cancelling resolves the pending read as done, so the loop observes the deadline promptly
  // without racing promises. AbortSignal.timeout, not a raw timer: it self-cleans and is a web
  // standard present on every target runtime.
  const deadline = AbortSignal.timeout(
    options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
  );
  deadline.addEventListener('abort', () => void reader.cancel());
  for (;;) {
    const { done, value } = await reader.read();
    if (deadline.aborted) {
      throw new BodyTimeout();
    }
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bodyFault(error: unknown): Response {
  if (error instanceof BodyTooLarge) {
    return problemResponse(413, 'Request body is too large.');
  }
  if (error instanceof BodyTimeout) {
    return problemResponse(408, 'Request body read timed out.');
  }
  return faultResponse(error);
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

// RFC 9457 problem details: `title` is the caller-safe message; `detail`/`cause`/stack stay
// server-side. See https://www.rfc-editor.org/rfc/rfc9457 for the format.
function problemResponse(
  status: number,
  title: string,
  fault?: { code: ErrorCode; retryable: boolean },
): Response {
  const body = {
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
