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
 * How many Node HTTP bridges this tree holds, and which.
 *
 * The lab answers `Request` with `Response`. Bun and Deno serve that directly; Node does not, so
 * somebody has to convert, and for a long time everybody did — five files were counted before
 * anyone asked what was being counted. `src/adapters/http-node.ts` is now the one the lab
 * exports, and this roster is the record of who has not moved onto it yet.
 *
 * **A file is a Node HTTP bridge when it holds both halves of the conversion**: it builds a Fetch
 * `Request` out of what arrived, and it writes a Node response head to answer. Either half alone
 * is something else — `src/server.ts` builds Requests and never touches a socket, and
 * `site/src/dev.mjs` writes response heads for files off disk with no Fetch handler in sight.
 * Composing an exported bridge is not bridging: `packages/adapters`' express and fastify seams
 * hold neither half, because they call converters they import. That is why they are absent here
 * rather than exempted, and it is what makes this count mean something.
 *
 * The roster is the countable form of the toolchain plan's S3 done-condition.
 *
 * The count is of the conversion, not of who serves. `packages/core/src/host.ts` stopped serving
 * when `Q91` put its `listen()` on the lab's `serveNode`, and stayed on the roster: it still
 * writes both halves, for the express and fastify seams to compose. Getting it off means the lab
 * exporting a converter that takes an already-buffered body, and core dropping two names it
 * publishes — a bump change, so it waits for one. Until that bump lands, **two is the floor**:
 * the lab's own and core's published pair.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Builds a Fetch `Request` out of what arrived. */
const INBOUND = /new Request\(/;

/** Writes a Node response head, which is how a `Response` gets back onto the socket. */
const OUTBOUND = /\.writeHead\(/;

const isBridge = (text: string): boolean =>
  INBOUND.test(text) && OUTBOUND.test(text);

/**
 * This file, which carries bridge-shaped control texts on purpose and would otherwise count
 * itself. Excluded by name rather than by a cleverness in the walk, and asserted below to be
 * bridge-shaped — if it ever stops being, the controls have stopped controlling anything.
 */
const SELF = 'test/node-bridge.test.ts';

/** Emitted output and dependencies: not sources anybody wrote. */
const NOT_SOURCE = new Set([
  'node_modules',
  'dist',
  'dist-site',
  'docs',
  'build',
  'coverage',
  '.build-tmp',
  '.git',
  '.wrangler',
]);

const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;

/**
 * Every Node HTTP bridge in the tree, with why it is still its own.
 *
 * One entry is the lab's; the rest are copies waiting on a migration. An entry that leaves must
 * leave this map with it, and one that arrives has to be argued for here.
 */
const BRIDGES = new Map<string, string>([
  [
    'src/adapters/http-node.ts',
    'the one the lab exports, as serveNode on ./adapters; every other line of this map is a copy of it',
  ],
  [
    'packages/core/src/host.ts',
    'no longer serves — Q91 put listen() on the lab’s serveNode — but still holds both halves as the pair it publishes on ./internal, because the express and fastify seams need a buffered-body override the lab’s converter does not take',
  ],
]);

/**
 * Files whose classification is asserted directly, so both halves of the rule are shown reading
 * real source on every run rather than only agreeing on an empty set.
 *
 * `packages/client/test/live.test.ts` is here because it left the roster: `Q92` put its `mount()`
 * on the lab's `serveNode`, and a migration that is only an absence is indistinguishable from a
 * file the walk stopped reaching. Its verdict is resolved on every run instead.
 */
const CLASSIFIED = new Map<string, 'inbound' | 'outbound' | 'neither'>([
  ['src/server.ts', 'inbound'],
  ['site/src/dev.mjs', 'outbound'],
  ['test/acceptance/smoke.test.ts', 'outbound'],
  ['packages/adapters/src/lib/express.ts', 'neither'],
  ['packages/adapters/src/lib/fastify.ts', 'neither'],
  ['packages/client/test/live.test.ts', 'neither'],
]);

/** One file per tree the walk must reach, so a walker pointed short of one is caught. */
const WITNESSES = [
  'src/server.ts',
  'scripts/check.ts',
  'economy/app.ts',
  'test/serve-node.test.ts',
  'packages/core/src/host.ts',
  'packages/client/test/live.test.ts',
  'apps/console/app/economy.ts',
];

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_SOURCE.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, found);
    } else if (SOURCE.test(entry.name)) {
      found.push(relative(ROOT, path));
    }
  }
  return found;
}

const files = walk(ROOT).sort();
const read = new Map(
  files.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]),
);
const bridges = files.filter(
  (file) => file !== SELF && isBridge(read.get(file)!),
);

// The rule has to say yes to one shape and no to three others, demonstrated on this run against
// text written here. A classifier that has quietly stopped matching says no to everything, and
// every assertion below it would pass.
test('the rule answers both ways, shown on control text', () => {
  const bridgeShaped = `
    const request = new Request(url, { method });
    response.writeHead(answered.status);
  `;
  const inboundOnly = 'const request = new Request(url, { method });';
  const outboundOnly = 'response.writeHead(200); response.end(bytes);';
  const neither = 'export const port = 8080;';

  assert.deepEqual(
    [bridgeShaped, inboundOnly, outboundOnly, neither].map(isBridge),
    [true, false, false, false],
  );
  assert.deepEqual(
    [INBOUND.test(inboundOnly), OUTBOUND.test(inboundOnly)],
    [true, false],
    'the two halves are not one probe wearing two names',
  );
  assert.deepEqual(
    [INBOUND.test(outboundOnly), OUTBOUND.test(outboundOnly)],
    [false, true],
  );
});

test('the walk reaches every tree, and this file is the one it must skip', () => {
  for (const witness of WITNESSES) {
    assert.ok(
      files.includes(witness),
      `${witness} was not walked, so its tree was not read`,
    );
  }
  assert.ok(
    files.includes(SELF),
    `${SELF} was not walked, so skipping it proves nothing`,
  );
  assert.equal(
    isBridge(read.get(SELF)!),
    true,
    `${SELF} is skipped because it is bridge-shaped, and it no longer is`,
  );
});

// Each half is shown resolving a real file to a real verdict. Both halves agreeing on an empty
// set is what a broken probe also looks like.
test('each half of the rule reads real source, file by file', () => {
  for (const [file, expected] of CLASSIFIED) {
    const text = read.get(file);
    assert.ok(text, `${file} is classified here and was not walked`);
    const verdict = INBOUND.test(text!)
      ? OUTBOUND.test(text!)
        ? 'both'
        : 'inbound'
      : OUTBOUND.test(text!)
        ? 'outbound'
        : 'neither';
    assert.equal(verdict, expected, `${file} classified as ${verdict}`);
  }
  assert.equal(CLASSIFIED.size, 6);
});

test('the tree holds exactly the Node HTTP bridges the roster names', () => {
  assert.deepEqual(bridges, [...BRIDGES.keys()].sort());

  for (const [file, reason] of BRIDGES) {
    assert.ok(
      existsSync(join(ROOT, file)),
      `${file} is on the roster and is not there`,
    );
    assert.ok(
      reason.length > 20,
      `${file} is on the roster with no reason worth reading`,
    );
  }
});

// The number S3 was done against, now at its floor. It is written here rather than in a plan so
// that the next copy fails a test instead of joining a tally nobody recomputes.
test('there are two Node HTTP bridges, one of them the lab’s own', () => {
  assert.equal(bridges.length, 2);
  assert.ok(
    bridges.includes('src/adapters/http-node.ts'),
    'the lab exports no Node bridge, so every other entry here has nothing to migrate onto',
  );
});
