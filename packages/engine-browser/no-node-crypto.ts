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

// Import-time throw, aliased over node:crypto (vite.config.ts). Vite's own browser shim imports
// cleanly and then fails at the first hash; rejecting the import instead lands in the digest
// probe's catch (src/digest.ts), which falls back to Web Crypto.
throw new Error(
  'node:crypto is unavailable in the browser; Web Crypto is used instead.',
);

export {};
