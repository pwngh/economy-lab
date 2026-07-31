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

/**
 * The `authenticate` posture: who is calling, and by what credential.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/actors-and-authorization/ Actors & authorization}
 *   for the three actor kinds and the gate every request passes.
 */

export { operatorActor, systemActor, userActor } from './lib/identity.js';
export type { Authenticate, Principal } from './lib/identity.js';
export { bearerStack } from './lib/bearer.js';
export { authApiKeys } from './lib/api-keys.js';
export { authJwks } from './lib/jwks.js';
export type { JwksOptions } from './lib/jwks.js';
export { devAuthenticate, devTokens } from './lib/dev-tokens.js';
export type { DevToken } from './lib/dev-tokens.js';
