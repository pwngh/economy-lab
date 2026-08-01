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

// Aliased over node:http (vite.config.ts). @pwngh/economy-core's Node bridge imports createServer
// at the top of host.js, and the bundler resolves that name whether or not the branch reaching it
// can run — so the alias has to export the name rather than throw at import the way the node:crypto
// stub does. Nothing in a browser reaches it: host.js is behind a dynamic import inside App.listen(),
// and this console never binds a socket. Calling it is the bug, so calling it is what throws.
//
// This exists because the front door does not bundle for a browser on its own.
export function createServer(): never {
  throw new Error(
    'node:http is unavailable in the browser; this economy runs in the tab and never calls listen().',
  );
}
