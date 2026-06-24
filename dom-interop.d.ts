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
 * DOM-interop shim for consumers that type-check under the DOM lib (a browser/SSR app), provided by
 * the package so each consumer does not hand-roll it.
 *
 * The engine itself is WinterCG and type-checks at the repo root with `lib: esnext` and its own
 * `src/wintercg.d.ts` — no DOM. A consuming app under `lib: dom` hits a TS 5.7 friction: `Uint8Array`
 * became generic over its buffer (`Uint8Array<ArrayBufferLike>`), which DOM's `BufferSource` rejects,
 * so the engine's `crypto.subtle.digest(bytes)` / `sign` / `verify` / `importKey` calls surface false
 * type errors even though they build and run fine. Declaration-merging these overloads onto the
 * global `SubtleCrypto` clears them without touching `src/` or weakening the app's own types.
 *
 * Reference it from a DOM consumer rather than re-declaring it:
 *   /// <reference path=".../dom-interop.d.ts" />
 * (or, once published, `/// <reference types="@pwngh/economy-lab/dom-interop" />`). It must not be in
 * the engine's own root tsconfig include — it names DOM-only types (AlgorithmIdentifier, CryptoKey)
 * that the no-DOM root build does not have.
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
