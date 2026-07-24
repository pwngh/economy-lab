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
import type {
  CallOptions,
  PayoutProviderStatus,
  Processor,
} from '#src/ports.ts';

/**
 * Structural `fetch` shape rather than the built-in type, so tests can inject a stand-in and the
 * file typechecks on any runtime.
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
  /** The provider URL each payout submission is POSTed to. */
  endpoint: string;

  /** Sent in the Authorization header. Never written to logs or error details. */
  apiKey?: string;

  /** Supplies the `fetch` implementation. Defaults to the global `fetch`; tests pass a stand-in. */
  fetch?: FetchLike;
}

/**
 * Build a {@link Processor} that pays sellers via an external provider over HTTP. It asks the
 * provider to send money; it does not touch our ledger.
 *
 * `submitPayout` POSTs `{ key, userId, amount }`: the idempotency key (a resend pays out only
 * once), an opaque recipient token (no personal information), and the USD to pay as a decimal
 * string. It reads back the provider's reference id. A failed send or non-2xx status is
 * retryable. A 2xx with no reference id is non-retryable: the money may already have been sent,
 * so retrying could pay twice; reconciliation resolves the ambiguity.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for how the
 *   payout port plugs into the ledger.
 */
export function httpProcessor(config: HttpProcessorConfig): Processor {
  const doFetch = config.fetch ?? (globalThis.fetch as unknown as FetchLike);

  return {
    submitPayout: async (input, options) =>
      submitPayout(config, doFetch, input, options),
  };
}

/**
 * An in-memory {@link Processor} for demos and tests: it accepts every payout, records it under a
 * deterministic `providerRef`, and answers a resend of the same idempotency key with the same ref,
 * so the retry-safety contract holds without a real provider. Pass `status` to make the optional
 * probe report a fixed state (e.g. `'SETTLED'` so a demo sweep settles without a webhook); omitted,
 * there is no probe, matching a real provider that reports only by webhook.
 */
export function memoryProcessor(
  options: { status?: PayoutProviderStatus['state'] } = {},
): Processor {
  const refByKey = new Map<string, string>();
  const processor: Processor = {
    submitPayout: (input) => {
      const existing = refByKey.get(input.key);
      if (existing !== undefined) {
        return Promise.resolve({ providerRef: existing });
      }
      const providerRef = `mem_${refByKey.size + 1}`;
      refByKey.set(input.key, providerRef);
      return Promise.resolve({ providerRef });
    },
  };
  if (options.status !== undefined) {
    const state = options.status;
    processor.payoutStatus = () => Promise.resolve({ state });
  }
  return processor;
}

async function submitPayout(
  config: HttpProcessorConfig,
  doFetch: FetchLike,
  input: { key: string; userId: string; amount: Amount },
  options?: CallOptions,
): Promise<{ providerRef: string }> {
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

function headersFor(config: HttpProcessorConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (config.apiKey !== undefined) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function transportFault(
  message: string,
  options: { cause?: unknown; status?: number; body?: string },
) {
  const cause =
    options.cause === undefined ? undefined : normalizeError(options.cause);
  const detail: Record<string, unknown> = {};
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
