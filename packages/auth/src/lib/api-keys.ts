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

import { systemDigest } from '@pwngh/economy-lab/adapters';
import { toHex } from '@pwngh/economy-lab/store-kit';
import type { Authenticate, Principal } from './identity.js';
import { bearerOf } from './bearer.js';

const digest = systemDigest();

const sha256Hex = async (s: string): Promise<string> =>
  toHex(await digest.hash(new TextEncoder().encode(s)));

// What a missing or non-string value stringifies to on its way into the map. An unset
// environment variable would otherwise mint a live credential spelled `undefined`.
const MISSING_SECRET = ['', 'undefined', 'null', '[object Object]'];

/** Static bearer keys. The host builds the map (from its own secret store), one key per caller.
 *  Lookup runs on SHA-256 digests, so timing never walks the key material. */
export function authApiKeys(keys: Record<string, Principal>): Authenticate {
  for (const k of Object.keys(keys)) {
    if (MISSING_SECRET.includes(k)) {
      throw new TypeError(
        `authApiKeys: ${JSON.stringify(k)} is a missing secret, not a key`,
      );
    }
  }
  const ready = (async () => {
    const table = new Map<string, Principal>();
    for (const [k, p] of Object.entries(keys)) table.set(await sha256Hex(k), p);
    return table;
  })();
  return async (request) => {
    const bearer = bearerOf(request);
    if (!bearer) return null;
    return (await ready).get(await sha256Hex(bearer)) ?? null;
  };
}
