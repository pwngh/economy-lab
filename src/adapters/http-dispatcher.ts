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

import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';

import type { Dispatcher, EconomyEvent, Options } from '#src/ports.ts';

// --- Outbound dispatcher (HTTP transport) -----------------------------------------

export interface HttpDispatcherConfig {
  /** The endpoint each event is POSTed to, e.g. `https://bus.internal/economy`. */
  url: string;

  /**
   * fetch implementation. Defaults to the global `fetch` (no node-specific dependency);
   * tests pass a stand-in.
   */
  fetch?: typeof fetch;
}

/**
 * Build the function that POSTs one economy event to a remote endpoint over HTTP.
 *
 * Events land in an outbox table in the same transaction as the money move that produced them;
 * the relay worker reads that table and calls this to deliver each. HTTP is one delivery path;
 * SQS is the alternative; `SQS_QUEUE_URL` selects SQS and wins if both are set, otherwise
 * `DISPATCHER_URL` selects this HTTP path. Each call POSTs one event as JSON in the
 * same field layout the SQS adapter uses, so the receiver sees one shape either way.
 *
 * A network error or non-2xx response throws a retryable `PROVIDER.FAILURE`, so the relay
 * redelivers later with backoff. Since retries can duplicate, the event id goes in an
 * `Idempotency-Key` header for the receiver to dedupe (SQS does the same via
 * `MessageDeduplicationId`).
 */
export function httpDispatcher(config: HttpDispatcherConfig): Dispatcher {
  let send = config.fetch ?? fetch;

  return async (event: EconomyEvent, options?: Options): Promise<void> => {
    let response: Response;
    try {
      response = await send(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': event.id,
        },
        body: encodeEvent(event),
        signal: options?.signal,
      });
    } catch (error) {
      throw transportFault('HTTP dispatch request failed.', error);
    }
    if (!response.ok) {
      throw transportFault(
        `HTTP dispatch returned a non-2xx status (${response.status}).`,
        undefined,
      );
    }
  };
}

// Encode the request body. Fields and names match the SQS adapter so the receiver sees the
// same shape regardless of delivery path.
function encodeEvent(event: EconomyEvent): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    version: event.version,
    occurredAt: event.occurredAt,
    subject: event.subject,
    data: event.data,
    audience: event.audience,
  });
}

// Wrap a failed dispatch as a retryable `PROVIDER.FAILURE`, keeping the original error as
// `cause`. Mirrors the SQS dispatcher's transportFault.
function transportFault(message: string, error: unknown): Error {
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause: normalizeError(error),
    retryable: true,
  });
}
