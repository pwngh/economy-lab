/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EconomyModuleError } from '@pwngh/economy-core/module';
import { throwingGetter } from '@pwngh/economy-test';
import { loadEconomyDir } from '../src/lib/module.js';

// H3: loadEconomyDir against hostile module namespaces, injected through the importer
// seam. The files on disk anchor the scan; the importer answers whatever shape the case
// needs, exactly the way a CJS-compiled or crafted module would arrive.

function tree(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'economy-fuzz-'));
  writeFileSync(join(dir, 'app.ts'), '');
  mkdirSync(join(dir, 'routes', 'webhooks'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'routes', name), body);
  }
  return dir;
}

const importerFor =
  (answers: Record<string, Record<string, unknown>>) =>
  async (url: string): Promise<Record<string, unknown>> => {
    const file = /([^/]+)\.(ts|mts|mjs|js)\?/.exec(url)?.[1] ?? '?';
    return answers[file] ?? { authenticate: false };
  };

// `/get/` cannot fail here: the fallback fix for any unusable route file is literally "a route file
// exports get, post, put, or delete", so an EMPTY namespace satisfies it too. And `/—|:/` is a
// punctuation check — every EconomyModuleError message carries a colon by construction. The code and
// the specific export are what tell a hostile namespace from an empty one, so both are resolved, and
// the empty case is asserted to refuse for a DIFFERENT reason.
test('a route module with a throwing getter refuses by name — never a raw TypeError', async () => {
  const dir = tree({ 'gift.ts': '' });
  await assert.rejects(
    loadEconomyDir(dir, {
      label: 'shop',
      importer: importerFor({
        gift: throwingGetter('get', new TypeError('lazy require exploded')),
      }),
    }),
    (e: unknown) => {
      assert.ok(EconomyModuleError.is(e), `named refusal, not ${String(e)}`);
      assert.equal(e.code, 'ECONOMY_MODULE.SEAM_SHAPE');
      assert.match(
        e.message,
        /export `get`:/,
        'the throwing export is named, not the roster of legal ones',
      );
      assert.match(
        e.message,
        /reading the export threw \(lazy require exploded\)/,
        "the getter's own failure is carried through",
      );
      return true;
    },
  );

  // The control: nothing hostile, just a file with no handler on it. It must refuse for the other
  // reason, or the assertions above are satisfied by any unusable route file.
  const empty = tree({ 'gift.ts': '' });
  await assert.rejects(
    loadEconomyDir(empty, {
      label: 'shop',
      importer: importerFor({ gift: {} }),
    }),
    (e: unknown) => {
      assert.ok(EconomyModuleError.is(e));
      assert.equal(e.code, 'ECONOMY_MODULE.SEAM_SHAPE');
      assert.doesNotMatch(
        e.message,
        /reading the export threw/,
        'an empty namespace is not a throwing getter',
      );
      return true;
    },
  );
});

test('an app module with a throwing getter refuses the same way', async () => {
  const dir = tree();
  await assert.rejects(
    loadEconomyDir(dir, {
      label: 'shop',
      importer: importerFor({
        app: throwingGetter('policy', new TypeError('lazy require exploded')),
      }),
    }),
    /SEAM_SHAPE.*policy/s,
  );
});

test('frozen namespaces, Symbol keys, and CJS mirrors all load through the seam', async () => {
  const handler = () => new Response('ok');
  const dir = tree({ 'gift.ts': '' });
  const mod = await loadEconomyDir(dir, {
    label: 'shop',
    importer: importerFor({
      app: Object.freeze({
        authenticate: false,
        [Symbol('x')]: 'payload',
      }) as never,
      gift: { __esModule: true, get: handler, default: { get: handler } },
    }),
  });
  assert.deepEqual(Object.keys(mod.routes ?? {}), ['GET /gift']);
  assert.equal(
    Object.getOwnPropertySymbols(mod).length,
    0,
    'no symbol smuggling',
  );
});

test('a prototype-chain decode is not an export: the webhook file refuses with its fix', async () => {
  const dir = tree({ 'webhooks/pay.ts': '' });
  await assert.rejects(
    loadEconomyDir(dir, {
      label: 'shop',
      importer: importerFor({
        pay: Object.create({ decode: () => ({}) }) as never,
      }),
    }),
    (e: unknown) => {
      assert.ok(EconomyModuleError.is(e), `named refusal, not ${String(e)}`);
      assert.equal(e.code, 'ECONOMY_MODULE.SEAM_SHAPE');
      // `/decode/` alone is satisfied by the fix sentence naming the export it wants, so the
      // refusal has to name the file that failed to supply it as an own property.
      assert.match(e.message, /webhooks\/pay/);
      return true;
    },
  );
});
