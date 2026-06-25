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
 * Structural `fetch` signature this adapter needs. Described by shape rather than the
 * built-in type so it can be injected (production passes the real `fetch`, tests pass a
 * stand-in) and runs on any runtime (Node, Bun, Deno, Cloudflare Workers).
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
   * Optional secret token sent in the Authorization header on every request. Never
   * written to logs or error details.
   */
  apiKey?: string;

  /** `fetch` to make requests with. Defaults to the runtime's built-in `fetch`. */
  fetch?: FetchLike;
}

/**
 * Build a {@link Processor} that pays creators via an external provider (e.g. a payment
 * processor) over HTTP. It asks the provider to send money; it does not touch our ledger.
 *
 * `submitPayout` POSTs a request carrying:
 * - `key`, idempotency key so a resend (e.g. after a retry) pays out only once;
 * - `userId`, opaque recipient token, no personal information;
 * - `amount`, USD to pay, as a decimal string.
 *
 * It reads back the provider's reference id. A failed send or non-2xx status is a
 * retryable failure. A 2xx with no reference id is non-retryable: the money may already
 * have been sent, so retrying could pay twice; reconciliation resolves the ambiguity.
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
  // Submit the payout. If `fetch` throws (DNS failure, connection reset, abort), wrap it as
  // a retryable failure with the original error attached.
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

  // Read the body before checking status, so a non-2xx error can carry it. A mid-download
  // drop is the same kind of network problem as a failed request: retryable.
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

// JSON request body: idempotency key, opaque user token (only a `usr_`-style token reaches
// a provider, never personal data), and USD amount. The amount goes through `encodeAmount`
// to a decimal string like `"USD:12.34"`, since it's a `bigint` and `JSON.stringify` can't
// serialize a `bigint`.
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

// Pull the provider's reference id out of a 2xx body. Must be JSON with a non-empty
// `providerRef` string. Invalid JSON or a missing/blank field is non-retryable: the payout
// may already have gone through, so retrying could pay twice; reconciliation resolves it.
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

// Request headers: JSON content-type, plus an Authorization header when an API key is
// configured. The key goes only here, never into an error's detail.
function headersFor(config: HttpProcessorConfig): Record<string, string> {
  let headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== undefined) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

// Error for an infrastructure failure (request couldn't be sent, body couldn't be read, or
// non-2xx status). Always retryable. The underlying error is normalized and attached as
// `cause`; status and body, when present, are recorded for diagnostics.
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
