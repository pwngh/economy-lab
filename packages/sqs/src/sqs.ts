/**
 * @pwngh/economy-sqs
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { transportFault } from '@pwngh/economy-lab/adapters';
import { encodeEvent } from '@pwngh/economy-lab/adapters';
import { ERROR_CODES, fault } from '@pwngh/economy-lab';

import type {
  Dispatcher,
  EconomyEvent,
  CallOptions,
} from '@pwngh/economy-lab/ports';

// --- The @aws-sdk/client-sqs surface, typed structurally --------------------------

/**
 * Structural shape of the command object `SqsClient.send` takes. It stands in for the SDK's
 * `SendMessageCommand`, which this file never imports.
 */
export interface SqsCommand {
  readonly input: Record<string, unknown>;
}

/**
 * Structural shape of the SQS client the adapter calls. It names just the `send` method, so a
 * real `SQSClient` from `@aws-sdk/client-sqs` satisfies it and a test can pass a plain object.
 * The adapter never imports the SDK. The caller creates and owns the client.
 */
export interface SqsClient {
  send(
    command: SqsCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

// Stands in for the SDK's `new SendMessageCommand(input)`. The field names are SQS's own.
function sendMessageCommand(input: {
  QueueUrl: string;
  MessageBody: string;
  MessageDeduplicationId?: string;
  MessageGroupId?: string;
}): SqsCommand {
  return { input };
}

// --- Outbound dispatcher ----------------------------------------------------------

export interface SqsDispatcherOptions {
  /**
   * The full queue URL. A `.fifo` suffix switches on the FIFO-only parameters — dedup by event
   * id, group by subject — which a standard queue rejects.
   */
  queueUrl: string;

  /** The SQS client the caller created and owns (a real one, or a test stand-in). */
  client: SqsClient;
}

/** What {@link sqs} needs to open its own client. */
export interface SqsOptions {
  /** The full queue URL. A `.fifo` suffix switches on the FIFO-only parameters. */
  queueUrl: string;

  /** AWS region. Unset leaves the SDK to its own resolution chain. */
  region?: string;
}

/**
 * Builds the {@link Dispatcher} that publishes events to SQS, opening its own client. The AWS SDK
 * loads here and nowhere else, so a process that never dispatches to SQS never loads it. Because
 * this form opened the client, it releases it: the returned `close()` destroys it, and closing the
 * economy calls it.
 *
 * Pass `{ queueUrl, client }` to {@link sqsDispatcher} instead when the caller owns the client.
 * That form carries no `close` — a client you opened is yours to destroy.
 *
 * @example
 * const dispatch = await sqs({
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/economy-events.fifo',
 *   region: 'us-east-1',
 * });
 * await dispatch(event); // resolves once SQS accepts the message
 */
export async function sqs(
  options: SqsOptions,
): Promise<Dispatcher & { close(): Promise<void> }> {
  // The module name lives in a variable so the type-checker does not resolve the SDK at build
  // time, and a bundler leaves it a runtime import.
  const specifier = '@aws-sdk/client-sqs';
  let sdk: {
    SQSClient: new (config: { region?: string }) => {
      send(command: unknown, options?: unknown): Promise<unknown>;
      destroy?(): void;
    };
    SendMessageCommand: new (input: unknown) => unknown;
  };
  try {
    sdk = (await import(/* @vite-ignore */ specifier)) as unknown as typeof sdk;
  } catch (cause) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'Could not load the "@aws-sdk/client-sqs" driver. It ships as a dependency of this package, so check the install and any bundler externals.',
      { cause, retryable: false },
    );
  }
  const raw = new sdk.SQSClient(
    options.region === undefined ? {} : { region: options.region },
  );
  // The adapter speaks an SDK-free `{ input }` command so it stays testable without the SDK.
  // This is the one place that holds a real client, so translate the command here.
  const dispatch = sqsDispatcher({
    queueUrl: options.queueUrl,
    client: {
      send: async (command, sendOptions) => {
        await raw.send(new sdk.SendMessageCommand(command.input), sendOptions);
        return {};
      },
    },
  });
  return Object.assign(dispatch, {
    close: async () => {
      raw.destroy?.();
    },
  });
}

/**
 * Builds the {@link Dispatcher} that publishes events to SQS as JSON messages, the body encoded
 * by the lab's shared `encodeEvent`. Delivery is at-least-once either way; what varies is who
 * dedupes.
 *
 * On a FIFO queue — the URL ends in `.fifo` — the event id becomes the `MessageDeduplicationId`,
 * so a resend inside SQS's dedup window is dropped at the queue. The event subject becomes the
 * `MessageGroupId`, so one subject's events deliver in order.
 *
 * A standard queue rejects both parameters, so they are omitted and the receiver dedupes on the
 * event id carried in the body.
 *
 * On failure it throws a retryable `PROVIDER.FAILURE` so the caller's backoff wrapper retries.
 *
 * @example
 * import { SQSClient } from '@aws-sdk/client-sqs';
 * const dispatch = sqsDispatcher({
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/economy-events.fifo',
 *   client: new SQSClient({ region: 'us-east-1' }),
 * });
 * await dispatch(event); // resolves once SQS accepts the message
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/messaging/ Messaging} for how dispatchers deliver events.
 */
export function sqsDispatcher(config: SqsDispatcherOptions): Dispatcher {
  const client = config.client;
  // The FIFO-only params (MessageGroupId, MessageDeduplicationId) draw InvalidParameterValue on a
  // standard queue, so attach them only when the URL suffix says FIFO.
  const fifo = config.queueUrl.endsWith('.fifo');

  return async (event: EconomyEvent, options?: CallOptions): Promise<void> => {
    try {
      await client.send(
        sendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: encodeEvent(event),
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
