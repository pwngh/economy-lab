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
 * Verifies the vendored files against their `@pwngh/money` source (the exact-pinned dev
 * dependency): money and db must be byte-identical; fold must match after undoing its reflow,
 * and its provenance header must name the pinned version.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { format } from 'prettier';

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8');
const upstream = (file: string) =>
  read(`../node_modules/@pwngh/money/src/${file}`);

describe('vendored @pwngh/money source', () => {
  for (const file of ['money', 'db']) {
    test(`src/${file}.vendored.ts is byte-identical to upstream`, () => {
      assert.equal(
        read(`../src/${file}.vendored.ts`),
        upstream(`${file}.ts`),
        `src/${file}.vendored.ts drifted from @pwngh/money's src/${file}.ts; re-vendor rather than patching in place`,
      );
    });
  }

  test('fold provenance header names the pinned upstream version', () => {
    const pinned: string = JSON.parse(
      read('../node_modules/@pwngh/money/package.json'),
    ).version;
    const claimed = read('../src/fold.vendored.ts').match(
      /Vendored from @pwngh\/money@(\d+\.\d+\.\d+)/,
    )?.[1];
    assert.equal(
      claimed,
      pinned,
      'the header and the dev-dependency pin must move together',
    );
  });

  test('src/fold.vendored.ts matches upstream once the reflow is undone', async () => {
    const provenance =
      / \*\n \* Vendored from @pwngh\/money@[^]*?identical\.\n/;
    const vendored = read('../src/fold.vendored.ts');
    assert.match(vendored, provenance);
    // The same formatter and options both files answer to; any surviving difference is content.
    const options = { parser: 'typescript' as const, singleQuote: true };
    assert.equal(
      await format(vendored.replace(provenance, ''), options),
      await format(upstream('fold.ts'), options),
      "src/fold.vendored.ts drifted from @pwngh/money's src/fold.ts beyond the documented reflow",
    );
  });
});
