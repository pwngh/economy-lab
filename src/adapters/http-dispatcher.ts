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
   * The fetch implementation to use. Defaults to the platform's global `fetch`, so the
   * adapter pulls in no node-specific dependency; a test passes a stand-in here.
   */
  fetch?: typeof fetch;
}

/**
 * Build the function that sends one economy event to a remote endpoint over HTTP.
 *
 * Events are first saved to a database table (the "outbox") in the same transaction as the
 * money move that produced them; a background worker (the "relay") then reads that table and
 * calls this function to deliver each one. This is the HTTP delivery path; the SQS adapter is
 * an alternative path the relay can use instead, chosen by the `DISPATCHER_URL` setting. Each
 * call POSTs one event as JSON, in the same field layout the SQS adapter uses so the receiver
 * sees one shape regardless of which path delivered it.
 *
 * On a network error or any non-2xx response, this throws a `PROVIDER.FAILURE` error marked
 * retryable, which tells the relay to deliver it again later (with increasing delays between
 * tries). Because the relay can retry, the same event may arrive more than once; to let the
 * receiver drop a repeat, the event's id is sent in an `Idempotency-Key` header — the receiver
 * remembers ids it has already handled and ignores a second copy. (The SQS path achieves the
 * same de-duplication with its `MessageDeduplicationId`.)
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

// Turn an event into the JSON text sent in the request body. The selected fields and their
// names are kept identical to the SQS adapter's encoding so a receiver sees the same shape no
// matter which delivery path sent it.
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

// Wrap a failed dispatch as a retryable `PROVIDER.FAILURE`, keeping the original error as the
// `cause` so logs don't lose it. Mirrors the SQS dispatcher's transportFault.
function transportFault(message: string, error: unknown): Error {
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause: normalizeError(error),
    retryable: true,
  });
}
