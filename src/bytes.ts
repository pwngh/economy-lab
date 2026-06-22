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

import { ERROR_CODES, fault } from '#src/errors.ts';

// A lookup table from a byte value (0-255) to its two lowercase hex characters,
// e.g. 0 -> "00", 255 -> "ff". Built once when this module loads so that
// encoding reads a precomputed string per byte instead of formatting each one.
let HEX = (() => {
  let table = new Array<string>(256);
  for (let byte = 0; byte < 256; byte += 1) {
    table[byte] = byte.toString(16).padStart(2, '0');
  }
  return table;
})();

/**
 * Encode a byte array as a lowercase hex string (two characters per byte).
 *
 * This is hand-written over `Uint8Array` rather than using `Buffer` or the
 * newer `Uint8Array.prototype.toHex`, neither of which exists on every runtime
 * we target. Doing it ourselves guarantees the exact same output on Node, Bun,
 * Deno, and Workers, which matters because the result is used in hashes that
 * must match across runtimes.
 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += HEX[bytes[i]!];
  }
  return out;
}

/**
 * Decode a lowercase hex string back into the byte array it came from.
 *
 * If the input has an odd number of characters or any character that is not a
 * hex digit, this throws an error rather than returning a value. Such input
 * means a caller produced a broken string, which is a programming bug to fix at
 * the source, not a normal outcome a caller should expect and handle.
 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'Hex string has an odd length.',
      {
        detail: { length: hex.length },
      },
    );
  }
  let bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    let high = hexDigit(hex.charCodeAt(i * 2));
    let low = hexDigit(hex.charCodeAt(i * 2 + 1));
    bytes[i] = (high << 4) | low;
  }
  return bytes;
}

/**
 * Order two strings by their raw UTF-16 character codes, returning -1, 0, or 1 (the shape a
 * sort comparator expects). JavaScript's `<` and `>` on strings already compare by character
 * code, which is fixed across runtimes and locales — unlike `localeCompare`, whose result can
 * differ between machines and language settings. Callers that sort account ids or report keys
 * use this so the order (and any hash or report derived from it) comes out identical everywhere.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

// Convert one character's code point to its numeric value (0-15), accepting
// only '0'-'9' and lowercase 'a'-'f'. Any other character throws an error so a
// malformed string can't quietly decode into the wrong bytes.
function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48; // '0'-'9'
  }
  if (code >= 97 && code <= 102) {
    return code - 87; // 'a'-'f'
  }
  throw fault(
    ERROR_CODES.MALFORMED_OPERATION,
    'Hex string has a non-hex digit.',
    {
      detail: { code },
    },
  );
}
