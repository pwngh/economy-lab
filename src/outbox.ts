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

import type { EconomyEvent, Ids, OutboxMessage } from '#src/ports.ts';

/** The envelope every outbox enqueue starts from; the relay owns every later change to its fields. */
export function pendingOutbox(ids: Ids, event: EconomyEvent): OutboxMessage {
  return {
    id: ids.next('obx'),
    event,
    status: 'pending',
    attempts: 0,
    reason: null,
  };
}
