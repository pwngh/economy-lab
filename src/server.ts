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
 * A handler the host plugs in to receive incoming provider callbacks (webhooks), such as
 * a payment processor reporting a settlement or a dispute. It gets the URL's provider
 * name and the request, and returns the HTTP response to send back.
 *
 * The server verifies the callback is authentic (its body carries a signature computed with a
 * shared secret) and recent before the handler ever runs, so by the time the handler is invoked
 * the bytes are trusted. The
 * `request` it receives is a fresh `Request` over the same raw body the server already read
 * and verified, so the handler can read the body again without the server double-consuming it.
 */
export type WebhookHandler = (
  provider: string,
  request: Request,
) => Promise<Response>;

export interface ServerOptions {
  webhook?: WebhookHandler;

  // When present, inbound webhooks are verified before the handler runs. The server recomputes the
  // keyed hash (HMAC-SHA256) of the raw body using `config.webhookSecret` and requires it to match
  // the `x-signature` header, and it requires the `x-timestamp` header to fall within
  // `config.replayWindowMs` of the clock. When absent, the webhook path stays a bare pass-through
  // and the host does its own verification.
  config?: Config;

  // The clock used to judge webhook freshness. Time is read only through this clock, never
  // `Date.now()` directly, so a test can freeze it. Defaults to one reading wall-clock time when
  // webhook verification is enabled but no clock is supplied.
  clock?: Clock;

  // Records which provider events have already been processed, so the same event is never applied
  // twice. The server claims an event here only as the LAST check (after the signature and
  // freshness checks below), so a rejected or forged delivery never consumes a provider `eventId`
  // and blocks a later genuine one. When present, the server decodes the raw body into a typed
  // WebhookEvent, claims its `eventId` here, and on a repeat of an already-seen id returns a 200
  // acknowledgement without invoking the handler — so a redelivery posts nothing. When absent, the
  // webhook path stays the bare signature-plus-freshness pass-through to the handler, and the host
  // is responsible for its own duplicate-suppression.
  replay?: ReplayStore;
}

// The request-header name carrying the signature over the raw webhook body: a keyed hash
// (HMAC-SHA256) written as hex. The server recomputes this hash and compares to prove the body is
// authentic.
let SIGNATURE_HEADER = 'x-signature';

// The request-header name carrying the provider's send time, as milliseconds since 1 Jan 1970 UTC.
// It is used to reject deliveries that are too old, which guards against an attacker re-sending a
// captured request.
let TIMESTAMP_HEADER = 'x-timestamp';

