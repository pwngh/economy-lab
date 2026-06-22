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

// --- The @aws-sdk/client-sqs surface, typed structurally --------------------------

/**
 * The one method this adapter calls on an AWS SQS client. We describe it by its shape
 * here, rather than importing the `@aws-sdk/client-sqs` package, so this file still
 * compiles when that package isn't installed (it is an optional dependency). The real
 * `SQSClient.send` accepts many command types; this captures just what we use — a
 * command object holding an `input`, plus an optional `abortSignal` to cancel the call.
 * A real `SQSClient` satisfies this shape, so callers can pass one (or a test stand-in).
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

// Wraps the SQS SendMessage request body in the `{ input }` shape `send` expects, standing
// in for the SDK's `new SendMessageCommand(input)` so this file never imports the SDK. The
// field names (QueueUrl, MessageBody, ...) are SQS's own request parameter names.
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
 * Build the function that publishes events to SQS. Each call turns one event into JSON
 * and sends it as an SQS message.
 *
 * If the send fails, it throws a `PROVIDER.FAILURE` error marked retryable, so the
 * caller's retry-with-backoff wrapper will try again later. The event's id is attached
 * to the message so the receiver can recognize and drop a duplicate (SQS may deliver the
 * same message more than once).
 */
export function sqsDispatcher(config: SqsDispatcherConfig): Dispatcher {
  let client = config.client;
  // FIFO-only request params (MessageGroupId/MessageDeduplicationId) are rejected by
  // SQS with InvalidParameterValue on a standard queue, so decide once at build time
  // from the queue URL suffix and only attach them when the queue is FIFO. The
  // documented deployment uses a standard queue (.env.example), so omitting them there
  // is what keeps events deliverable.
  let fifo = config.queueUrl.endsWith('.fifo');

  return async (event: EconomyEvent, options?: Options): Promise<void> => {
    try {
      await client.send(
        sendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: encodeEvent(event),
          // FIFO only: SQS drops a second message that carries the same dedup id, so
          // tagging each message with the event id means a resend of the same event is
          // ignored rather than delivered twice. Messages sharing a group id are delivered
          // in order, so we group by the subject the event is about.
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

// --- Serialization ----------------------------------------------------------------

// Turn an event into the JSON string sent as the message body. The fields are written in
// a fixed order so the same event always produces the same bytes, which lets a receiver
// recognize a duplicate by comparing message contents. Money amounts inside `data` were
// already converted to strings before reaching here, so this never has to serialize a
// bigint (JSON.stringify would throw on one, which is preferable to sending a broken body).
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

// --- Local helpers ----------------------------------------------------------------

// Wrap any failed SQS call as a `PROVIDER.FAILURE` error marked retryable, so the
// caller's retry logic tries it again. `normalizeError` keeps the original SQS error
// attached as the `cause` so it isn't lost.
function transportFault(message: string, error: unknown): Error {
  let normalized = normalizeError(error);
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause: normalized,
    retryable: true,
  });
}
