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
 * Backs the README's "runtime deps: 0" badge with an enforced invariant: the manifest may never
 * grow a `dependencies` field, and every integration a backend needs stays an optional peer the
 * host application opts into.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Manifest = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const manifest: Manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

describe('package manifest', () => {
  test('declares zero runtime dependencies', () => {
    assert.equal(
      manifest.dependencies,
      undefined,
      'package.json grew a "dependencies" field; the README badge and the zero-dep guarantee both just broke',
    );
  });

  test('every peer dependency is marked optional', () => {
    const peers = Object.keys(manifest.peerDependencies ?? {}).sort();
    const meta = manifest.peerDependenciesMeta ?? {};

    assert.notEqual(peers.length, 0);
    for (const name of peers) {
      assert.equal(
        meta[name]?.optional,
        true,
        `peer "${name}" must be optional`,
      );
    }
    // No stray meta entry for a peer that does not exist.
    assert.deepEqual(Object.keys(meta).sort(), peers);
  });
});
