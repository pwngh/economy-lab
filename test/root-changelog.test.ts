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
 * The root CHANGELOG gate. `test/package-readmes.test.ts` reads `packages/*` and nothing else, so
 * until this file existed the root CHANGELOG was the one product document in the tree that no test
 * read. Three false claims reached it that way: a package that does not exist, a CLI verb that is
 * not a verb, and a root export the umbrella has never had.
 *
 * Only the undated section is read, for the same reason the package gate skips dated ones — a
 * released section records what shipped, and the symbols it names are free to be renamed later.
 * Every check here is a claim about what is true right now.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import '#test/support/dist-guard.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE_MODULES = join(ROOT, 'node_modules');

/** The blocks still being written. A dated heading closes the slice until the next undated one. */
function undated(md: string): string {
  const lines: string[] = [];
  let open = true;
  for (const line of md.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) open = !/\d{4}-\d{2}-\d{2}/.test(heading[1]!);
    if (open) lines.push(line);
  }
  return lines.join('\n');
}

const CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const TEXT = undated(CHANGELOG);

/** Inline code spans outside every fence: where this document makes its claims. */
function spans(md: string): string[] {
  const out: string[] = [];
  for (const m of md.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g))
    out.push(m[1]!);
  return out;
}

const SPANS = [...new Set(spans(TEXT))];

// ---------------------------------------------------------------------------
// Specifiers
// ---------------------------------------------------------------------------

test('every @pwngh specifier the root CHANGELOG names is one that resolves', () => {
  let seen = 0;
  for (const m of TEXT.matchAll(
    /@pwngh\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*/g,
  )) {
    const spec = m[0];
    const bare = spec.split('/').slice(0, 2).join('/');
    seen += 1;
    assert.ok(
      existsSync(join(NODE_MODULES, bare, 'package.json')),
      `names ${spec}, and ${bare} is not a package`,
    );
    if (spec === bare) continue;
    let opens = true;
    try {
      import.meta.resolve(spec);
    } catch {
      opens = false;
    }
    assert.ok(opens, `names ${spec}, which ${bare} does not export`);
  }
  assert.equal(seen, 10, `read ${seen} @pwngh specifiers`);
});

// ---------------------------------------------------------------------------
// Subpaths, in both directions
// ---------------------------------------------------------------------------

const LAB_EXPORTS = Object.keys(
  (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    }
  ).exports,
);

const PUBLISHED_EXPORTS = Object.keys(
  (
    JSON.parse(
      readFileSync(
        join(ROOT, 'test/fixtures/lab-published-exports.json'),
        'utf8',
      ),
    ) as { exports: Record<string, unknown> }
  ).exports,
);

/**
 * The subpaths this release says it removed. Naming them is the whole point of the entry, so the
 * gate reads it in both directions: each has to be gone from the map now, and each has to have
 * been on the published one. A removal of something that never shipped is a fabricated break.
 */
const REMOVED_SUBPATHS = [
  './adapters/redis',
  './adapters/sqs',
  './engines/postgres',
  './engines/mysql',
  './engines/mysql-mariadb',
  './ops',
  './testing',
];

test('a subpath the root CHANGELOG names as removed is gone, and did ship', () => {
  for (const sub of REMOVED_SUBPATHS) {
    assert.ok(
      TEXT.includes(`\`${sub}\``),
      `${sub} is listed as removed here and the CHANGELOG does not name it`,
    );
    assert.ok(
      !LAB_EXPORTS.includes(sub),
      `the CHANGELOG says ${sub} is gone, and the exports map still carries it`,
    );
    assert.ok(
      PUBLISHED_EXPORTS.includes(sub),
      `the CHANGELOG says ${sub} was removed, and 0.7.0 never published it`,
    );
  }
  assert.equal(REMOVED_SUBPATHS.length, 7);
  // The removals and the map have to account for each other: 15 published, 6 gone, 4 new.
  assert.deepEqual(
    PUBLISHED_EXPORTS.filter((s) => !LAB_EXPORTS.includes(s)).sort(),
    [...REMOVED_SUBPATHS].sort(),
    'the map lost a subpath the CHANGELOG does not record',
  );
});

test('every other lab subpath the root CHANGELOG names is on the exports map', () => {
  let seen = 0;
  for (const span of SPANS) {
    if (!/^\.(\/[a-z0-9][a-z0-9-]*)*$/.test(span)) continue;
    if (REMOVED_SUBPATHS.includes(span)) continue;
    seen += 1;
    assert.ok(
      LAB_EXPORTS.includes(span),
      `names the subpath ${span}, which the exports map does not carry`,
    );
  }
  assert.equal(seen, 8, `read ${seen} live subpaths`);
});

// ---------------------------------------------------------------------------
// Verbs and paths
// ---------------------------------------------------------------------------

// The check that would have caught `economy inspect`.
test('every `economy` command the root CHANGELOG names is a verb the bin dispatches', async () => {
  const { VERBS } =
    (await import('../packages/cli/dist/lib/parse-args.js')) as {
      VERBS: string[];
    };
  assert.ok(VERBS.length > 0, 'the verb roster loaded');
  let seen = 0;
  // The bin's roster rides one span as a pipe-separated list, which is how it reads to a user.
  for (const span of SPANS) {
    if (!/^[a-z]+( \| [a-z]+)+$/.test(span)) continue;
    for (const verb of span.split(' | ')) {
      seen += 1;
      assert.ok(
        VERBS.includes(verb),
        `names \`${verb}\`, which is not a verb (roster: ${VERBS.join(' ')})`,
      );
    }
  }
  for (const m of TEXT.matchAll(/`economy ([a-z-]+)[^`]*`/g)) {
    seen += 1;
    assert.ok(
      VERBS.includes(m[1]!),
      `names \`economy ${m[1]}\`, which is not a verb (roster: ${VERBS.join(' ')})`,
    );
  }
  assert.equal(seen, 6, `read ${seen} economy verbs`);
});

const isDir = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

// The check that would have caught `packages/economy-react`.
test('every repository path the root CHANGELOG names is on disk', () => {
  let examined = 0;
  for (const span of SPANS) {
    if (!span.includes('/') || /[\s()<>*?"'=@$:{}|]/.test(span)) continue;
    if (span.startsWith('.') || span.startsWith('/') || span.startsWith('-'))
      continue;
    const head = span.replace(/\/+$/, '').split('/')[0]!;
    if (!isDir(join(ROOT, head))) continue;
    examined += 1;
    const rel = span.replace(/\/+$/, '');
    assert.ok(
      existsSync(join(ROOT, rel)),
      `names ${span}, which is not at ${rel}`,
    );
  }
  assert.equal(examined, 10, `read ${examined} repository paths`);
});
