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
 * A seeded stream of i64-safe signed deltas, shared by the fold suite and the bench so both
 * exercise the same column shape. 32-bit values, so thousands sum well inside the i64 range.
 */
export function seededDeltas(count: number): bigint[] {
  const out: bigint[] = [];
  let seed = 0x2545f4914f6cdd1dn;
  for (let i = 0; i < count; i += 1) {
    seed =
      (seed * 6364136223846793005n + 1442695040888963407n) &
      0xffffffffffffffffn;
    out.push(BigInt.asIntN(32, seed));
  }
  return out;
}
