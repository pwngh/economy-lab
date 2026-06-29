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

import type { EconomyEvent } from '#src/ports.ts';

/**
 * The canonical JSON body for one outbound event, shared by every Dispatcher adapter (HTTP, SQS)
 * so a receiver sees the same shape — the same bytes — regardless of transport.
 *
 * One source of truth: the two transports must encode identically, and the Dispatcher conformance
 * suite asserts each adapter's body equals this output. Fixed field order makes the bytes
 * deterministic, so a receiver can dedupe by content. Money in `data` is already a string by here
 * (`JSON.stringify` throws on a bigint).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging} for how dispatchers carry events across transports.
 */
export function encodeEvent(event: EconomyEvent): string {
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
