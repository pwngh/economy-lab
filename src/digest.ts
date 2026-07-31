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

import type { Digest } from '#src/ports.ts';

// Every default {@link Digest} factory shares this system SHA-256.

// The synchronous SHA-256 is resolved once from node:crypto on the first hash. It stays null on a
// runtime without node:crypto (e.g. Cloudflare Workers), and the Web Crypto fallback runs instead.
type SyncHash = (bytes: Uint8Array) => Uint8Array;

let syncHash: SyncHash | null = null;
let probe: Promise<void> | null = null;

// The import is dynamic and guarded so a runtime without node:crypto falls back to Web Crypto
// instead of failing to load this module.
async function probeSyncHash(): Promise<void> {
  try {
    const { createHash } = await import('node:crypto');
    syncHash = (bytes) =>
      new Uint8Array(createHash('sha256').update(bytes).digest());
  } catch {
    syncHash = null;
  }
}

// Web Crypto SHA-256 exists on every JS runtime. It is the fallback when node:crypto is absent.
async function subtleHash(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Builds the system SHA-256 {@link Digest}. It prefers node:crypto's synchronous hash (faster for
 * the small per-posting preimages) and falls back to Web Crypto. Both compute the same bytes, so
 * a hash written on one runtime still re-derives on another.
 */
export function sha256Digest(): Digest {
  return {
    hash: async (bytes) => {
      // The first call starts the probe. Every later caller awaits that same probe. Reading into a
      // local keeps the hasher callable after the null check, since the probe mutates module state.
      let hasher = syncHash;
      if (hasher === null) {
        if (probe === null) {
          probe = probeSyncHash();
        }
        await probe;
        hasher = syncHash;
      }
      return hasher ? hasher(bytes) : subtleHash(bytes);
    },
  };
}
