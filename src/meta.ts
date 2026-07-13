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

/**
 * Reads typed fields from a posting's free-form `meta`. Kept free of SQL and store specifics so a
 * non-SQL store never imports engine code for a plain JSON lookup.
 */

export function metaString(
  meta: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = meta[key];
  return typeof value === 'string' ? value : fallback;
}

export function metaNumber(
  meta: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = meta[key];
  return typeof value === 'number' ? value : fallback;
}
