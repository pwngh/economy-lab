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
} from '#src/errors.ts';
import { SYSTEM } from '#src/accounts.ts';
import { fromHex } from '#src/bytes.ts';
import { decodeWebhookEvent } from '#src/webhooks.ts';

import type { Amount } from '#src/money.ts';
import type { Clock, ReplayStore } from '#src/ports.ts';
import type { Config } from '#src/config.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';

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

  // When present, inbound webhooks are verified before the handler runs: HMAC-SHA256 of the raw body
  // (keyed with `config.webhookSecret`) must match `x-signature`, and `x-timestamp` must fall within
  // `config.replayWindowMs` of the clock. When absent, the webhook path is a bare pass-through and
  // the host verifies.
  config?: Config;

  // Clock for webhook freshness. Time is read only through this, never `Date.now()`, so tests can
  // freeze it. Defaults to wall-clock when verification is enabled and no clock is given.
  clock?: Clock;

  // Records which provider events have been processed. Claimed last (after signature and freshness),
  // so a rejected or forged delivery never burns a provider `eventId` and blocks a later genuine
  // one. When present, the server decodes the body into a typed WebhookEvent, claims its `eventId`,
  // and on a repeat returns 200 without invoking the handler. When absent, the path is the bare
  // signature-plus-freshness pass-through and the host dedups.
  replay?: ReplayStore;
}

// HMAC-SHA256 over the raw body, as hex. Recomputed and compared to authenticate the body.
let SIGNATURE_HEADER = 'x-signature';

// Provider's send time (ms since 1 Jan 1970 UTC). Used to reject stale deliveries (replay of a
// captured request).
let TIMESTAMP_HEADER = 'x-timestamp';

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
 * On a thrown {@link EconomyError}, {@link statusFor} maps it to a status code and only the error's
 * `message` is returned, never its internals.
 */
export function createServer(
  economy: Economy,
  options: ServerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    let segments = new URL(request.url).pathname.split('/').filter(Boolean);

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
      return submitRoute(economy, request);
    }
    if (
      request.method === 'POST' &&
      segments.length === 2 &&
      segments[0] === 'webhooks'
    ) {
      return webhookRoute(options, segments[1]!, request);
    }
    return errorResponse(404, 'Not found.');
  };
}

// --- /healthz and /readyz ---------------------------------------------------------

// Liveness: process is up and can serve a response. Does no I/O, so it answers even when a
// downstream dependency is down (/readyz covers that). Dockerfile HEALTHCHECK targets this path.
function livenessRoute(): Response {
  return jsonResponse(200, { status: 'ok' });
}

// Readiness: confirm a dependency is reachable before the orchestrator routes traffic here. One
// cheap store-touching read through the economy (balance of a known system account); any throw means
// the store is unreachable, reported as 503 with no detail (error stays server-side). createServer
// only receives an Economy, so the probe goes through the public read surface, not the ledger.
async function readinessRoute(economy: Economy): Promise<Response> {
  try {
    await economy.read.balance(SYSTEM.REVENUE);
    return jsonResponse(200, { status: 'ready' });
  } catch {
    return jsonResponse(503, { status: 'unavailable' });
  }
}

// --- /submit ----------------------------------------------------------------------

// Read the operation from the body, run it, send the result back. A bad body or thrown EconomyError
// becomes an error response with the mapped status, carrying only the message. A `rejected` outcome
// (economy declining a valid request for a business reason, like insufficient funds) is not an
// error: it returns 200 holding the decline.
async function submitRoute(
  economy: Economy,
  request: Request,
): Promise<Response> {
  let operation: Operation;
  try {
    operation = decodeOperation(await readJson(request));
  } catch (error) {
    return faultResponse(error);
  }

  try {
    return jsonResponse(200, encodeOutcome(await economy.submit(operation)));
  } catch (error) {
    return faultResponse(error);
  }
}

// --- /webhooks/:provider ----------------------------------------------------------

