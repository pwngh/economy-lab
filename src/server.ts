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

  // When present, the server verifies inbound webhooks before the handler runs. HMAC-SHA256 of the
  // raw body, keyed with `config.webhookSecret`, must match `x-signature`. The `x-timestamp` must
  // fall within `config.replayWindowMs` of the clock. When absent, the webhook path is a bare
  // pass-through and the host verifies.
  config?: Config;

  // Clock for webhook freshness. Time is read only through this, never `Date.now()`, so tests can
  // freeze it. Defaults to wall-clock when verification is enabled and no clock is given.
  clock?: Clock;

  // Records which provider events have been processed. The server claims an `eventId` last, after
  // the signature and freshness checks pass, so a rejected or forged delivery never burns a provider
  // `eventId` and blocks a later genuine one. When present, the server decodes the body into a typed
  // WebhookEvent, claims its `eventId`, and on a repeat returns 200 without invoking the handler.
  // When absent, the path is the bare signature-plus-freshness pass-through and the host dedups.
  replay?: ReplayStore;
}

// Names the signature header. It holds the hex-encoded HMAC-SHA256 of the raw body (see verifyHmac).
let SIGNATURE_HEADER = 'x-signature';

// Names the timestamp header. It holds the provider's send time in milliseconds since 1 Jan 1970
// UTC, used to reject stale deliveries (replay of a captured request).
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
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for the routes, codec, and webhook gate.
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

// Reports liveness: the process is up and can serve a response. It does no I/O, so it answers even
// when a downstream dependency is down (/readyz covers that case). The Dockerfile HEALTHCHECK
// targets this path.
function livenessRoute(): Response {
  return jsonResponse(200, { status: 'ok' });
}

// Reports readiness by confirming a dependency is reachable before the orchestrator routes traffic
// here. It makes one cheap store-touching read through the economy, the balance of a known system
// account. Any throw means the store is unreachable, reported as 503 with no detail so the error
// stays server-side. createServer only receives an Economy, so the probe goes through the public
// read surface, not the ledger.
async function readinessRoute(economy: Economy): Promise<Response> {
  try {
    await economy.read.balance(SYSTEM.REVENUE);
    return jsonResponse(200, { status: 'ready' });
  } catch {
    return jsonResponse(503, { status: 'unavailable' });
  }
}

// --- /submit ----------------------------------------------------------------------

// Reads the operation from the body, runs it, and sends the result back. A bad body or a thrown
// EconomyError becomes an error response with the mapped status, carrying only the message. A
// `rejected` outcome is not an error. It happens when the economy declines a valid request for a
// business reason, such as insufficient funds, and returns 200 holding the decline.
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

// Gates an inbound webhook, then passes it to the injected handler. Returns 404 when no handler is
// wired. With a webhook secret configured, the body is verified before the handler runs, so a forged
// request never reaches code that changes balances. The checks run in this order: signature, then
// freshness, then (only with a replay store) claiming the provider `eventId` last so a rejected
// delivery does not record an id and block a later genuine redelivery. This order is required; keep
// it as written. See https://economy-lab-docs.pages.dev/economy/reference/http-service/ for the gate.
//
// The raw bytes are read once. Verification, replay decode, and handler all work over that buffer.
// The handler gets a fresh Request rebuilt from the bytes, so the body is never consumed twice.
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
    // that triggers repeated retries.
    return jsonResponse(200, { status: 'duplicate' });
  }

  // Last check: stop an already-processed event from running twice. Returns a Response to send
  // immediately (200 "duplicate" or an error), or null when the event is new and the handler runs.
  let dedup = await replayGate(options, provider, rawBytes);
  if (dedup !== null) {
    return dedup;
  }

  // Verified and not a repeat. Hand it to the handler over a fresh Request so it can read the body
  // again. The host's handler decodes the event and applies it once through its economy, such as
  // crediting the user on a payment callback.
  let verified = rebuildRequest(request, rawBytes);
  try {
    return await handler(provider, verified);
  } catch (error) {
    return faultResponse(error);
  }
}

// Claims the provider `eventId` so an already-processed event can't run twice (see webhookRoute
// step 3). A no-op when no replay store is wired. Decodes the body into a typed WebhookEvent only to
// read its `eventId`; the handler still gets the raw verified bytes. Returns a Response to send
// immediately (200 "duplicate" or an error), or null when the event is new and the caller runs.
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
  let key = await crypto.subtle.importKey(
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

// Lets the verified handler re-read the body the server already consumed for verification.
function rebuildRequest(request: Request, rawBytes: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBytes,
  });
}

// Defined here, not imported from runtime.ts, so this file pulls in no Node/signing/hashing deps and
// stays cross-runtime (Node, Bun, Deno, Cloudflare Workers).
let systemClock: Clock = { now: () => Date.now() };

// --- Operation codec (money travels as a decimal string) --------------------------

// Converts a parsed JSON body into a typed Operation. Money amounts arrive as decimal strings
// because a JSON number can't safely hold them. For the body's `kind`, the shared decoder converts
// its money fields back into Amount values. A non-object body, or one whose `kind` isn't a known
// operation, throws a malformed-operation fault.
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

// Converts an Outcome into the JSON shape for the response. A committed or duplicate outcome carries
// a transaction whose debit and credit line amounts are written back as decimal strings. A rejected
// outcome carries only its reason code and optional detail, no money, so it goes out unchanged.
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

// Maps a thrown EconomyError to an HTTP status by its stable code. A missing permission or a bad
// signature becomes 401. A malformed request or a bad amount becomes 400. A retryable fault becomes
// 503. Anything else becomes 500.
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

// normalizeError wraps a non-EconomyError as a retryable storage failure -> 503 with a generic
// message; its stack trace and cause never reach the client.
function faultResponse(error: unknown): Response {
  let normalized: EconomyError =
    error instanceof EconomyError ? error : normalizeError(error);
  return errorResponse(statusFor(normalized), normalized.message);
}

// Empty or invalid-JSON body -> malformed fault, so the raw parser error never escapes and the
// bad-request verdict stays here.
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
