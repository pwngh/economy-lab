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
 * Encodes one outbound event into its canonical JSON body. Every Dispatcher adapter (HTTP, SQS)
 * calls this, so a receiver sees the same bytes regardless of transport.
 *
 * This function is the single source of truth for the wire format. The two transports must encode
 * identically, and the Dispatcher conformance suite asserts each adapter's body equals this output.
 * The fixed field order makes the bytes deterministic, so a receiver can dedupe by content. Money in
 * `data` is already a string by this point, because `JSON.stringify` throws on a bigint.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/messaging/ Messaging} for how dispatchers carry events across transports.
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
