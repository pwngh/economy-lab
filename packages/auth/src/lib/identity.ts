/**
 * @pwngh/economy-auth
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// Re-exported from the lab, never redefined: a Principal built here and a Principal the
// ledger authorizes against must be the same value, or authorization silently splits.
//
// The three actors are the whole authorization vocabulary, and the reason they live beside
// the resolvers: a user actor may move only its own money, acting for another user takes a
// system or operator actor, and a request body carrying its own actor is refused — the
// server stamps the principal its `authenticate` resolved and nothing else.
export { userActor, systemActor, operatorActor } from '@pwngh/economy-lab';
export type { Principal } from '@pwngh/economy-lab';

/** The `authenticate` seam: `(request) => Promise<Principal | null>`. Null is "no caller",
 *  answered as a 401 — never an exception. */
export type { Authenticate } from '@pwngh/economy-lab/server';
