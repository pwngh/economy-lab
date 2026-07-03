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
 * A {@link Processor} backed by the Thunes Money Transfer v2 API (the cross-border payout rail). It
 * hides Thunes' three-step quotation -> transaction -> confirm flow behind the single port method,
 * returning the transaction id as `providerRef`; settlement comes back via
 * {@link decodeThunesPayoutCallback}.
 *
 * Idempotency rides on `external_id = key` (the payout saga id), and the worker
 * (`src/worker/payouts.ts`) owns retry/backoff/attempt-capping, so each call here is a single attempt
 * that throws a retryable {@link ERROR_CODES.PROVIDER_FAILURE} on transient failure.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for the
 *   three-step flow, the confirm money-movement boundary, and the idempotent-replay handling.
 */

import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';
import { decodeAmount, encodeAmount } from '#src/money.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { Options, Processor } from '#src/ports.ts';
import type { PayoutSettledEvent } from '#src/webhooks.ts';
import type { FetchLike } from '#src/adapters/processor.ts';

// --- Recipient resolution ---------------------------------------------------------

/**
 * The Thunes-specific routing for one payout, resolved from economy-lab's opaque `usr_...` token. The
 * port carries only `userId`; Thunes needs the destination service (`payerId`) and the credit-party
 * details, which live in the host's beneficiary/KYC store, never in this adapter. The host supplies a
 * {@link ResolveRecipient} that maps a user id to this shape.
 */
export interface ThunesRecipient {
  // The Thunes payer id, which names the destination service: a specific mobile wallet or bank in the
  // receiving country. The host discovers it via `GET /v2/money-transfer/payers` and usually caches it.
  payerId: string;

  // How the funds reach the beneficiary, using the identifiers the chosen payer accepts. A mobile
  // wallet takes `{ msisdn }`; a bank takes `{ bank_account_number, swift_bic_code }`.
  creditPartyIdentifier: Record<string, string>;

  // The beneficiary entity fields the chosen payer requires, such as name and country. These pass
  // through to Thunes verbatim. The required set is payer-specific, so the host shapes it, not this
  // adapter.
  beneficiary: Record<string, unknown>;

  // ISO 4217 code of the currency the beneficiary is paid in. This is the quotation's destination
  // currency.
  destinationCurrency: string;
}

/**
 * Resolves an economy-lab `userId` to its Thunes routing. Host-supplied; backed by a
 * KYC/beneficiary store.
 */
export type ResolveRecipient = (
  userId: string,
  options?: Options,
) => Promise<ThunesRecipient>;

// --- Configuration ----------------------------------------------------------------

export interface ThunesProcessorConfig {
  /** Thunes API gateway base URL (scheme + host), e.g. `https://api.thunes.com`. */
  baseUrl: string;

  /** API key, the user-id half of Thunes' HTTP Basic credentials. Never written to logs or errors. */
  apiKey: string;

  /** API secret, the password half of the Basic credentials. Never written to logs or errors. */
  apiSecret: string;

  /**
   * The sending party for the transaction. economy-lab pays creators on the platform's behalf, so
   * this is the platform's sending business (a B2C transfer). Passed through to Thunes verbatim.
   */
  sender: Record<string, unknown>;

  /** Maps a payout's `userId` to its Thunes routing (payer + credit party + beneficiary). */
  resolveRecipient: ResolveRecipient;

