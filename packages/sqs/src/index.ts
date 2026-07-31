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

/** Builds the `Dispatcher` that publishes events to SQS, opening its own client. */
export { sqs } from './sqs.js';

/** The escape hatch: the same dispatcher over a client the caller created. */
export { sqsDispatcher } from './sqs.js';

export type {
  SqsClient,
  SqsCommand,
  SqsDispatcherOptions,
  SqsOptions,
} from './sqs.js';
