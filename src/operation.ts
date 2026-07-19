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

import type { Operation } from '#src/contract.ts';

// One typed builder per operation kind, so a caller writes `topUp({ ... })` instead of hand-writing
// the tagged union and its `kind` string. Each builder's argument is the operation's fields minus
// `kind`, derived from the union itself, so a new arm or a changed field flows through here with no
// edit. The single cast is sound: kind plus every non-kind field is exactly the arm.

type OpOf<K extends Operation['kind']> = Extract<Operation, { kind: K }>;
type FieldsOf<K extends Operation['kind']> = Omit<OpOf<K>, 'kind'>;

function define<K extends Operation['kind']>(kind: K) {
  return (fields: FieldsOf<K>): OpOf<K> => ({ kind, ...fields }) as OpOf<K>;
}

export const topUp = define('topUp');
export const spend = define('spend');
export const refund = define('refund');
export const clawback = define('clawback');
export const requestPayout = define('requestPayout');
export const subscribe = define('subscribe');
export const cancelSubscription = define('cancelSubscription');
export const grantEntitlement = define('grantEntitlement');
export const revokeEntitlement = define('revokeEntitlement');
export const grantPromo = define('grantPromo');
export const adjust = define('adjust');
export const reverse = define('reverse');
export const reversePayout = define('reversePayout');
export const settlePayout = define('settlePayout');

/**
 * Mints an idempotency key: `idem_` plus the joined parts when given (so a caller can derive the
 * same key on retry from its own identifiers), else a random UUID for one-shot scripts.
 */
export function idempotencyKey(...parts: ReadonlyArray<string>): string {
  return parts.length > 0
    ? `idem_${parts.join(':')}`
    : `idem_${crypto.randomUUID()}`;
}
