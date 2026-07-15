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

// The WebAssembly global exists on every runtime the lab targets, but its types live in the `dom`
// lib, which this project leaves out to keep its ambient surface to `esnext` alone. Only
// `fold.vendored.ts` and `fold-column.ts` touch WebAssembly, so declare just the slice they use
// rather than pull in `dom`.
declare namespace WebAssembly {
  class Module {
    constructor(bytes: Uint8Array);
  }
  class Instance {
    constructor(module: Module);
    readonly exports: Record<string, unknown>;
  }
  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  // What a trap surfaces as; fold-column's catch narrows on it.
  class RuntimeError extends Error {}
}
