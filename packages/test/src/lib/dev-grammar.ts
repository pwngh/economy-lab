/**
 * @pwngh/economy-test
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { operatorActor, systemActor, userActor } from '@pwngh/economy-auth';
import type { Principal } from '@pwngh/economy-auth';

// A mirror of packages/auth/src/lib/bearer.ts, which keeps `bearerOf` package-internal, so the
// harness cannot import it. `the harness bearer grammar ...` in dev-grammar.test.ts pins the two.
export const bearerOf = (request: Request): string | null =>
  request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

/** Resolves any `dev_<kind>_<label>` bearer to its principal; every other credential is null. */
export const devGrammar = async (
  request: Request,
): Promise<Principal | null> => {
  const m = bearerOf(request)?.match(/^dev_(user|system|operator)_(.+)$/);
  if (!m) return null;
  return m[1] === 'user'
    ? userActor(`usr_${m[2]}`)
    : m[1] === 'system'
      ? systemActor(m[2]!)
      : operatorActor(`ops_${m[2]}`);
};
