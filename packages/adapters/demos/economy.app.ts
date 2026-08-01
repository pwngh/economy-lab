/**
 * @pwngh/economy-adapters
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/** Your own routes answer beside the built-in `/v1` surface, on the same handler. */
export const routes = {
  'GET /hello': () => new Response('hello from your economy'),
};