// Gate an inbound webhook, then pass it to the injected handler. With no handler wired, return 404.
//
// When a config with a webhook secret is present, the body is verified before the handler runs, so a
// forged request never reaches code that changes balances. Checks, in order:
//   1. HMAC-SHA256 of the raw body must match `x-signature`, else 401 INVALID_SIGNATURE and nothing
//      downstream runs. A match proves the sender knew the shared secret.
//   2. `x-timestamp` must be finite and within `config.replayWindowMs` of the clock, else treated as
//      old/replayed and answered 200 "duplicate" so the provider stops redelivering.
//   3. (Only with a replay store) the provider `eventId` is claimed last, so a forged or stale
//      delivery (already rejected above) never burns the id and blocks a later genuine redelivery. A
//      repeat eventId is answered 200 and the handler never runs, so its work (e.g. crediting a
//      user) happens once.
//
// The raw bytes are read once. Verification, replay decode, and handler all work over that buffer;
// the handler gets a fresh Request rebuilt from the bytes, so the body is never consumed twice.
async function webhookRoute(
  options: ServerOptions,
  provider: string,
  request: Request,
): Promise<Response> {
  let handler = options.webhook;
  if (handler === undefined) {
    return errorResponse(404, 'No webhook handler configured.');
  }

  let config = options.config;
  if (config === undefined || config.webhookSecret === '') {
    // No secret configured: keep the bare pass-through (the host owns verification).
    try {
      return await handler(provider, request);
    } catch (error) {
      return faultResponse(error);
    }
  }

  let rawBytes: Uint8Array;
  try {
    rawBytes = new Uint8Array(await request.arrayBuffer());
  } catch (error) {
    return faultResponse(error);
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

  let now = (options.clock ?? systemClock).now();
  // `Number(null)` is 0, finite, and would slip past the check below. Map a missing header to NaN so
  // a missing timestamp is rejected rather than read as the epoch.
  let header = request.headers.get(TIMESTAMP_HEADER);
  let timestamp = header === null ? Number.NaN : Number(header);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > config.replayWindowMs
  ) {
    // Stale or replayed: 200 duplicate (no mutation) so the provider stops redelivering, not a 5xx
    // that invites a retry storm.
    return jsonResponse(200, { status: 'duplicate' });
  }

  // Last check: stop an already-processed event from running twice. Returns a Response to send
  // immediately (200 "duplicate" or an error), or null when the event is new and the handler runs.
  let dedup = await replayGate(options, provider, rawBytes);
  if (dedup !== null) {
    return dedup;
  }

  // Verified and not a repeat. Hand it to the handler over a fresh Request so it can read the body
  // again. The host's handler decodes the event and applies it once through its economy (e.g.
  // crediting the user on a payment callback).
  let verified = rebuildRequest(request, rawBytes);
  try {
    return await handler(provider, verified);
  } catch (error) {
    return faultResponse(error);
  }
}

// Stops an already-processed provider event from being applied twice. Runs last (after signature and
// freshness) so a forged or stale delivery never reaches it and burns an event id. Active only when
// a replay store is wired; without one the path is a bare pass-through and the host dedups. The body
// is parsed into a typed WebhookEvent (reusing the decimal-string money encoding, so a money
// `amount` survives the round trip) only to read and claim its `eventId`; the handler still gets the
// raw verified bytes. Returns a Response to send immediately (200 "duplicate" or an error), or null
// when the event is new (or no store is configured) and the caller runs the handler.
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
    let text = new TextDecoder().decode(rawBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // A non-JSON body that passed HMAC is a malformed callback, not a server fault: 400.
      throw malformed('Webhook body is not valid JSON.', error);
    }
    let event = decodeWebhookEvent(provider, parsed);
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

// Verify an HMAC-SHA256 signature over the raw request bytes using Web Crypto. The hex
// `x-signature` is decoded to bytes and checked with `crypto.subtle.verify`, which compares in
// constant time and returns true only on the right length and value, so a malformed or short
// signature is a clean false, never a thrown comparison. A non-hex signature fails decode and is
// treated as a non-match.
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
  let key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, provided, rawBytes);
}

// Hex signature off the request, or '' when the header is absent (absent signature is a guaranteed
// mismatch, no special-casing needed).
function signatureOf(request: Request): string {
  return request.headers.get(SIGNATURE_HEADER) ?? '';
}

// Fresh Request carrying the already-read bytes as its body (copies method, URL, headers), so the
// verified handler can re-read the body the server consumed for verification.
function rebuildRequest(request: Request, rawBytes: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBytes,
  });
}

// Default clock for the freshness check when the caller supplies none; reads real system time.
// Defined here rather than imported from runtime.ts so this file depends only on cross-runtime
// Fetch/Web APIs (Node, Bun, Deno, Cloudflare Workers) and pulls in no signing/hashing setup. Tests
// and hosts override it with their own clock.
let systemClock: Clock = { now: () => Date.now() };

