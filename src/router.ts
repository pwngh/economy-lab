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

// The provided tool behind the documented host boundary (see openInstanceEconomies,
// src/instance.ts): every caller must send a given scope key (world instance, region shard) to
// the same economy node for the scope's life, so exactly one lane ever accepts its movements.
// The rendezvous construction itself is documented on scopeRouter.

import { ERROR_CODES, fault } from '#src/errors.ts';

// FNV-1a, 64-bit: deterministic across processes and platforms (no seed, pure integer math),
// which is the property the router needs — every node computes the same assignment.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

// FNV alone avalanches too weakly for rendezvous comparison — the node prefix dominates the
// high bits and one node wins every scope. This finalizer (the splitmix64/murmur3 fmix64
// constants) diffuses every input bit across the word.
function mix64(input: bigint): bigint {
  let x = input;
  x ^= x >> 33n;
  x = (x * 0xff51afd7ed558ccdn) & MASK_64;
  x ^= x >> 33n;
  x = (x * 0xc4ceb9fe1a85ec53n) & MASK_64;
  x ^= x >> 33n;
  return x;
}

/**
 * Builds the assignment function over a fixed node list, by rendezvous (highest-random-weight)
 * hashing: each node's weight for a scope is a deterministic hash of (node, scope) and the
 * scope belongs to the highest, so every node computes the same owner with no ring state to
 * coordinate, and a membership change reassigns only the departed or arrived node's scopes.
 * Every process in the deployment must construct it from the same list (order does not matter;
 * the hash does not depend on position) for the assignments to agree. Throws CONFIG_INVALID on
 * an empty or duplicate-bearing node list.
 *
 * The router only decides where new epochs open: live sessions on a moved scope finish via
 * epoch rotation and the orphan sweep (src/worker/orphans.ts).
 *
 * @example
 * const route = scopeRouter(['economy-a', 'economy-b', 'economy-c']);
 * const node = route(worldInstanceId); // send this scope's traffic to `node`
 */
export function scopeRouter(
  nodes: ReadonlyArray<string>,
): (scope: string) => string {
  if (nodes.length === 0) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'scopeRouter needs at least one node.',
      {
        retryable: false,
      },
    );
  }
  if (new Set(nodes).size !== nodes.length) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'scopeRouter node names must be distinct.',
      { retryable: false, detail: { nodes: [...nodes] } },
    );
  }
  const list = [...nodes];
  return (scope) => {
    let winner = list[0]!;
    let best = -1n;
    for (const node of list) {
      const weight = mix64(fnv1a64(`${node}\n${scope}`));
      if (weight > best) {
        best = weight;
        winner = node;
      }
    }
    return winner;
  };
}
