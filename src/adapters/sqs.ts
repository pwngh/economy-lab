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

// --- The @aws-sdk/client-sqs surface, typed structurally --------------------------

/**
 * Structural shape of the one SQS client method this adapter calls, so the file compiles without
 * the optional `@aws-sdk/client-sqs` dependency installed. A real `SQSClient` satisfies it.
 */
export interface SqsCommand {
  readonly input: Record<string, unknown>;
}
export interface SqsClient {
  send(
    command: SqsCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

// Stands in for the SDK's `new SendMessageCommand(input)`; the field names are SQS's own.
function sendMessageCommand(input: {
  QueueUrl: string;
  MessageBody: string;
  MessageDeduplicationId?: string;
  MessageGroupId?: string;
}): SqsCommand {
  return { input };
}

// --- Outbound dispatcher ----------------------------------------------------------

export interface SqsDispatcherConfig {
  queueUrl: string;

  /** The SQS client the caller created and owns (a real one, or a test stand-in). */
  client: SqsClient;
}

/**
 * Builds the dispatcher that publishes events to SQS as JSON messages.
 *
 * On failure it throws a retryable `PROVIDER.FAILURE` so the caller's backoff wrapper retries.
 * The event id is attached so the receiver can drop duplicates, because SQS may deliver twice.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/messaging/ Messaging} for how dispatchers deliver events.
 */
export function sqsDispatcher(config: SqsDispatcherConfig): Dispatcher {
  const client = config.client;
  // The FIFO-only params (MessageGroupId, MessageDeduplicationId) draw InvalidParameterValue on a
  // standard queue, so attach them only when the URL suffix says FIFO.
  const fifo = config.queueUrl.endsWith('.fifo');

  return async (event: EconomyEvent, options?: Options): Promise<void> => {
    try {
      await client.send(
        sendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: encodeEvent(event),
          // Dedup by event id so a resend is a no-op; group by subject so a subject's events
          // deliver in order.
          ...(fifo && {
            MessageDeduplicationId: event.id,
            MessageGroupId: event.subject,
          }),
        }),
        { abortSignal: options?.signal },
      );
    } catch (error) {
      throw transportFault('SQS SendMessage failed.', error);
    }
  };
}

// --- Local helpers ----------------------------------------------------------------

function transportFault(message: string, error: unknown): Error {
  const normalized = normalizeError(error);
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause: normalized,
    retryable: true,
  });
}
