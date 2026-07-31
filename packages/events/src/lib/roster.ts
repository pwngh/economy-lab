/**
 * @pwngh/economy-events
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { EVENT_TYPES as LAB_EVENT_TYPES } from '@pwngh/economy-lab';

import type { EventType } from '@pwngh/economy-lab';

/**
 * The fourteen types the economy emits, in the lab's own order. Frozen, and a copy: freezing
 * the lab's array in place would reach into a module this package only reads.
 *
 * A type joins the roster in the lab before anything can emit it, so a name absent here is a
 * name nothing sends.
 */
export const EVENT_TYPES: readonly EventType[] = Object.freeze([
  ...LAB_EVENT_TYPES,
]);

/**
 * The schema version every event currently carries. A shape change raises it.
 *
 * Declared here rather than re-exported, so the number a consumer decodes against is this
 * package's own and `test/events.test.ts` can resolve it against the lab's. A re-export would make
 * that comparison read one value twice.
 */
export const EVENT_VERSION = 1;

/**
 * True when `value` is a rostered event type. Use it on the way in from a queue or a webhook,
 * where the type is a string until something checks it.
 */
export function isEventType(value: unknown): value is EventType {
  return (
    typeof value === 'string' &&
    (EVENT_TYPES as readonly string[]).includes(value)
  );
}
