/**
 * @pwngh/economy-webhook
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

export { createWebhookVerifier } from './lib/verify.js';
export type {
  DuplicateWebhook,
  RefusedWebhook,
  VerifiedWebhook,
  WebhookDecoder,
  WebhookResult,
  WebhookVerifier,
  WebhookVerifierOptions,
} from './lib/verify.js';
export {
  DEFAULT_FRESHNESS_WINDOW_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signBody,
  verifySignature,
} from './lib/signature.js';
export type {
  DisputeEvent,
  PayoutFailedEvent,
  PayoutSettledEvent,
  PurchaseEvent,
  WebhookEvent,
} from '@pwngh/economy-lab/server';
