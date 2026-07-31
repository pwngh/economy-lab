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

import type { WireOutcome } from '@pwngh/economy-lab/client';

/** The outcome arm that carries a posting: money moved, or moved once already. */
export type WireSuccess = Extract<
  WireOutcome,
  { status: 'committed' | 'duplicate' }
>;

/** The outcome arm for a decline. It is a normal answer, not an error. */
export type WireRejection = Extract<WireOutcome, { status: 'rejected' }>;

/**
 * True when the submit posted. `duplicate` counts: it is the same posting returned to a
 * retry, so a caller that treats it as anything but success double-charges to fix nothing.
 */
export function isCommitted(outcome: WireOutcome): outcome is WireSuccess {
  return outcome.status === 'committed' || outcome.status === 'duplicate';
}

/** True when the economy declined. `outcome.reason` says which rule said no. */
export function isRejected(outcome: WireOutcome): outcome is WireRejection {
  return outcome.status === 'rejected';
}

/**
 * Mints an idempotency key. Keep the key with the intent it stands for — a retry of the same
 * purchase must send the same key, or the ledger reads it as a second purchase.
 *
 * Web Crypto supplies the randomness, so a browser needs a secure context.
 */
export function newIdempotencyKey(prefix?: string): string {
  const id = crypto.randomUUID();
  return prefix === undefined ? id : `${prefix}_${id}`;
}
