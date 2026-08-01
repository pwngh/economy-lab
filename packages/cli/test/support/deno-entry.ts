/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// `economy` run against a stand-in for Deno, so the deno leg's taken port is observable under
// plain Node. Deno's own class is `class AddrInUse extends Error` with `this.name = "AddrInUse"`
// and nothing more — no `code`, no `port` — which is the whole reason the bind normalizes it.
class AddrInUse extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddrInUse';
  }
}

(globalThis as { Deno?: unknown }).Deno = {
  serve: () => {
    throw new AddrInUse('Address already in use (os error 48)');
  },
  errors: { AddrInUse },
};

await import('./entry.js');
