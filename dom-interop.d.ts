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
 * DOM-interop shim for consumers that type-check under the DOM lib; shipped so each consumer
 * does not hand-roll it.
 *
 * TS 5.7 made `Uint8Array` generic over its buffer, which DOM's `BufferSource` rejects, so the
 * engine's `crypto.subtle` digest/sign/verify/importKey calls surface false type errors under
 * `lib: dom` even though they build and run fine. Declaration-merging these overloads onto the
 * global `SubtleCrypto` clears them without touching `src/` or the app's own types.
 *
 * Reference it from a DOM consumer:
 *   /// <reference path=".../dom-interop.d.ts" />
 * (once published: `/// <reference types="@pwngh/economy-lab/dom-interop" />`). Keep this file
 * OUT of the engine's root tsconfig include: it names DOM-only types the no-DOM build lacks.
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
