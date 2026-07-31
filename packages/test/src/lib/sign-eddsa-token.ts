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

import { toBase64Url } from '@pwngh/economy-lab/store-kit';

export interface SignEdDSATokenOptions {
  /** An Ed25519 private key; WebCrypto refuses any other algorithm at sign time. */
  privateKey: CryptoKey;
  /** Omit it and the header carries no `kid`, so key choice falls to the verifier's algorithm filter alone. */
  kid?: string;
}

/**
 * Signs a compact EdDSA JWS over the claims — the token `authJwks` verifies.
 *
 * ```ts
 * const { publicKey, privateKey } = (await crypto.subtle.generateKey(
 *   'Ed25519',
 *   true,
 *   ['sign', 'verify'],
 * )) as CryptoKeyPair;
 * const token = await signEdDSAToken(
 *   { sub: 'usr_ada', exp: Date.now() / 1000 + 60 },
 *   { privateKey, kid: 'k1' },
 * );
 * ```
 *
 * The claims go onto the wire exactly as given — no `exp` default, no issuer stamp — so a
 * test states the token's whole story at the call site. Every segment is unpadded base64url,
 * the one spelling the verifier accepts.
 */
export const signEdDSAToken = async (
  claims: Record<string, unknown>,
  options: SignEdDSATokenOptions,
): Promise<string> => {
  const part = (text: string): string =>
    toBase64Url(new TextEncoder().encode(text));
  const header = part(
    JSON.stringify(
      options.kid === undefined
        ? { alg: 'EdDSA' }
        : { alg: 'EdDSA', kid: options.kid },
    ),
  );
  const payload = part(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'Ed25519',
    options.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
};
