/**
 * @pwngh/economy-money
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/**
 * A value that knows its own wire form.
 *
 * An implementer can be handed straight to anywhere the wire expects text — a JSON body, an
 * event payload, a log line — and it serializes itself.
 */
export interface WireValue {
  toString(): string;
}
