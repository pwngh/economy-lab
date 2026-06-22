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
 * Typed reads from a posting's free-form `meta` (a plain JSON object). Generic — no SQL, no driver,
 * no store specifics — so any layer uses them: the in-memory store and the SQL engines both read
 * posting metadata this way. Kept out of the engine helpers so a non-SQL store doesn't have to
 * import engine code for a plain JSON lookup.
 */

// Read a string field from `meta`, or `fallback` when it is missing or not a string.
export function metaString(
  meta: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  let value = meta[key];
  return typeof value === 'string' ? value : fallback;
}

// Read a number field from `meta`, or `fallback` when it is missing or not a number.
export function metaNumber(
  meta: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  let value = meta[key];
  return typeof value === 'number' ? value : fallback;
}
