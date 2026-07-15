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
 * A resident i64 column for re-deriving one account's balance. The in-memory store keeps each
 * account's signed leg deltas here, in commit order, so a re-derivation folds native i64 through
 * `@pwngh/money`'s WASM fold instead of a boxed-`bigint` loop over object legs. The column carries
 * the value the scalar loop would have summed; the fold only changes how it is summed.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/performance/#columnar-fold Columnar fold}
 */

import { createFold, foldRef } from '#src/fold.vendored.ts';
import { fault, ERROR_CODES } from '#src/errors.ts';

import type { Fold } from '#src/fold.vendored.ts';

/**
 * A growable `BigInt64Array` that pushes and pops one value at a time, like a Vec. Capacity doubles
 * on overflow; `pop` only shrinks the live length, so a rolled-back posting leaves the buffer sized
 * for the next one. `view` is the live prefix — what a fold reads.
 */
export class I64Column {
  private buffer: BigInt64Array;
  private size = 0;

  constructor(capacity = 8) {
    this.buffer = new BigInt64Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  push(value: bigint): void {
    if (this.size === this.buffer.length) {
      const grown = new BigInt64Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.size] = value;
    this.size += 1;
  }

  pop(): void {
    if (this.size > 0) {
      this.size -= 1;
    }
  }

  view(): BigInt64Array {
    return this.buffer.subarray(0, this.size);
  }
}

// The fold copies the column into WebAssembly memory before summing, so its fixed cost only pays off
// once a column runs to a few hundred legs — the hot platform accounts, not an ordinary wallet.
// Below this, a plain loop is cheaper and just as correct.
const FOLD_MIN_LEGS = 256;

// Instantiated once, reused for every fold. `undefined` means not yet tried; `null` means this
// runtime has no WebAssembly, so the pure-`bigint` reference stands in for the process.
let folder: Fold | null | undefined;

function resolveFolder(): Fold | null {
  if (folder === undefined) {
    try {
      folder = createFold();
    } catch {
      folder = null;
    }
  }
  return folder;
}

/**
 * Sums a column to one balance. Small columns take a plain loop; larger ones fold in WebAssembly,
 * falling back to the same-result `bigint` reference where WebAssembly is unavailable. The fold
 * checks every intermediate against the 64-bit range the ledger stores, so an unstorable running
 * total surfaces as {@link ERROR_CODES.AMOUNT_OVERFLOW} rather than a raw trap.
 */
export function foldColumn(column: I64Column): bigint {
  const view = column.view();
  if (view.length < FOLD_MIN_LEGS) {
    let sum = 0n;
    for (let i = 0; i < view.length; i += 1) {
      sum += view[i]!;
    }
    return sum;
  }
  const wasm = resolveFolder();
  try {
    return wasm ? wasm.fold(view) : foldRef(view);
  } catch (error) {
    // Only the overflow signals map to the ledger fault: the RangeError both implementations
    // throw, or a raw trap should one ever escape the vendored wrapper. Anything else is a real
    // failure and propagates as itself.
    const overflow =
      error instanceof RangeError ||
      (typeof WebAssembly !== 'undefined' &&
        error instanceof WebAssembly.RuntimeError);
    if (!overflow) {
      throw error;
    }
    throw fault(
      ERROR_CODES.AMOUNT_OVERFLOW,
      'Re-derived balance leaves the 64-bit range the ledger stores.',
    );
  }
}
