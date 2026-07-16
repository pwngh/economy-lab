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
 * The store implementer's toolkit. The conformance suite (the `/testing` entry point) is the
 * public invitation to bring your own {@link Store}; these are the primitives a conforming
 * implementation needs to compute the same chain hashes, balance deltas, orderings, and wire
 * encodings the built-in engines compute — without reaching into unsupported internals.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the Store
 *   port and the conformance suite that holds every implementation to identical behavior.
 */

export { chainHash, balanceDelta, GENESIS, GENESIS_HEX } from '#src/ledger.ts';
export { baseOf, shardRef, shardsOf, walletKindOf } from '#src/accounts.ts';
export { byCodeUnit, fromHex, toHex } from '#src/bytes.ts';
export { metaString, metaNumber } from '#src/meta.ts';
export { encodeAmounts, decodeAmounts } from '#src/money.ts';
export { VELOCITY_CURRENCY } from '#src/trust.ts';

export type { AccountKind } from '#src/accounts.ts';
