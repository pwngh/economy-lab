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

/**
 * A module namespace whose named export throws the moment it is read.
 *
 * ```ts
 * resolveEconomyModule(
 *   throwingGetter('policy', new TypeError('lazy require exploded'), {
 *     authenticate: false,
 *   }),
 *   'economy.app.ts',
 * ); // throws EconomyModuleError SEAM_SHAPE — the raw TypeError never escapes
 * ```
 *
 * What a broken lazy require or a hostile CJS interop shim looks like from a resolver's
 * side. `seed` is the well-formed exports beside the trap; by default the namespace holds
 * nothing else.
 */
export const throwingGetter = (
  key: string,
  error: unknown,
  seed: Record<string, unknown> = {},
): Record<string, unknown> => {
  const namespace: Record<string, unknown> = { ...seed };
  Object.defineProperty(namespace, key, {
    get() {
      throw error;
    },
    enumerable: true,
  });
  return namespace;
};
