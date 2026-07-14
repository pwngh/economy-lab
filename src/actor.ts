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

import type { Principal } from '#src/contract.ts';

// Constructors for the three Principal kinds. Every operation carries an `actor`, so these save a
// host from hand-writing the tagged union: `actor: userActor('usr_1')` instead of
// `actor: { kind: 'user', userId: 'usr_1' }`.

/** An end user; may act only on their own accounts. */
export const userActor = (userId: string): Principal => ({
  kind: 'user',
  userId,
});

/** A trusted internal service acting on the platform's behalf. */
export const systemActor = (service: string): Principal => ({
  kind: 'system',
  service,
});

/** A human operator running a manual, fully-audited action. */
export const operatorActor = (operatorId: string): Principal => ({
  kind: 'operator',
  operatorId,
});
