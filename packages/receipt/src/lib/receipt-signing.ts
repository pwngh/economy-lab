/**
 * @pwngh/economy-receipt
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Hex, matching the lowercase spelling the ledger stores every hash and key id in. */
const HEX = '0123456789abcdef';

/**
 * The id of the key `secret` is: the first 16 lowercase hex characters of its SHA-256.
 *
 * Same width and spelling as the ledger's `Signer.kid`, which answers the first 16 hex
 * characters of its public key. A hash stands in for the public key an HMAC secret does not
 * have, so the id names the key without carrying anything that could sign with it.
 */
export async function keyId(secret: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(secret),
  );
  return toHex(new Uint8Array(hash)).slice(0, 16);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += HEX[byte >> 4] + HEX[byte & 15];
  return hex;
}

/**
 * Returns `value` with `.<signature>` appended, where the signature is HMAC-SHA256 over the
 * exact bytes of `value` under `secret`.
 *
 * Signing whatever the caller already encoded is what makes the signature cover the encoded
 * bytes rather than the value they stand for.
 */
export async function sign(value: string, secret: string): Promise<string> {
  const key = await createKey(secret, ['sign']);
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(value),
  );
  return `${value}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * Checks and strips the signature {@link sign} appended, returning the signed value on a match
 * and `false` on everything else: no separator, a signature that is not canonical base64url, or
 * one that does not verify under `secret`.
 */
export async function unsign(
  signed: string,
  secret: string,
): Promise<string | false> {
  const index = signed.lastIndexOf('.');
  if (index === -1) return false;

  const value = signed.slice(0, index);
  const key = await createKey(secret, ['verify']);
  try {
    const signature = decodeBase64Url(signed.slice(index + 1));
    const valid = await globalThis.crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(value),
    );
    return valid ? value : false;
  } catch {
    // decodeBase64Url throws on anything but the one canonical spelling. A signature that
    // cannot be read is one that does not match.
    return false;
  }
}

/**
 * Base64url without padding: the receipt travels in a URL, a path segment, or a QR code
 * without further escaping.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Reads back {@link encodeBase64Url}. Throws when `text` is not canonical base64url. */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // `atob` also takes the standard alphabet, padding, embedded whitespace, and the trailing
  // bits the value does not use. Re-encoding is what keeps one receipt to one spelling.
  if (encodeBase64Url(bytes) !== text)
    throw new SyntaxError('not canonical base64url');
  return bytes;
}

/** UTF-8 text as base64url, for the payload half of the receipt. */
export function encodeTextBase64Url(text: string): string {
  return encodeBase64Url(encoder.encode(text));
}

/** Base64url back to UTF-8 text. Throws when `text` is not base64url. */
export function decodeTextBase64Url(text: string): string {
  return decoder.decode(decodeBase64Url(text));
}

function createKey(
  secret: string,
  usages: CryptoKey['usages'],
): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}
