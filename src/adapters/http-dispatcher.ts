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
import { encodeEvent } from '#src/adapters/event-wire.ts';

import type { Dispatcher, EconomyEvent, Options } from '#src/ports.ts';

// --- Outbound dispatcher (HTTP transport) -----------------------------------------

export interface HttpDispatcherConfig {
  /**
   * The consumer endpoint each event is POSTed to. This is your event bus or webhook receiver. The
   * lab is the producer, and the receiver is out of scope. `https://bus.internal/economy` is a
   * placeholder.
   */
  url: string;

  /**
   * Supplies the `fetch` implementation. Defaults to the global `fetch`, which avoids any
   * node-specific dependency. Tests pass a stand-in.
   */
  fetch?: typeof fetch;
}

/**
 * Builds the {@link Dispatcher} that POSTs one economy event to a remote endpoint over HTTP. HTTP is
 * one of two delivery paths (the alternative is SQS); both POST the identical body through the shared
 * `encodeEvent` (event-wire.ts).
 *
 * A network error or a non-2xx response throws a retryable `PROVIDER.FAILURE`, so the relay
 * redelivers later with backoff. Because a retry can duplicate an event, the event id goes in an
 * `Idempotency-Key` header for the receiver to dedupe.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging} for the outbox-to-relay flow, the dispatcher port, and at-least-once delivery.
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

// Wraps a failed dispatch as a retryable `PROVIDER.FAILURE` and keeps the original error as
// `cause`. Mirrors the SQS dispatcher's transportFault.
function transportFault(message: string, error: unknown): Error {
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause: normalizeError(error),
    retryable: true,
  });
}