// --- Operation codec (money travels as a decimal string) --------------------------

// Parsed JSON body → typed Operation. Money amounts arrive as decimal strings (a JSON number can't
// safely hold them), so for the body's `kind`, convert its money fields back into Amount values via
// the shared decoder. A non-object body, or one whose `kind` isn't a known operation, throws a
// malformed-operation fault.
function decodeOperation(body: unknown): Operation {
  if (body === null || typeof body !== 'object') {
    throw malformed('Operation body must be a JSON object.');
  }
  let row = body as Record<string, unknown>;
  let kind = row.kind;
  if (typeof kind !== 'string' || !(kind in AMOUNT_FIELDS)) {
    throw malformed(`Unknown operation kind: ${String(kind)}.`);
  }
  let decoded: Record<string, unknown> = { ...row };
  for (let field of AMOUNT_FIELDS[kind]!) {
    decoded[field] = decodeAmountField(row[field], field);
  }
  return decoded as unknown as Operation;
}

// One money field's decimal string → Amount. A missing or non-string field is a malformed-operation
// fault (wrong shape). A present-but-invalid string makes the decoder throw a separate money fault,
// keeping "wrong shape" and "wrong amount" distinct.
function decodeAmountField(value: unknown, field: string): Amount {
  if (typeof value !== 'string') {
    throw malformed(
      `Operation field '${field}' must be an encoded amount string.`,
    );
  }
  return decodeWire.amount(value);
}

// Per operation kind, its money field names: the only fields needing decimal-string decoding,
// everything else stays plain JSON. Every valid kind has an entry (some empty), so a body whose kind
// is missing from this map is rejected as malformed before it reaches submit.
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
  // No money fields: sagaId and reason are plain strings, so the body needs no amount decoding.
  reversePayout: [],
};

// Outcome → JSON shape for the response. A committed or duplicate outcome carries a transaction
// whose debit/credit line amounts are written back as decimal strings. A rejected outcome carries
// only its reason code and optional detail (no money), so it goes out unchanged.
function encodeOutcome(outcome: Outcome): unknown {
  if (outcome.status === 'rejected') {
    return outcome;
  }
  return {
    status: outcome.status,
    transaction: encodeWire.transaction(outcome.transaction),
  };
}

// --- HTTP status mapping ----------------------------------------------------------

// HTTP status for a thrown EconomyError, by its stable code: missing permission or bad signature →
// 401, malformed request or bad amount → 400, retryable fault → 503, anything else → 500.
function statusFor(error: EconomyError): number {
  if (error.code === ERROR_CODES.UNAUTHORIZED) {
    return 401;
  }
  if (error.code === ERROR_CODES.INVALID_SIGNATURE) {
    return 401;
  }
  if (BAD_REQUEST_CODES.has(error.code)) {
    return 400;
  }
  return error.retryable ? 503 : 500;
}

// Fault codes meaning the request itself was wrong and the caller can fix it: malformed operation,
// invalid amount, or mixed currencies. These map to 400. A broken internal rule or storage failure
// isn't the caller's fault and maps to 500.
const BAD_REQUEST_CODES = new Set<string>([
  ERROR_CODES.MALFORMED_OPERATION,
  ERROR_CODES.INVALID_AMOUNT,
  ERROR_CODES.CURRENCY_MISMATCH,
]);

// --- Local helpers ----------------------------------------------------------------

// Anything thrown → error response with the mapped status and only the error's message. A non-
// EconomyError is wrapped by normalizeError as a retryable storage failure, so an unexpected throw
// goes out as a 503 with a generic message; its stack trace and cause never reach the client.
function faultResponse(error: unknown): Response {
  let normalized: EconomyError =
    error instanceof EconomyError ? error : normalizeError(error);
  return errorResponse(statusFor(normalized), normalized.message);
}

// Read the request body and parse it as JSON. An empty or invalid-JSON body becomes a malformed-
// operation fault, so the raw parser error never escapes and the bad-request verdict stays here.
async function readJson(request: Request): Promise<unknown> {
  let text = await request.text();
  if (text.length === 0) {
    throw malformed('Request body is empty.');
  }
  try {
    return JSON.parse(text);
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

function errorResponse(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}
