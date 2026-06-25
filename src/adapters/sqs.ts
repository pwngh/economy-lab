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
 * Structural shape of the one SQS client method this adapter calls, so the file compiles
 * without `@aws-sdk/client-sqs` installed (optional dependency). Captures only what we use:
 * a command holding `input` plus an optional `abortSignal`. A real `SQSClient` satisfies it.
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

// Wraps the SendMessage body in the `{ input }` shape `send` expects, replacing the SDK's
// `new SendMessageCommand(input)`. Field names (QueueUrl, MessageBody, ...) are SQS's own.
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
  /** The queue to send to, e.g. `https://sqs.<region>.amazonaws.com/<acct>/<name>`. */
  queueUrl: string;

  /** The SQS client the caller created and owns (a real one, or a test stand-in). */
  client: SqsClient;
}

/**
 * Build the dispatcher that publishes events to SQS as JSON messages.
 *
 * On failure throws a retryable `PROVIDER.FAILURE` so the caller's backoff wrapper retries.
 * The event id is attached so the receiver can drop duplicates (SQS may deliver twice).
 */
export function sqsDispatcher(config: SqsDispatcherConfig): Dispatcher {
  let client = config.client;
  // FIFO-only params (MessageGroupId/MessageDeduplicationId) draw InvalidParameterValue on a
  // standard queue, so decide once from the URL suffix and attach them only for FIFO queues.
  // The documented deployment (.env.example) uses a standard queue.
  let fifo = config.queueUrl.endsWith('.fifo');

  return async (event: EconomyEvent, options?: Options): Promise<void> => {
    try {
      await client.send(
        sendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: encodeEvent(event),
          // FIFO only: SQS drops a second message with the same dedup id, so tagging by event
          // id makes a resend a no-op. Messages sharing a group id deliver in order; group by
          // subject.
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

// Wrap a failed SQS call as a retryable `PROVIDER.FAILURE`. `normalizeError` keeps the
// original error as `cause`.
function transportFault(message: string, error: unknown): Error {
  let normalized = normalizeError(error);
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause: normalized,
    retryable: true,
  });
}