/**
 * Build the HTTP entry point for an {@link Economy}: a function that takes a standard
 * Fetch `Request` and returns a `Response`. Because it uses only the Fetch globals (no
 * Node-specific APIs), the same function runs on Node, Bun, Deno, and Cloudflare Workers.
 *
 * It routes these paths and 404s everything else:
 * - `POST /submit` reads one operation from the JSON body, runs it, and returns the result.
 * - `POST /webhooks/:provider` verifies the callback, then hands it to the injected handler.
 * - `GET /healthz` reports liveness (the process is up) without touching storage.
 * - `GET /readyz` reports readiness by doing one cheap store-touching read through the economy.
 *
 * When the work throws an {@link EconomyError}, {@link statusFor} turns it into an HTTP
 * status code, and only the error's `message` is sent back — never its internal details.
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

// Liveness: the process is running and can serve a response. It does no I/O, so a healthy
// process answers even when a downstream dependency is down — that distinction is what
// /readyz is for. The Dockerfile HEALTHCHECK targets this path.
function livenessRoute(): Response {
  return jsonResponse(200, { status: 'ok' });
}

// Readiness: confirm a dependency is reachable before the orchestrator routes traffic here. It
// does one cheap store-touching read through the economy (the balance of a known system account);
// any throw means the store is unreachable, which is reported as 503 with no detail (the
// underlying error stays server-side). createServer only receives an Economy, so the probe goes
// through the public read surface rather than poking the ledger directly.
async function readinessRoute(economy: Economy): Promise<Response> {
  try {
    await economy.read.balance(SYSTEM.REVENUE);
    return jsonResponse(200, { status: 'ready' });
  } catch {
    return jsonResponse(503, { status: 'unavailable' });
  }
}

// --- /submit ----------------------------------------------------------------------

// Read the operation from the body, run it, and send the result back. A bad body or a
// thrown EconomyError becomes an error response with the mapped status, carrying only the
// message. A `rejected` outcome (the economy declining a valid request for a normal
// business reason, like insufficient funds) is NOT an error here: it comes back as a 200
// holding the decline, so the caller can handle it without it counting as a server failure.
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

// Gate an inbound webhook, then pass it to the injected provider handler. If no handler was
// wired up, return 404 so the caller learns the callback wasn't handled, rather than dropping it
// without a trace.
//
// When a config with a webhook secret is present, the body is verified BEFORE the handler runs, so
// a forged request never reaches code that changes balances. The checks run in this order:
//   1. A keyed hash (HMAC-SHA256) of the raw body bytes must match the `x-signature` header — else
//      a 401 INVALID_SIGNATURE response, and nothing downstream runs. (The keyed hash proves the
//      sender knew the shared secret, so the body is authentic and untampered.)
//   2. The `x-timestamp` header must be a finite number and within `config.replayWindowMs` of the
//      clock — else the request is treated as old or replayed and answered with a 200 "duplicate"
//      acknowledgement, so the provider stops redelivering rather than retrying forever.
//   3. (Only when a replay store is wired) the provider `eventId` is claimed on the replay store
//      as the LAST check, so a forged or stale delivery — already rejected above — never consumes
//      the id and blocks a later genuine redelivery. A repeat of an already-seen eventId is answered
//      with a 200 acknowledgement and the handler never runs, so the work it does (such as
//      crediting a user) happens exactly once.
//
// The raw bytes are read exactly once. Verification, the replay decode, and the handler all work
// over that same buffer: the handler gets a fresh Request rebuilt from the bytes, so the body is
// never consumed twice.
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
  // A missing header reads as `null`, and `Number(null)` is 0 — a finite value that would slip past
  // the check below. Map a missing header to NaN explicitly so a missing timestamp is rejected
  // rather than read as the epoch.
  let header = request.headers.get(TIMESTAMP_HEADER);
  let timestamp = header === null ? Number.NaN : Number(header);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > config.replayWindowMs
  ) {
    // Stale or replayed: a 200 duplicate acknowledgement (no mutation) so the provider stops
    // redelivering, rather than a 5xx that invites an endless retry storm.
    return jsonResponse(200, { status: 'duplicate' });
  }

  // Last check: stop an already-processed event from running twice. It returns a Response to send
  // immediately (a 200 "duplicate" acknowledgement or an error), or null when the event is new and
  // the handler should run.
  let dedup = await replayGate(options, provider, rawBytes);
  if (dedup !== null) {
    return dedup;
  }

  // The body is now verified and confirmed not to be a repeat. Hand it to the handler over a fresh
  // Request so the handler can read the body again. The handler the host wires in decodes the event
  // and applies it once through the economy it holds — for a payment callback, crediting the user.
  let verified = rebuildRequest(request, rawBytes);
  try {
    return await handler(provider, verified);
  } catch (error) {
    return faultResponse(error);
  }
}

// The check that stops an already-processed provider event from being applied a second time. It
// runs LAST (after the signature and freshness checks) so a forged or stale delivery never reaches
// it and consumes an event id. It is active only when a replay store is wired; without one the
// path stays a bare pass-through and the host handles its own duplicate-suppression. To find the
// event's id, the body is parsed into a typed WebhookEvent here — reusing the same decimal-string
// money encoding the rest of the system uses, so a money `amount` survives the round trip — purely
// to read its `eventId` and claim it; the handler still gets the raw verified bytes to do the real
// work. Returns a Response to send immediately (a 200 "duplicate" acknowledgement, or an error), or
// null when the event is new (or no store is configured) and the caller should run the handler.
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
    // A redelivery of an already-seen eventId: acknowledge 200 and run nothing, so the credit
    // posts exactly once.
    return jsonResponse(200, { status: 'duplicate' });
  }
  return null;
}

// Verify an HMAC-SHA256 signature over the raw request bytes using Web Crypto. The hex
// `x-signature` is decoded to bytes and checked with `crypto.subtle.verify`, which compares in
// constant time and only returns true when the signature has the right length and value — so a
// malformed or short signature is a clean false, never a thrown comparison. A non-hex signature
// (a structurally broken header) decodes-fails and is treated as a non-match.
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

// Pull the hex signature off the request, or '' when the header is absent (an absent signature is
// a guaranteed mismatch, never a special case).
function signatureOf(request: Request): string {
  return request.headers.get(SIGNATURE_HEADER) ?? '';
}

// Build a fresh Request carrying the already-read bytes as its body, copying method, URL, and
// headers, so the verified handler can read the body that the server consumed for verification.
function rebuildRequest(request: Request, rawBytes: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBytes,
  });
}

// The default clock, used for the freshness check when the caller did not supply one. It reads the
// real system time. It is defined here instead of imported from runtime.ts so this file depends
// only on the cross-runtime Fetch/Web APIs (the ones present on Node, Bun, Deno, and Cloudflare
// Workers) and pulls in no signing or hashing setup. Tests and hosts can override it by passing
// their own clock.
let systemClock: Clock = { now: () => Date.now() };

// --- Operation codec (money travels as a decimal string) --------------------------

// Turn the parsed JSON body into a typed Operation. Money amounts arrive as decimal
// strings (a JSON number can't safely hold them), so for whichever operation `kind` the
// body declares, convert its money fields back into proper Amount values using the shared
// decoder. A body that is not an object, or whose `kind` isn't a known operation, is
// thrown as a malformed-operation fault rather than passed along.
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

// Convert one money field from its decimal string into an Amount. If the field is missing
// or isn't a string, that's a malformed-operation fault (the request's shape is wrong).
// If the string is present but isn't a valid amount, the decoder itself throws a separate
// money fault, keeping "wrong shape" and "wrong amount" as distinct errors.
function decodeAmountField(value: unknown, field: string): Amount {
  if (typeof value !== 'string') {
    throw malformed(
      `Operation field '${field}' must be an encoded amount string.`,
    );
  }
  return decodeWire.amount(value);
}

// For each operation kind, the names of its money fields — the only fields that need
// decoding from a decimal string; everything else is left as plain JSON. Every valid kind
// has an entry (some with no money fields), so a body whose kind is missing from this map
// is rejected as malformed before it reaches submit.
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

// Turn an outcome into its JSON shape for the response. A committed or duplicate outcome
// carries a transaction, whose debit and credit lines have their amounts written back out
// as decimal strings. A rejected outcome carries only its reason code and optional detail
// (no money lives on it), so it goes out unchanged.
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

// Choose the HTTP status for a thrown EconomyError from its stable code: a missing
// permission or a bad signature is 401, a malformed request or bad amount is a 400 the
// caller must fix, a fault flagged as retryable is a 503 the caller may try again, and
// any other fault is a 500.
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

// The fault codes that mean the request itself was wrong and the caller can fix it: a
// malformed operation, an invalid amount, or mixing two currencies. These map to 400. A
// broken internal rule or a storage failure is not the caller's fault and maps to 500.
const BAD_REQUEST_CODES = new Set<string>([
  ERROR_CODES.MALFORMED_OPERATION,
  ERROR_CODES.INVALID_AMOUNT,
  ERROR_CODES.CURRENCY_MISMATCH,
]);

// --- Local helpers ----------------------------------------------------------------

// Turn anything thrown into an error response with the mapped status and only the error's
// message. If what was caught isn't already an EconomyError, normalizeError wraps it as a
// retryable storage failure, so an unexpected throw goes out as a 503 with a generic
// message and its stack trace and underlying cause never reach the client.
function faultResponse(error: unknown): Response {
  let normalized: EconomyError =
    error instanceof EconomyError ? error : normalizeError(error);
  return errorResponse(statusFor(normalized), normalized.message);
}

// Read the request body and parse it as JSON. An empty body, or one that isn't valid
// JSON, is turned into a malformed-operation fault, so the raw parser error never escapes
// and the bad-request verdict stays this layer's call.
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
