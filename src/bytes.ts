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

// Per-byte hex table built once at module load, so encoding is a lookup.
const HEX = (() => {
  const table = new Array<string>(256);
  for (let byte = 0; byte < 256; byte += 1) {
    table[byte] = byte.toString(16).padStart(2, '0');
  }
  return table;
})();

/**
 * Lowercase hex, hand-written because neither `Buffer` nor `Uint8Array.prototype.toHex` exists on
 * every target runtime, and the result feeds cross-runtime hashes.
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
 * Decodes a lowercase hex string back into its byte array.
 *
 * Throws on an odd length or any non-hex-digit character. Such input is a caller bug to fix at
 * the source, not a recoverable outcome.
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
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const high = hexDigit(hex.charCodeAt(i * 2));
    const low = hexDigit(hex.charCodeAt(i * 2 + 1));
    bytes[i] = (high << 4) | low;
  }
  return bytes;
}

/**
 * Encodes a signed bigint as 8 bytes, big-endian two's complement.
 *
 * The sum-carrying checkpoint preimages (see chain.ts) hash balance sums, and a hash needs the
 * same bytes on every runtime: fixed width, fixed byte order, no decimal formatting. Throws when
 * the value falls outside the signed 64-bit range, the same bound the schema's BIGINT columns
 * declare — `DataView.setBigInt64` would silently wrap, and a wrapped sum must never reach a hash.
 */
export function toInt64BE(value: bigint): Uint8Array {
  if (value < -(2n ** 63n) || value >= 2n ** 63n) {
    throw fault(
      ERROR_CODES.AMOUNT_OVERFLOW,
      'Value does not fit in a signed 64-bit integer.',
      { detail: { value: value.toString() } },
    );
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value);
  return bytes;
}

/**
 * Orders two strings by raw UTF-16 character codes, returning -1, 0, or 1 like a sort comparator.
 *
 * Character-code order through `<` and `>` is identical across runtimes and locales, unlike
 * `localeCompare`. That keeps any hash or report derived from sorted account ids or keys
 * matching everywhere.
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

// Maps a code point to its numeric value (0-15), accepting only '0'-'9' and lowercase 'a'-'f'.
// Anything else throws so a malformed string cannot decode into the wrong bytes.
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
