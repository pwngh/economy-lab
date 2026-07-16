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

  // When present, the server verifies inbound webhooks (signature and freshness) before the
  // handler runs. When absent, the webhook path is a bare pass-through and the host verifies.
  config?: Config;

  // Clock for webhook freshness. Time is read only through this, never `Date.now()`, so tests can
  // freeze it. Defaults to wall-clock when verification is enabled and no clock is given.
  clock?: Clock;

  // Dedup store for provider `eventId`s: a repeat delivery returns 200 without invoking the
  // handler. When absent, the host dedups. The claim-last ordering lives at webhookRoute.
  replay?: ReplayStore;
}

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
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   the routes, codec, and webhook gate.
 */
export function createServer(
  economy: Economy,
  options: ServerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
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
      return submitRoute(economy, request);
    }
    if (
      request.method === 'POST' &&
      segments.length === 2 &&
      segments[0] === 'webhooks'
    ) {
      return webhookRoute(options, segments[1]!, request);
    }
    return problemResponse(404, 'Not found.');
  };
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

// A `rejected` outcome is not an error: the economy declined a valid request for a business
// reason, and the response is a 200 holding the decline.
async function submitRoute(
  economy: Economy,
  request: Request,
): Promise<Response> {
  try {
    const operation = decodeOperation(await readJson(request));
    return jsonResponse(200, encodeOutcome(await economy.submit(operation)));
  } catch (error) {
    return faultResponse(error);
  }
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

  const config = options.config;
  if (config === undefined || config.webhookSecret === '') {
    // No secret configured: keep the bare pass-through (the host owns verification).
    return runHandler(handler, provider, request);
  }

  let rawBytes: Uint8Array;
  try {
    rawBytes = new Uint8Array(await request.arrayBuffer());
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

// Money amounts arrive as decimal strings because a JSON number can't safely hold them.
function decodeOperation(body: unknown): Operation {
  if (body === null || typeof body !== 'object') {
    throw malformed('Operation body must be a JSON object.');
  }
  const row = body as Record<string, unknown>;
  const kind = row.kind;
  if (typeof kind !== 'string' || !(kind in AMOUNT_FIELDS)) {
    throw malformed(`Unknown operation kind: ${String(kind)}.`);
  }
  const decoded: Record<string, unknown> = { ...row };
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

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
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
