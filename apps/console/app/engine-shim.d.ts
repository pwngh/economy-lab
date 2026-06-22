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
 * Type-only shim for the engine source under this app's DOM lib.
 *
 * The engine is WinterCG and type-checks at the repo root (lib esnext, its own wintercg.d.ts). Here
 * the DOM lib's stricter SubtleCrypto is in scope, and since TS 5.7 Uint8Array is generic over its
 * buffer (Uint8Array<ArrayBufferLike>), which DOM's BufferSource rejects — false errors on the
 * engine's crypto calls, though it builds and runs fine. Declaration-merging Uint8Array overloads
 * onto SubtleCrypto makes those calls type-check without touching src/ or weakening the app's types.
 */

interface SubtleCrypto {
  digest(
    algorithm: AlgorithmIdentifier,
    data: Uint8Array<ArrayBufferLike>,
  ): Promise<ArrayBuffer>;
  sign(
    algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams,
    key: CryptoKey,
    data: Uint8Array<ArrayBufferLike>,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams,
    key: CryptoKey,
    signature: Uint8Array<ArrayBufferLike>,
    data: Uint8Array<ArrayBufferLike>,
  ): Promise<boolean>;
  importKey(
    format: 'raw' | 'pkcs8' | 'spki',
    keyData: Uint8Array<ArrayBufferLike>,
    algorithm:
      | AlgorithmIdentifier
      | RsaHashedImportParams
      | EcKeyImportParams
      | HmacImportParams
      | AesKeyAlgorithm,
    extractable: boolean,
    keyUsages: ReadonlyArray<KeyUsage>,
  ): Promise<CryptoKey>;
}
