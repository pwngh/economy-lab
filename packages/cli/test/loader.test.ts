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
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEconomyDir } from '../src/lib/module.js';
import { canonicalForm } from '@pwngh/economy-test';
import { PKG, runSync } from './support/process.js';

const run = (args: string[], cwd = PKG) => runSync(args, cwd);

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'economy-dir-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

const APP =
  'export const authenticate = false;\nexport const worker = { intervalMs: 5_000 };\n';
const CHECKOUT =
  'export async function post({ principal }: { principal: { userId: string } | null }) {\n' +
  '  return new Response(JSON.stringify(principal), { status: 201 });\n}\n';
const GIFT = 'export function get() { return new Response("gift"); }\n';
const STEAM =
  'export function decode(raw: unknown) {\n' +
  '  const r = raw as { id: string; user: string };\n' +
  '  return { provider: "steam", eventId: r.id, userId: r.user,\n' +
  '    amount: { currency: "CREDIT", minor: 100n }, source: "steam" };\n}\n';

test('golden: the directory tree and the equivalent single file resolve to one canonical form', async () => {
  const dir = tree({
    'economy/app.ts': APP,
    'economy/auth.ts': 'export const unrelated = 1;\n', // theirs — the loader never reads it
    'economy/routes/checkout.ts': CHECKOUT,
    'economy/routes/shop/gift.ts': GIFT,
    'economy/routes/webhooks/steam.ts': STEAM,
    // The equivalent single file, importing the very same route modules.
    'single.app.ts':
      'import { post } from "./economy/routes/checkout.ts";\n' +
      'import { get } from "./economy/routes/shop/gift.ts";\n' +
      'import { decode } from "./economy/routes/webhooks/steam.ts";\n' +
      'export const authenticate = false;\n' +
      'export const worker = { intervalMs: 5_000 };\n' +
      'export const routes = { "POST /checkout": post, "GET /shop/gift": get };\n' +
      'export const providers = { steam: decode };\n',
  });
  const fromDir = await loadEconomyDir(join(dir, 'economy'), { label: 'x' });
  const single = await import(join(dir, 'single.app.ts'));
  const { resolveEconomyModule } = await import('@pwngh/economy-core/module');
  const fromFile = resolveEconomyModule({ ...single }, 'x');
  assert.equal(
    JSON.stringify(canonicalForm({ ...fromDir })),
    JSON.stringify(canonicalForm({ ...fromFile })),
    'byte-identical canonical form',
  );
  assert.deepEqual(
    fromDir.exports,
    ['authenticate', 'providers', 'routes', 'worker'],
    'exports sort like an ESM namespace, matching the single file',
  );

  // canonicalForm renders a function as `[fn <name>]`, so the golden above discriminates the two
  // trees only because each fixture picked a distinct export name. Two route files both exporting
  // `get` produce identical forms, and a loader that bound b's handler to `GET /a` passes. Identity
  // is what matters, so each handler is called and its own answer read.
  const answer = async (key: `GET /${string}` | `POST /${string}`) => {
    const handler = fromDir.routes?.[key];
    assert.ok(handler !== undefined, `${key} is not mounted`);
    const response = await (
      handler as (input: { principal: null }) => Promise<Response> | Response
    )({ principal: null });
    return `${response.status} ${await response.text()}`;
  };
  assert.deepEqual(Object.keys(fromDir.routes ?? {}).sort(), [
    'GET /shop/gift',
    'POST /checkout',
  ]);
  assert.equal(await answer('GET /shop/gift'), '200 gift');
  assert.equal(await answer('POST /checkout'), '201 null');
  assert.deepEqual(Object.keys(fromDir.providers ?? {}), ['steam']);
});

