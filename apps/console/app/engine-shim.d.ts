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
 * Type-only shim for consuming the frozen economy-lab engine source under THIS app's DOM lib.
 *
 * The engine is WinterCG: it ships its own ambient `wintercg.d.ts` whose `SubtleCrypto` and
 * `BufferSource` accept a plain `Uint8Array`, and it is type-checked at the repo root under that
 * config (lib: esnext, types: []). That ambient file is NOT part of this app's program — here the
 * DOM lib's stricter `SubtleCrypto` is in scope, and since TS 5.7 a `Uint8Array` is generic over
 * its backing buffer (`Uint8Array<ArrayBufferLike>`), which DOM's `BufferSource` (ArrayBuffer-only)
 * rejects. That produces false errors in the engine's crypto calls, even though the code is correct
 * and builds + runs fine (Vite/esbuild transpiles it without type-checking).
 *
 * Declaration-merging an overload onto `SubtleCrypto` that accepts the generic `Uint8Array` makes
 * the engine's calls type-check here, without touching the frozen `src/` and without weakening the
 * app's own DOM types. This is the documented way to reconcile two compatible-at-runtime crypto
 * typings across a compilation boundary.
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
