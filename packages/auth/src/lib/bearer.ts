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

import type { Authenticate } from './identity.js';

/** Strict bearer grammar: the `Bearer ` prefix is required (the scheme name is
 *  case-insensitive per RFC 7235); a raw credential answers null. */
export const bearerOf = (request: Request): string | null =>
  request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

/** First resolver returning a principal wins; nulls fall through to the next. */
export function bearerStack(...resolvers: Authenticate[]): Authenticate {
  resolvers.forEach((r, i) => {
    if (typeof r !== 'function') {
      throw new TypeError(
        `bearerStack: element ${i + 1} is not an Authenticate function`,
      );
    }
  });
  return async (request) => {
    for (const resolve of resolvers) {
      const principal = await resolve(request);
      if (principal) return principal;
    }
    return null;
  };
}