test('fail closed: unknown exports, non-route files, after/, decode outside webhooks, double owners', async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [
      { 'e/app.ts': APP, 'e/routes/x.ts': 'export const helper = 1;\n' },
      /UNKNOWN_EXPORT.*routes\/x#helper/s,
    ],
    [
      { 'e/app.ts': APP, 'e/routes/notes.md': '# hi\n' },
      /SEAM_SHAPE.*only route modules/s,
    ],
    [
      { 'e/app.ts': APP, 'e/after/sale.ts': 'export const x = 1;\n' },
      /SEAM_SHAPE.*after.*export of app\.ts/s,
    ],
    [
      { 'e/app.ts': APP, 'e/routes/x.ts': 'export function decode() {}\n' },
      /UNKNOWN_EXPORT.*routes\/x#decode/s,
    ],
    [
      {
        'e/app.ts': APP,
        'e/routes/x.ts':
          'export function get() {}\nexport function decode() {}\n',
      },
      /UNKNOWN_EXPORT.*routes\/x#decode/s,
    ],
    [
      {
        'e/app.ts': APP,
        'e/routes/webhooks/steam.ts': 'export function post() {}\n',
      },
      /UNKNOWN_EXPORT.*webhooks\/steam#post/s,
    ],
    // A named export beside a default: the loader reads `x` first, so this case names `x` and
    // exercises no default handling at all — dropping `export default x` leaves it identical.
    [
      {
        'e/app.ts': APP,
        'e/routes/x.ts': 'export const x = 1;\nexport default x;\n',
      },
      /UNKNOWN_EXPORT.*routes\/x#x/s,
    ],
    // Default handling, therefore, needs a file with nothing else on it.
    [
      {
        'e/app.ts': APP,
        'e/routes/d.ts':
          'export default function () { return new Response("d"); }\n',
      },
      /UNKNOWN_EXPORT.*routes\/d#default/s,
    ],
    [
      {
        'e/app.ts': `${APP}export const routes = {};\n`,
        'e/routes/x.ts': GIFT,
      },
      /ROLE_CONFLICT.*one owner/s,
    ],
    // A known export name with the wrong shape is a different fault from an unknown name, and
    // it is SEAM_SHAPE on both paths — the webhook side used to call it UNKNOWN_EXPORT.
    [
      { 'e/app.ts': APP, 'e/routes/x.ts': 'export const get = 1;\n' },
      /SEAM_SHAPE.*routes\/x#get/s,
    ],
    [
      {
        'e/app.ts': APP,
        'e/routes/webhooks/steam.ts': 'export const decode = 1;\n',
      },
      /SEAM_SHAPE.*webhooks\/steam#decode/s,
    ],
  ];
  // A table-driven loop that finds nothing passes every assertion inside it: truncate `cases` to
  // [] and this test reports green having refused nothing.
  assert.equal(cases.length, 11, `the case table holds ${cases.length} shapes`);
  for (const [files, expected] of cases) {
    const dir = tree(files);
    await assert.rejects(loadEconomyDir(join(dir, 'e')), expected);
  }
  const missing = tree({ 'e/routes/x.ts': GIFT });
  await assert.rejects(
    loadEconomyDir(join(missing, 'e')),
    /NOT_FOUND.*app\.ts/s,
  );
});

// Two files resolving to one address was last-write-wins — `.ts` sorts after `.js`, so a project
// with tsc output beside its sources silently got the TypeScript handler. The discard was the
// visible half; the fault is that the losing file was imported first, which runs it.
test('two files at one address refuse by name, and neither of them runs', async () => {
  const ran = join(mkdtempSync(join(tmpdir(), 'economy-ran-')), 'ran.log');
  const marks = (name: string) =>
    "import { appendFileSync } from 'node:fs';\n" +
    `appendFileSync(${JSON.stringify(ran)}, '${name}\\n');\n`;
  const collisions: Array<[Record<string, string>, RegExp]> = [
    [
      {
        'e/app.ts': APP,
        'e/routes/gift.js': `${marks('gift.js')}export function get() { return new Response("js"); }\n`,
        'e/routes/gift.ts': `${marks('gift.ts')}${GIFT}`,
      },
      /ROLE_CONFLICT.*routes\/gift.*routes\/gift\.js and routes\/gift\.ts/s,
    ],
    [
      {
        'e/app.ts': APP,
        'e/routes/webhooks/steam.js': `${marks('steam.js')}${STEAM}`,
        // The empty half used to pass the "exports one decode" guard, because the guard read a
        // map the earlier file had already filled.
        'e/routes/webhooks/steam.ts': `${marks('steam.ts')}export const unused = 1;\n`,
      },
      /ROLE_CONFLICT.*webhooks\/steam.*steam\.js and .*steam\.ts/s,
    ],
    // The collision index makes possible: shop.ts and shop/index.ts both address /shop. The
    // directory sorts before its same-stem file, so the claim walk meets it before either loads.
    [
      {
        'e/app.ts': APP,
        'e/routes/shop.ts': `${marks('shop.ts')}${GIFT}`,
        'e/routes/shop/index.ts': `${marks('shop/index.ts')}${GIFT}`,
      },
      /ROLE_CONFLICT.*routes\/shop.*routes\/shop\.ts and routes\/shop\/index\.ts/s,
    ],
  ];
  assert.equal(collisions.length, 3, `${collisions.length} collision shapes`);
  for (const [files, expected] of collisions) {
    const dir = tree(files);
    await assert.rejects(loadEconomyDir(join(dir, 'e')), expected);
  }
  assert.equal(
    existsSync(ran) ? readFileSync(ran, 'utf8') : '',
    '',
    'a file the loader was about to discard was imported, which runs it',
  );

  // Positive control: the same names one extension apart in different directories still mount.
  const fine = tree({
    'e/app.ts': APP,
    'e/routes/gift.ts': GIFT,
    'e/routes/shop/gift.js':
      'export function get() { return new Response("s"); }\n',
    'e/routes/webhooks/steam.ts': STEAM,
  });
  const mod = await loadEconomyDir(join(fine, 'e'));
  assert.deepEqual(Object.keys(mod.routes ?? {}).sort(), [
    'GET /gift',
    'GET /shop/gift',
  ]);
  assert.deepEqual(Object.keys(mod.providers ?? {}), ['steam']);
});

