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
 * A {@link Processor} backed by the Thunes Money Transfer v2 API (the cross-border payout rail).
 *
 * economy-lab's payout seam is one call — `submitPayout({ key, userId, amount }) -> { providerRef }`
 * — but Thunes Money Transfer is a three-step flow: create a **quotation** (lock the FX rate), create
 * a **transaction** against it (name the beneficiary / credit party), then **confirm** the
 * transaction (the money-movement boundary). This adapter hides that orchestration behind the single
 * port method, returning the Thunes transaction id as the `providerRef`.
 *
 * Idempotency rides on `external_id`, which Thunes treats as the partner's dedupe handle (a reused id
 * is rejected, doc error `1007001`). The worker passes the payout saga id as `key`, so this sets
 * `external_id = key` on the quotation and transaction; that makes the *whole* flow safe to re-run —
 * the worker (`src/worker/payouts.ts`) owns retry/backoff/attempt-capping, so this adapter is a single
 * attempt that throws a retryable {@link ERROR_CODES.PROVIDER_FAILURE} on a transient failure and lets
 * the worker try the next sweep. On a re-run it recovers the already-created transaction (`1007001`)
 * and treats an already-confirmed transaction (`1007002`) as success, so a retried payout never pays
 * twice and never strands the seller's reserve.
 *
 * Settlement comes back the other way: Thunes POSTs the full transaction object to a callback URL on
 * each status change (it is self-describing, unlike the Collection API's ping-only callback). The
 * webhook edge maps that to the existing `PayoutSettledEvent` -> `settlePayout` path via
 * {@link decodeThunesPayoutCallback}, so the inbound half reuses economy-lab's pipeline unchanged.
 */

import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';
import { decodeAmount, encodeAmount } from '#src/money.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { Options, Processor } from '#src/ports.ts';
import type { PayoutSettledEvent } from '#src/webhooks.ts';
import type { FetchLike } from '#src/adapters/processor.ts';

// --- Recipient resolution ---------------------------------------------------------

/**
 * The Thunes-specific routing for one payout, resolved from economy-lab's opaque `usr_…` token. The
 * port carries only `userId`; Thunes needs the destination service (`payerId`) and the credit-party
 * details, which live in the host's beneficiary/KYC store, never in this adapter. The host supplies a
 * {@link ResolveRecipient} that maps a user id to this shape.
 */
export interface ThunesRecipient {
  // The Thunes payer id: the destination service (a specific mobile-wallet or bank in the receiving
  // country), discovered via `GET /v2/money-transfer/payers` and typically cached by the host.
  payerId: string;

  // How the funds are routed to the beneficiary, per the payer's accepted identifiers, e.g.
  // `{ msisdn }` for a mobile wallet or `{ bank_account_number, swift_bic_code }` for a bank.
  creditPartyIdentifier: Record<string, string>;

  // The beneficiary entity fields the chosen payer requires (name, country, etc.). Passed through to
  // Thunes verbatim; the required set is payer-specific, so the host shapes it, not this adapter.
  beneficiary: Record<string, unknown>;

  // ISO 4217 code of the currency the beneficiary is paid in (the quotation's destination currency).
  destinationCurrency: string;
}

/** Resolves an economy-lab `userId` to its Thunes routing. Host-supplied; backed by a KYC/beneficiary store. */
export type ResolveRecipient = (
  userId: string,
  options?: Options,
) => Promise<ThunesRecipient>;

// --- Configuration ----------------------------------------------------------------

export interface ThunesProcessorConfig {
  /** Thunes API gateway base URL (scheme + host), e.g. `https://api.thunes.com`. */
  baseUrl: string;

  /** API key — the user-id half of Thunes' HTTP Basic credentials. Never written to logs or errors. */
  apiKey: string;

  /** API secret — the password half of the Basic credentials. Never written to logs or errors. */
  apiSecret: string;

  /**
   * The sending party for the transaction. economy-lab pays creators on the platform's behalf, so
   * this is the platform's sending business (a B2C transfer). Passed through to Thunes verbatim.
   */
  sender: Record<string, unknown>;

  /** Maps a payout's `userId` to its Thunes routing (payer + credit party + beneficiary). */
  resolveRecipient: ResolveRecipient;

  /** Quotation mode. `SOURCE_AMOUNT` (the default) fixes the USD we send and lets Thunes compute the destination. */
  quotationMode?: 'SOURCE_AMOUNT' | 'DESTINATION_AMOUNT';

  /** Thunes transaction type. Defaults to `B2C` (the platform business pays a consumer creator). */
  transactionType?: string;

  /** Regulatory purpose-of-remittance code, attached to the transaction when set. */
  purposeOfRemittance?: string;

  /** `fetch` to make requests with. Defaults to the runtime's built-in `fetch`. */
  fetch?: FetchLike;
}

// Captures the per-adapter request machinery (credentials + transport) so the step helpers each take
// it as one argument and stay within the codebase's four-parameter cap.
type Transport = { config: ThunesProcessorConfig; doFetch: FetchLike };

// Doc-derived Thunes error codes for idempotent replay (verify against the live sandbox before
// production). `1007001` rejects a reused external_id — on a retry it means our transaction already
// exists, so recover it. `1007002` rejects confirming an already-confirmed transaction — on a retry
// that is success, the disbursement is already in flight.
const EXTERNAL_ID_IN_USE = '1007001';
const ALREADY_CONFIRMED = '1007002';

// --- The port ---------------------------------------------------------------------

/**
 * Build a {@link Processor} that pays creators over the Thunes Money Transfer v2 rail. It asks Thunes
 * to send money (quotation -> transaction -> confirm); it does not touch our ledger.
 */
export function thunesProcessor(config: ThunesProcessorConfig): Processor {
  let doFetch = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return {
    submitPayout: (input, options) =>
      submitPayout({ config, doFetch }, input, options),
  };
}

// Orchestrate the three Thunes calls behind the single port method. The transaction id minted at
// step 2 is the `providerRef` we return, so confirm only has to succeed — there is no "2xx but no
// reference" ambiguity to resolve. The money moves at confirm; everything before it is safe to redo.
async function submitPayout(
  transport: Transport,
  input: { key: string; userId: string; amount: Amount },
  options?: Options,
): Promise<{ providerRef: string }> {
  let recipient = await transport.config.resolveRecipient(
    input.userId,
    options,
  );
  let quotationId = await createQuotation(
    transport,
    { input, recipient },
    options,
  );
  let transactionId = await createTransaction(
    transport,
    { input, recipient, quotationId },
    options,
  );
  await confirmTransaction(transport, transactionId, options);
  return { providerRef: transactionId };
}

// Step 1 — lock the FX rate. No money moves here, so any non-2xx is surfaced for the worker to retry
// (a reused external_id returns the existing quotation, so a redo is safe). Returns the quotation id.
async function createQuotation(
  transport: Transport,
  draft: {
    input: { key: string; amount: Amount };
    recipient: ThunesRecipient;
  },
  options?: Options,
): Promise<string> {
  let { input, recipient } = draft;
  let res = await request(
    transport,
    {
      method: 'POST',
      path: '/v2/money-transfer/quotations',
      payload: {
        external_id: input.key,
        mode: transport.config.quotationMode ?? 'SOURCE_AMOUNT',
        transaction_type: transport.config.transactionType ?? 'B2C',
        payer_id: recipient.payerId,
        source: wireAmount(input.amount),
        destination: { currency: recipient.destinationCurrency },
      },
    },
    options,
  );
  if (!res.ok) {
    throw httpFault('quotation', res);
  }
  return requireId(res.body, 'quotation');
}

// Step 2 — create the transaction against the quotation, naming the credit party and beneficiary.
// Still pre-confirm (no debit yet). On a reused external_id the transaction already exists from a
// prior attempt, so recover its id instead of failing. Returns the transaction id (the providerRef).
async function createTransaction(
  transport: Transport,
  draft: {
    input: { key: string; userId: string };
    recipient: ThunesRecipient;
    quotationId: string;
  },
  options?: Options,
): Promise<string> {
  let { input, recipient, quotationId } = draft;
  let res = await request(
    transport,
    {
      method: 'POST',
      path: `/v2/money-transfer/quotations/${quotationId}/transactions`,
      payload: {
        external_id: input.key,
        credit_party_identifier: recipient.creditPartyIdentifier,
        sender: transport.config.sender,
        beneficiary: recipient.beneficiary,
        ...(transport.config.purposeOfRemittance === undefined
          ? {}
          : { purpose_of_remittance: transport.config.purposeOfRemittance }),
      },
    },
    options,
  );
  if (res.ok) {
    return requireId(res.body, 'transaction');
  }
  if (errorCodeOf(res.body) === EXTERNAL_ID_IN_USE) {
    return recoverTransactionId(transport, input.key, options);
  }
  throw httpFault('transaction', res);
}

// Step 3 — confirm: the money-movement boundary (debits our Thunes balance, submits to the payer).
// A 2xx settles the submit. An already-confirmed transaction (a retry of a confirm that did go
// through) is success, not failure: the disbursement is already in flight, so let the saga advance.
async function confirmTransaction(
  transport: Transport,
  transactionId: string,
  options?: Options,
): Promise<void> {
  let res = await request(
    transport,
    {
      method: 'POST',
      path: `/v2/money-transfer/transactions/${transactionId}/confirm`,
    },
    options,
  );
  if (res.ok || errorCodeOf(res.body) === ALREADY_CONFIRMED) {
    return;
  }
  throw httpFault('confirm', res);
}

// Recover the transaction id for a key whose external_id Thunes already has (the idempotent-replay
// path). Thunes addresses a transaction by partner reference at `…/transactions/ext-{external_id}`.
async function recoverTransactionId(
  transport: Transport,
  key: string,
  options?: Options,
): Promise<string> {
  let res = await request(
    transport,
    { method: 'GET', path: `/v2/money-transfer/transactions/ext-${key}` },
    options,
  );
  if (!res.ok) {
    throw httpFault('transaction.recover', res);
  }
  return requireId(res.body, 'transaction');
}

// --- The transport call -----------------------------------------------------------

// One parsed Thunes response. `ok`/`status` are the HTTP outcome; `body` is the decoded JSON (or null
// for an empty/non-JSON body). Non-2xx is returned, not thrown, so each step can branch on the error
// code (an idempotent-replay code is success, not a failure).
type ThunesResponse = { ok: boolean; status: number; body: unknown };

// Send one request and parse its body. A failed send or unreadable body is a retryable provider fault
// with the original error attached; the status check itself is left to the caller.
async function request(
  transport: Transport,
  spec: { method: string; path: string; payload?: unknown },
  options?: Options,
): Promise<ThunesResponse> {
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await transport.doFetch(
      `${transport.config.baseUrl}${spec.path}`,
      {
        method: spec.method,
        headers: headersFor(transport.config),
        ...(spec.payload === undefined
          ? {}
          : { body: JSON.stringify(spec.payload) }),
        signal: options?.signal,
      },
    );
  } catch (error) {
    throw transportFault(`Thunes ${spec.method} ${spec.path} request failed.`, {
      cause: error,
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw transportFault(
      `Thunes ${spec.method} ${spec.path} response read failed.`,
      { cause: error },
    );
  }
  return { ok: response.ok, status: response.status, body: parseJson(text) };
}

// --- Inbound settlement callback --------------------------------------------------

/**
 * Map a Thunes Money Transfer transaction callback to the {@link PayoutSettledEvent} the webhook edge
 * already knows how to apply (`toSettlePayout` -> `settlePayout`). Thunes POSTs the full transaction
 * object on every status change; this fires the settle only on the terminal success status
 * (`70000 COMPLETED` / status_class `7`), returning `null` for any in-flight status so the edge can
 * ack `2XX` and wait for the next callback.
 *
 * `external_id` carried our payout saga id (set in {@link thunesProcessor}), so it maps straight to
 * `sagaId`; the Thunes transaction `id` becomes `eventId` (one settle per transaction) and the audit
 * `providerRef`. `providerAmount` is read from the source amount the rail debited — recorded for the
 * audit trail only; `settlePayout` posts the rate-derived figures it recomputes from the reserve.
 *
 * `provider` comes from the webhook route, never the body, so it can't be spoofed.
 */
export function decodeThunesPayoutCallback(
  provider: string,
  body: unknown,
): PayoutSettledEvent | null {
  if (body === null || typeof body !== 'object') {
    throw malformed('Thunes callback body must be a JSON object.');
  }
  let row = body as Record<string, unknown>;
  if (!isCompleted(row)) {
    return null;
  }
  let transactionId = requireId(row, 'transaction');
  return {
    kind: 'payoutSettled',
    provider,
    eventId: transactionId,
    sagaId: requireStringField(row.external_id, 'external_id'),
    providerRef: transactionId,
    providerAmount: sourceAmount(row.source),
  };
}

// True once the transaction has reached the terminal success state. Thunes' `status` is a five-digit
// code whose first digit is the status_class; `70000 COMPLETED` (class 7) is the only success
// terminal, so key on the leading 7 rather than the exact string, which varies by payer.
function isCompleted(row: Record<string, unknown>): boolean {
  let status = row.status;
  return typeof status === 'string' && status.startsWith('7');
}

// Read the source-amount object Thunes echoes (the funds debited from our balance) into a USD Amount.
// economy-lab funds payouts in USD, so the source currency is USD; decode the decimal into the exact
// minor-unit Amount the rest of the system uses.
function sourceAmount(source: unknown): Amount {
  if (source === null || typeof source !== 'object') {
    throw malformed("Thunes callback 'source' must be an amount object.");
  }
  let row = source as Record<string, unknown>;
  let currency = requireStringField(
    row.currency,
    'source.currency',
  ) as Currency;
  let amount = row.amount;
  if (typeof amount !== 'number' && typeof amount !== 'string') {
    throw malformed(
      "Thunes callback 'source.amount' must be a number or string.",
    );
  }
  return decodeAmount(String(amount), currency);
}

// --- Turning requests and responses into and out of JSON --------------------------

// A Thunes amount object: a decimal number plus its ISO currency. economy-lab money is an exact
// minor-unit bigint, so render it through `encodeAmount` (`"USD:12.34"`) and take the decimal part.
// JSON has no bigint, and Thunes' own model carries the amount as a decimal number, so this is the
// one place a money value crosses into a float — bounded to two decimals and well within range for
// any real payout.
function wireAmount(amount: Amount): { amount: number; currency: Currency } {
  let text = encodeAmount(amount);
  let decimal = text.slice(text.indexOf(':') + 1);
  return { amount: Number(decimal), currency: amount.currency };
}

// Pull a resource id out of a Thunes body. Accepts a string or number and stringifies it: Thunes ids
// exceed 32 bits, so a numeric id at the far end risks precision loss in JSON — a body that carries
// the id as a string is preferred. A missing id on a 2xx is an ambiguous provider response; pre-money
// (quotation/transaction) it is treated as retryable so the worker redoes the safe step.
function requireId(body: unknown, step: string): string {
  if (body !== null && typeof body === 'object') {
    let id = (body as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
    if (typeof id === 'number' && Number.isFinite(id)) {
      return String(id);
    }
  }
  throw fault(
    ERROR_CODES.PROVIDER_FAILURE,
    `Thunes ${step} response is missing an id.`,
    { retryable: true, detail: { step } },
  );
}

// Thunes' error envelope is `{ errors: [{ code, message }] }`; return the first code (as a string) or
// undefined. Used to spot the idempotent-replay codes among non-2xx responses.
function errorCodeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  let errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }
  let code = (errors[0] as { code?: unknown }).code;
  return code === undefined ? undefined : String(code);
}

// Parse a response body as JSON, tolerating an empty or non-JSON body (returned as null) — a confirm
// can answer 2xx with no body, and an error page may not be JSON.
function parseJson(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- Local helpers ----------------------------------------------------------------

// Request headers: JSON content-type/accept plus HTTP Basic authorization. The credentials are
// base64'd here and never placed in an error's detail.
function headersFor(config: ThunesProcessorConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Basic ${btoa(`${config.apiKey}:${config.apiSecret}`)}`,
  };
}

// Fault for a non-2xx Thunes response. `429` and `5xx` are transient (retryable); other statuses are
// terminal, so the worker stops re-submitting and reverses the reserve rather than burning attempts.
// The step, status, and Thunes error code are recorded for diagnostics; no credentials are included.
function httpFault(step: string, res: ThunesResponse) {
  let transient = res.status === 429 || res.status >= 500;
  return fault(
    ERROR_CODES.PROVIDER_FAILURE,
    `Thunes ${step} returned a ${res.status} status.`,
    {
      retryable: transient,
      detail: { step, status: res.status, code: errorCodeOf(res.body) },
    },
  );
}

// Fault for an infrastructure failure (request couldn't be sent or body couldn't be read). Always
// retryable; the underlying error is normalized and attached as `cause` for logs.
function transportFault(message: string, options: { cause: unknown }) {
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause: normalizeError(options.cause),
    retryable: true,
  });
}

// Required string field on an inbound callback, or a malformed-event fault naming the field — the
// same edge-rejection stance `decodeWebhookEvent` takes, so the server answers 400 rather than 500.
function requireStringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw malformed(
      `Thunes callback field '${field}' must be a non-empty string.`,
    );
  }
  return value;
}

// A wrong-shape callback body is a bad request at the edge (MALFORMED_OPERATION -> 400), matching
// `decodeWebhookEvent`'s `malformedEvent`.
function malformed(message: string) {
  return fault(ERROR_CODES.MALFORMED_OPERATION, message);
}
