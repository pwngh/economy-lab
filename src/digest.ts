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

// The system SHA-256, used by every default {@link Digest} factory (the in-memory adapter, the SQL
// engines, the composition root, and the production runtime services). Pulled into one place so all
// four share one implementation instead of four copies of the same hash.

// A synchronous SHA-256, resolved once from node:crypto when the runtime offers it. It is null until
// the first hash probes for it, and stays null on a runtime without node:crypto (e.g. Cloudflare
// Workers), where the Web Crypto fallback below is used instead.
type SyncHash = (bytes: Uint8Array) => Uint8Array;

let syncHash: SyncHash | null = null;
let probe: Promise<void> | null = null;

// Tries to load node:crypto's synchronous `createHash`. The import is dynamic and guarded, so a
// runtime that lacks node:crypto falls back to Web Crypto rather than failing to load this module,
// and a runtime that has it pulls it in lazily on the first hash, not at module load.
async function probeSyncHash(): Promise<void> {
  try {
    const { createHash } = await import('node:crypto');
    syncHash = (bytes) =>
      new Uint8Array(createHash('sha256').update(bytes).digest());
  } catch {
    syncHash = null;
  }
}

// Web Crypto SHA-256, available on every JS runtime. This is the fallback when node:crypto is absent
// and the reference the digests historically used; node:crypto returns byte-identical output.
async function subtleHash(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Returns the system SHA-256 {@link Digest}. It prefers a synchronous node:crypto hash, which is
 * faster than Web Crypto for the few-hundred-byte chain preimages this hashes per posting, and
 * falls back to Web Crypto on a runtime without node:crypto. Both compute the same SHA-256
 * bytes, so an account's chain head and a checkpoint's Merkle root are identical whichever path
 * runs, and a hash written on one runtime still re-derives on another.
 */
export function sha256Digest(): Digest {
  return {
    hash: async (bytes) => {
      // Read the resolved hasher into a local. On the first call it is still null, so probe once
      // (every later caller awaits that same probe), then read again. Reading into a local keeps the
      // node:crypto path callable without control-flow narrowing it away after the null check.
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