// `routes/index.ts` used to mount `GET /index`, and no directory-form file could own the root
// path, though the single-file form can write `'GET /'` — the two forms were not equivalent.
test('an index file addresses its containing path, the root included', async () => {
  const dir = tree({
    'e/app.ts': APP,
    'e/routes/index.ts':
      'export function get() { return new Response("root"); }\n',
    'e/routes/shop/index.ts':
      'export function get() { return new Response("shop"); }\n',
    'e/routes/shop/gift.ts': GIFT,
  });
  const mod = await loadEconomyDir(join(dir, 'e'));
  assert.deepEqual(Object.keys(mod.routes ?? {}).sort(), [
    'GET /',
    'GET /shop',
    'GET /shop/gift',
  ]);
  // Identity, not presence: each address answers with its own file's body.
  const answer = async (key: `GET /${string}`) => {
    const handler = mod.routes?.[key];
    assert.ok(handler !== undefined, `${key} is not mounted`);
    return (await (handler as () => Promise<Response> | Response)()).text();
  };
  assert.equal(await answer('GET /'), 'root');
  assert.equal(await answer('GET /shop'), 'shop');
  assert.equal(await answer('GET /shop/gift'), 'gift');
});

// `after/` outside app.ts refuses by name and says where it belongs. A top-level `webhooks/` —
// the obvious place, the directory being named for the role — was read by nothing at all.
test('a webhooks/ directory outside routes/ refuses by name rather than mounting nothing', async () => {
  const dir = tree({ 'e/app.ts': APP, 'e/webhooks/steam.ts': STEAM });
  await assert.rejects(
    loadEconomyDir(join(dir, 'e')),
    /SEAM_SHAPE.*webhooks.*routes\/webhooks\//s,
  );
  // Positive control: in its own place it mounts.
  const right = tree({ 'e/app.ts': APP, 'e/routes/webhooks/steam.ts': STEAM });
  const mod = await loadEconomyDir(join(right, 'e'));
  assert.deepEqual(Object.keys(mod.providers ?? {}), ['steam']);
});

// Every assertion this leg used to make was "this key is present", which is why three source
// defects — a missing route key, a misplaced one, and a handler bound to the wrong address — all
// passed straight through it. Absence is the property that matters, so the module's contribution is
// read as a complete set from the machine-readable output.
test('the bin accepts the directory form and mounts exactly the tree it walked', () => {
  const dir = tree({
    'economy/app.ts': APP,
    'economy/routes/checkout.ts': CHECKOUT,
    'economy/routes/shop/gift.ts': GIFT,
    'economy/routes/webhooks/steam.ts': STEAM,
  });

  const moduleRoutes = (stdout: string): string[] => {
    const report = JSON.parse(stdout) as {
      routes: Array<{ method: string; path: string; source: string }>;
    };
    assert.ok(
      report.routes.length > 12,
      `the product table is missing: ${report.routes.length} routes in all`,
    );
    return report.routes
      .filter((route) => route.source === 'module')
      .map((route) => `${route.method} ${route.path}`)
      .sort();
  };

  const explicit = run(['routes', '--json', '--app', join(dir, 'economy')]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(
    moduleRoutes(explicit.stdout),
    ['GET /shop/gift', 'POST /checkout'],
    'the module owns these two addresses and no others',
  );

  const byDefault = run(['routes', '--json'], dir);
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.deepEqual(
    moduleRoutes(byDefault.stdout),
    moduleRoutes(explicit.stdout),
    'the default discovery finds the same tree --app names',
  );

  const table = run(['routes', '--app', join(dir, 'economy')]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /providers steam/);
});
