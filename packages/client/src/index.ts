/**
 * @pwngh/economy-client
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

export { createClient, createTransport } from './lib/client.js';
export type {
  ClientOptions,
  TokenSource,
  TransportOptions,
} from './lib/client.js';
export { isCommitted, isRejected, newIdempotencyKey } from './lib/outcome.js';
export type { WireRejection, WireSuccess } from './lib/outcome.js';
export { EconomyHttpError } from '@pwngh/economy-lab/client';
export type {
  EconomyClient,
  WireAmount,
  WireOperation,
  WireOutcome,
  WirePage,
} from '@pwngh/economy-lab/client';
