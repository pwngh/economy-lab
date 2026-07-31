/**
 * @pwngh/economy-webhook
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signHmac,
  verifyHmac,
} from '@pwngh/economy-lab/server';

// Named by importing rather than by redeclaring: these are the lab's wire contract, and
// @pwngh/economy-lab is not a door, so what this package's surface needs rides out through it.
export { SIGNATURE_HEADER, TIMESTAMP_HEADER };

/**
 * Five minutes, the window the reference host applies.
 *
 * It bounds how far a delivery's clock may sit from ours. It is not a replay bound: the
 * timestamp rides in a header no signature covers, so a captured delivery can be re-dated
 * into the window at will. Replay is stopped by claiming the event id.
 */
export const DEFAULT_FRESHNESS_WINDOW_MS = 5 * 60_000;

/**
 * True when `signature` is the HMAC of exactly these bytes under any of these secrets.
 *
 * The bytes are the ones that arrived. A body parsed and re-serialized is different bytes and
 * will not verify, because a signature covers bytes and not meaning.
 *
 * An inbound signature names no key, so every secret is tried. That is what makes rotation a
 * window: hold the old secret alongside the new one until the provider has switched.
 *
 * Web Crypto compares in constant time and answers false rather than throwing, so a wrong
 * length, a wrong value, and a signature that is not hex at all are one answer: no.
 */
export async function verifySignature(
  raw: Uint8Array<ArrayBuffer>,
  signature: string,
  secrets: readonly string[],
): Promise<boolean> {
  for (const secret of secrets) {
    if (await verifyHmac(raw, signature, secret)) return true;
  }
  return false;
}

/**
 * Signs bytes the way a provider would, under one named secret.
 *
 * It is here so that a host driving its own endpoint — in a test, or to replay a delivery
 * against a rotated secret — never re-derives the scheme by hand. A hand-rolled encoding is
 * how two implementations of one signature quietly stop agreeing.
 *
 * This is the outbound direction and the verify path never calls it. A provider signs its own
 * deliveries; do not sign real outbound traffic with a secret held for verifying inbound.
 */
export async function signBody(
  raw: Uint8Array<ArrayBuffer>,
  secret: string,
): Promise<string> {
  return signHmac(raw, secret);
}
