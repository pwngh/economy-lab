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
 * Reads typed fields from a posting's free-form `meta`, a plain JSON object. These helpers carry no
 * SQL, no driver, and no store specifics, so any layer can use them. The in-memory store and the SQL
 * engines both read posting metadata this way. They live outside the engine helpers so that a non-SQL
 * store does not have to import engine code just to do a plain JSON lookup.
 */

// Reads a string field from `meta`. Returns `fallback` when the key is missing or its value is not a string.
export function metaString(
  meta: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  let value = meta[key];
  return typeof value === 'string' ? value : fallback;
}

// Reads a number field from `meta`. Returns `fallback` when the key is missing or its value is not a number.
export function metaNumber(
  meta: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  let value = meta[key];
  return typeof value === 'number' ? value : fallback;
}
