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

import { encodeAmount } from '#src/money.ts';
import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';

import type { Amount } from '#src/money.ts';
import type { Options, Processor } from '#src/ports.ts';

/**
 * The shape of the `fetch` function this adapter needs. It is described by its signature
 * rather than the built-in `fetch` type so the function can be passed in: production
 * passes the platform's real `fetch`, and tests pass a stand-in. Keeping it structural
 * also lets the same code run on any JavaScript runtime (Node, Bun, Deno, Cloudflare
 * Workers) without depending on a runtime-specific `fetch` type.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface HttpProcessorConfig {
  /** The URL of the payment provider's payout endpoint that requests are POSTed to. */
  endpoint: string;

  /**
   * Optional secret token sent in the Authorization header on every request to prove
   * who we are to the provider. It is never written to logs or error details.
   */
  apiKey?: string;

  /**
   * The `fetch` function to make requests with. Defaults to the runtime's built-in
   * `fetch`, so production code does not have to supply one; tests pass a stand-in.
   */
  fetch?: FetchLike;
}

/**
 * Build a {@link Processor} that pays creators by calling an external payment provider
 * (such as Tilia, Steam, or Meta) over HTTP. A Processor's one job is to ask the
 * provider to send real money; it does not touch our own ledger.
 *
 * Its `submitPayout` method POSTs a payout request carrying:
 * - `key`, an idempotency key the provider uses to ensure that if we send the same
 *   request twice (for example after a retry), it pays out only once;
 * - `userId`, an opaque token that identifies the recipient without revealing any
 *   personal information; and
 * - `amount`, the USD to pay, sent as a decimal string.
 *
 * It then reads back the provider's reference id for the payout. If the request fails
 * to send or the provider answers with a non-2xx status, that is reported as a
 * retryable failure so the caller can try again. But if the provider answers 2xx yet
 * the body has no reference id, that is reported as a non-retryable failure: the money
 * may already have been sent, so retrying could pay twice — sorting out that ambiguity
 * is left to a later reconciliation step, not a blind retry.
 */
export function httpProcessor(config: HttpProcessorConfig): Processor {
  let doFetch = config.fetch ?? (globalThis.fetch as unknown as FetchLike);

  return {
    submitPayout: async (input, options) =>
      submitPayout(config, doFetch, input, options),
  };
}

async function submitPayout(
  config: HttpProcessorConfig,
  doFetch: FetchLike,
  input: { key: string; userId: string; amount: Amount },
  options?: Options,
): Promise<{ providerRef: string }> {
  // Make the single HTTP request that submits the payout. If `fetch` itself throws (DNS
  // lookup failed, the connection was reset, the request was aborted), wrap it as a retryable
  // failure that keeps the original error attached, so the caller can try again instead of
  // treating a temporary network glitch as permanent.
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await doFetch(config.endpoint, {
      method: 'POST',
      headers: headersFor(config),
      body: encodeRequest(input),
      signal: options?.signal,
    });
  } catch (error) {
    throw transportFault('Processor submitPayout request failed.', {
      cause: error,
    });
  }

  // Read the body as text before checking the status, so a non-2xx error can carry it.
  // Reading can fail partway through (the connection drops mid-download); that is the same kind
  // of temporary network problem as the request failing, so report it as a retryable failure.
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw transportFault('Processor submitPayout response read failed.', {
      cause: error,
    });
  }

  if (!response.ok) {
    throw transportFault('Processor submitPayout returned a non-2xx status.', {
      status: response.status,
      body,
    });
  }
  return { providerRef: parseProviderRef(body) };
}

// --- Turning the request and response into and out of JSON ------------------------

// Build the JSON request body sent to the provider. It carries the idempotency key, the
// opaque user token (never any personal data — only a `usr_`-style token reaches a
// provider), and the USD amount. The amount goes through `encodeAmount`, which turns it
// into a decimal string like `"USD:12.34"`, because the amount is stored as a `bigint`
// and `JSON.stringify` cannot serialize a `bigint` directly.
function encodeRequest(input: {
  key: string;
  userId: string;
  amount: Amount;
}): string {
  return JSON.stringify({
    key: input.key,
    userId: input.userId,
    amount: encodeAmount(input.amount),
  });
}

// Pull the provider's reference id out of a successful (2xx) response body. The body must
// be JSON containing a non-empty `providerRef` string. If it is not valid JSON, or that
// field is missing or blank, report a non-retryable failure: the payout may already have
// gone through, so retrying could pay the recipient twice. Resolving that uncertainty is
// a job for the separate reconciliation step, not a blind retry here.
function parseProviderRef(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw fault(
      ERROR_CODES.PROVIDER_FAILURE,
      'Processor submitPayout body is not JSON.',
      { cause: error, retryable: false },
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { providerRef?: unknown }).providerRef !== 'string' ||
    (parsed as { providerRef: string }).providerRef.length === 0
  ) {
    throw fault(
      ERROR_CODES.PROVIDER_FAILURE,
      'Processor submitPayout body is missing providerRef.',
      { retryable: false, detail: { body } },
    );
  }
  return (parsed as { providerRef: string }).providerRef;
}

// --- Local helpers ----------------------------------------------------------------

// Build the request headers: declare the body is JSON, and, if an API key is configured,
// add an Authorization header carrying it. The key is only ever placed here; it is never
// copied into an error's detail, which must stay free of secrets.
function headersFor(config: HttpProcessorConfig): Record<string, string> {
  let headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== undefined) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

// Build the error thrown when a payout request fails for an infrastructure reason (the
// request couldn't be sent, the body couldn't be read, or the provider returned a non-2xx
// status). It is always marked retryable so the caller will try again. The optional
// underlying error is run through `normalizeError` and kept attached as the `cause`; the
// HTTP status and response body, when present, are recorded for diagnostics.
function transportFault(
  message: string,
  options: { cause?: unknown; status?: number; body?: string },
) {
  let cause =
    options.cause === undefined ? undefined : normalizeError(options.cause);
  let detail: Record<string, unknown> = {};
  if (options.status !== undefined) {
    detail.status = options.status;
  }
  if (options.body !== undefined) {
    detail.body = options.body;
  }
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause,
    retryable: true,
    detail,
  });
}
