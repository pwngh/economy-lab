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

// byte (0-255) -> two lowercase hex chars, e.g. 0 -> "00", 255 -> "ff".
// Built once at module load so encoding does a lookup per byte, not a format.
let HEX = (() => {
  let table = new Array<string>(256);
  for (let byte = 0; byte < 256; byte += 1) {
    table[byte] = byte.toString(16).padStart(2, '0');
  }
  return table;
})();

/**
 * Encode a byte array as a lowercase hex string (two chars per byte).
 *
 * Hand-written over `Uint8Array` rather than `Buffer` or `Uint8Array.prototype.toHex`,
 * neither of which exists on every runtime we target. This guarantees identical output
 * on Node, Bun, Deno, and Workers, which matters since the result feeds cross-runtime hashes.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 * hash chain these hex helpers feed.
 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += HEX[bytes[i]!];
  }
  return out;
}

/**
 * Decode a lowercase hex string back into its byte array.
 *
 * Throws on odd length or any non-hex-digit character: such input is a caller bug to fix at the
 * source, not a recoverable outcome.
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
 * Order two strings by raw UTF-16 character codes, returning -1, 0, or 1 (sort comparator shape).
 * Character-code order via `<`/`>` is identical across runtimes and locales, unlike `localeCompare`,
 * so any hash or report derived from sorted account ids or keys matches everywhere.
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

// Code point -> numeric value (0-15), accepting only '0'-'9' and lowercase 'a'-'f'.
// Anything else throws so a malformed string can't decode into the wrong bytes.
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