  /**
   * Quotation mode. `SOURCE_AMOUNT` (the default) fixes the USD we send and lets Thunes compute
   * the destination.
   */
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
// production). `1007001` rejects a reused external_id. On a retry it means our transaction already
// exists, so recover it. `1007002` rejects confirming an already-confirmed transaction. On a retry
// that is success, because the disbursement is already in flight.
const EXTERNAL_ID_IN_USE = '1007001';
const ALREADY_CONFIRMED = '1007002';

// --- The port ---------------------------------------------------------------------

/**
 * Build a {@link Processor} that pays creators over the Thunes Money Transfer v2 rail. It asks Thunes
 * to send money (quotation -> transaction -> confirm); it does not touch our ledger.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for the
 *   payout-rail seam and dispute handling.
 */
export function thunesProcessor(config: ThunesProcessorConfig): Processor {
  const doFetch = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return {
    submitPayout: (input, options) =>
      submitPayout({ config, doFetch }, input, options),
  };
}

// Orchestrates the three Thunes calls behind the single port method. The transaction id minted at
// step 2 is the `providerRef` we return, so confirm only has to succeed: there is no "2xx but no
// reference" ambiguity to resolve. The money moves at confirm, and everything before it is safe to
// redo.
async function submitPayout(
  transport: Transport,
  input: { key: string; userId: string; amount: Amount },
  options?: Options,
): Promise<{ providerRef: string }> {
  const recipient = await transport.config.resolveRecipient(
    input.userId,
    options,
  );
  const quotationId = await createQuotation(
    transport,
    { input, recipient },
    options,
  );
  const transactionId = await createTransaction(
    transport,
    { input, recipient, quotationId },
    options,
  );
  await confirmTransaction(transport, transactionId, options);
  return { providerRef: transactionId };
}

// Step 1, locking the FX rate. No money moves here, so any non-2xx is surfaced for the worker to
// retry. A reused external_id returns the existing quotation, so a redo is safe. Returns the
// quotation id.
async function createQuotation(
  transport: Transport,
  draft: {
    input: { key: string; amount: Amount };
    recipient: ThunesRecipient;
  },
  options?: Options,
): Promise<string> {
  const { input, recipient } = draft;
  const res = await request(
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

// Step 2, creating the transaction against the quotation, naming the credit party and beneficiary.
// This is still pre-confirm, so no debit happens yet. On a reused external_id the transaction already
// exists from a prior attempt, so recover its id instead of failing. Returns the transaction id (the
// providerRef).
async function createTransaction(
  transport: Transport,
  draft: {
    input: { key: string; userId: string };
    recipient: ThunesRecipient;
    quotationId: string;
  },
  options?: Options,
): Promise<string> {
  const { input, recipient, quotationId } = draft;
  const res = await request(
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

// Step 3, the confirm. This is the money-movement boundary: it debits our Thunes balance and submits
// to the payer. A 2xx settles the submit. An already-confirmed transaction is a retry of a confirm
// that did go through, which is success, not failure: the disbursement is already in flight, so let
// the saga advance.
async function confirmTransaction(
  transport: Transport,
  transactionId: string,
  options?: Options,
): Promise<void> {
  const res = await request(
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

// Recovers the transaction id for a key whose external_id Thunes already has. This is the
// idempotent-replay path. Thunes addresses a transaction by partner reference at
// `.../transactions/ext-{external_id}`.
async function recoverTransactionId(
  transport: Transport,
  key: string,
  options?: Options,
): Promise<string> {
  const res = await request(
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

// Sends one request and parses its body. A failed send or an unreadable body becomes a retryable
// provider fault with the original error attached. The status check itself is left to the caller.
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
 * Map a Thunes transaction callback to the {@link PayoutSettledEvent} the webhook edge applies. Fires
 * the settle only on the terminal success status (`70000 COMPLETED` / status_class `7`); returns
 * `null` for any in-flight status so the edge acks `2XX` and waits for the next callback.
 *
 * `providerAmount` (the rail-debited source) is recorded for audit only: `settlePayout` posts the
 * rate-derived figures it recomputes from the reserve, not this. `provider` comes from the webhook
 * route, never the body, so it can't be spoofed.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for settlement
 *   and the settle event.
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   the webhook edge.
 */
export function decodeThunesPayoutCallback(
  provider: string,
  body: unknown,
): PayoutSettledEvent | null {
  if (body === null || typeof body !== 'object') {
    throw malformed('Thunes callback body must be a JSON object.');
  }
  const row = body as Record<string, unknown>;
  if (!isCompleted(row)) {
    return null;
  }
  const transactionId = requireId(row, 'transaction');
  return {
    kind: 'payoutSettled',
    provider,
    eventId: transactionId,
    sagaId: requireStringField(row.external_id, 'external_id'),
    providerRef: transactionId,
    providerAmount: sourceAmount(row.source),
  };
}

// Reports whether the transaction has reached the terminal success state. Thunes' `status` is a
// five-digit code whose first digit is the status_class. `70000 COMPLETED` (class 7) is the only
// success terminal, so key on the leading 7 rather than the exact string, which varies by payer.
function isCompleted(row: Record<string, unknown>): boolean {
  const status = row.status;
  return typeof status === 'string' && status.startsWith('7');
}

// Reads the source-amount object Thunes echoes, the funds debited from our balance, into a USD Amount.
// economy-lab funds payouts in USD, so the source currency is USD. Decode the decimal into the exact
// minor-unit Amount the rest of the system uses.
function sourceAmount(source: unknown): Amount {
  if (source === null || typeof source !== 'object') {
    throw malformed("Thunes callback 'source' must be an amount object.");
  }
  const row = source as Record<string, unknown>;
  const currency = requireStringField(
    row.currency,
    'source.currency',
  ) as Currency;
  const amount = row.amount;
  if (typeof amount !== 'number' && typeof amount !== 'string') {
    throw malformed(
      "Thunes callback 'source.amount' must be a number or string.",
    );
  }
  return decodeAmount(String(amount), currency);
}

// --- Turning requests and responses into and out of JSON --------------------------

// Builds a Thunes amount object: a decimal number plus its ISO currency. economy-lab money is an
// exact minor-unit bigint, so render it through `encodeAmount` (`"USD:12.34"`) and take the decimal
// part. JSON has no bigint, and Thunes' own model carries the amount as a decimal number, so this is
// the one place a money value crosses into a float. The value is bounded to two decimals and stays
// well within range for any real payout.
function wireAmount(amount: Amount): { amount: number; currency: Currency } {
  const text = encodeAmount(amount);
  const decimal = text.slice(text.indexOf(':') + 1);
  return { amount: Number(decimal), currency: amount.currency };
}

// Pulls a resource id out of a Thunes body. Accepts a string or number and stringifies it. Thunes ids
// exceed 32 bits, so a numeric id risks precision loss in JSON; a body that carries the id as a string
// is preferred. A missing id on a 2xx is an ambiguous provider response. On a pre-money step
// (quotation or transaction) it is treated as retryable so the worker redoes the safe step.
function requireId(body: unknown, step: string): string {
  if (body !== null && typeof body === 'object') {
    const id = (body as { id?: unknown }).id;
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

// Returns the first error code as a string, or undefined. Thunes' error envelope is
// `{ errors: [{ code, message }] }`. This is used to spot the idempotent-replay codes among non-2xx
// responses.
function errorCodeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }
  const code = (errors[0] as { code?: unknown }).code;
  return code === undefined ? undefined : String(code);
}

// Parses a response body as JSON, tolerating an empty or non-JSON body by returning null. A confirm
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

// Builds the request headers: JSON content-type and accept, plus HTTP Basic authorization. The
// credentials are base64'd here and never placed in an error's detail.
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
  const transient = res.status === 429 || res.status >= 500;
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

// Reads a required string field from an inbound callback, or throws a malformed-event fault naming the
// field. This matches the edge-rejection stance `decodeWebhookEvent` takes, so the server answers 400
// rather than 500.
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
