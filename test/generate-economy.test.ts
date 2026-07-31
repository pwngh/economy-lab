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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// spawnSync waits forever by default, and it blocks the event loop while it does, so a generator
// that stops terminating would wedge the run rather than fail it. The generator writes door stubs
// into a throwaway workspace and returns in well under a second.
const GENERATE_BOUND_MS = 60_000;

interface Sibling {
  readonly exports?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, string>;
  readonly version?: string;
  readonly sources?: Record<string, string>;
}

interface Result {
  readonly code: number | null;
  readonly stderr: string;
  readonly pkg: Record<string, never> & {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional: boolean }>;
    exports?: Record<string, unknown>;
  };
  readonly door: (path: string) => string;
}

const ROOT_EXPORTS = {
  '.': { types: './dist/index.d.ts', default: './dist/index.js' },
  './package.json': './package.json',
};

/**
 * Runs the real generator over a throwaway workspace. The script reads its root three directories
 * up from its own URL, so a copy at <tmp>/packages/economy/scripts sees <tmp>/packages and nothing
 * of this repository. That depth is the wiring the move has to keep: a copy one level off resolves
 * onto a root with no `packages/` and the generator writes nothing.
 */
const GENERATOR = 'packages/economy/scripts/generate.ts';

function generate(
  siblings: Record<string, Sibling>,
  manifest: Record<string, string>,
  seed: Record<string, unknown> = {},
): Result {
  const dir = mkdtempSync(join(tmpdir(), 'economy-generate-'));
  try {
    mkdirSync(join(dir, dirname(GENERATOR)), { recursive: true });
    cpSync(join(ROOT, GENERATOR), join(dir, GENERATOR));
    for (const [name, sibling] of Object.entries(siblings)) {
      const slug = name.replace('@pwngh/economy-', '');
      const home = join(dir, 'packages', slug);
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'package.json'),
        JSON.stringify(
          {
            name,
            version: sibling.version ?? '0.1.0',
            exports: sibling.exports ?? ROOT_EXPORTS,
            ...(sibling.peerDependencies
              ? { peerDependencies: sibling.peerDependencies }
              : {}),
          },
          null,
          2,
        ),
      );
      const sources = sibling.sources ?? {
        'src/index.ts': 'export const go = () => 1;\n',
      };
      for (const [rel, text] of Object.entries(sources)) {
        mkdirSync(dirname(join(home, rel)), { recursive: true });
        writeFileSync(join(home, rel), text);
      }
    }
    const umbrella = join(dir, 'packages', 'economy');
    mkdirSync(umbrella, { recursive: true });
    writeFileSync(join(umbrella, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(
      join(umbrella, 'package.json'),
      JSON.stringify({ name: '@pwngh/economy', version: '0.1.0', ...seed }),
    );
    const run = spawnSync(process.execPath, [join(dir, GENERATOR)], {
      cwd: dir,
      encoding: 'utf8',
      timeout: GENERATE_BOUND_MS,
    });
    // Read before the workspace is swept, so a door is inspected by its contents rather than
    // by a path into a directory that is already gone.
    const doors = new Map<string, string>();
    const walk = (from: string, prefix: string): void => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(from, entry.name), rel);
        else doors.set(rel, readFileSync(join(from, entry.name), 'utf8'));
      }
    };
    const src = join(umbrella, 'src');
    if (existsSync(src)) walk(src, '');
    return {
      code: run.status,
      stderr: run.stderr,
      pkg: JSON.parse(readFileSync(join(umbrella, 'package.json'), 'utf8')),
      door: (path) => doors.get(path) ?? `no door was written at src/${path}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The stub and the exports entry are written from the manifest alone, so an unrefused door
// onto a missing export ships a subpath that resolves to nothing.
test('a door onto an export the package does not have is refused by name', () => {
  const run = generate(
    { '@pwngh/economy-core': {} },
    {
      'economy/app': '@pwngh/economy-core',
      'economy/nope': '@pwngh/economy-core/nope',
    },
  );
  assert.equal(run.code, 1);
  assert.match(
    run.stderr,
    /door "economy\/nope" points at @pwngh\/economy-core\/nope/,
  );
  assert.equal(run.pkg.exports, undefined, 'nothing was written');
});

test('a door onto a package that is not in the workspace is refused by name', () => {
  const run = generate(
    { '@pwngh/economy-core': {} },
    { 'economy/ghost': '@pwngh/economy-ghost' },
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /door "economy\/ghost" names @pwngh\/economy-ghost/);
});

test('a door key not spelled economy/… is refused by name', () => {
  const run = generate(
    { '@pwngh/economy-core': {} },
    { app: '@pwngh/economy-core' },
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /door "app" must be spelled economy/);
});

test('a peer two siblings disagree on is refused, naming both ranges', () => {
  const run = generate(
    {
      '@pwngh/economy-ui': { peerDependencies: { react: '^19.0.0' } },
      '@pwngh/economy-core': { peerDependencies: { react: '^17.0.0' } },
    },
    { 'economy/ui': '@pwngh/economy-ui', 'economy/app': '@pwngh/economy-core' },
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /peer conflict on react: \^19\.0\.0 vs \^17\.0\.0/);
  // src/ is emptied before the doors are written, so a refusal that comes after that leaves
  // a partial tree beside a package.json still describing the run before.
  assert.match(run.door('ui.ts'), /^no door was written/);
  assert.equal(run.pkg.exports, undefined);
});

// No consumer opens every door, so a peer required by one sibling would install React for a
// project that only reads economy/ops.
test('a peer the sibling requires is lifted optional', () => {
  const run = generate(
    { '@pwngh/economy-ui': { peerDependencies: { react: '^19.0.0' } } },
    { 'economy/ui': '@pwngh/economy-ui' },
  );
  assert.equal(run.code, 0);
  assert.deepEqual(run.pkg.peerDependencies, { react: '^19.0.0' });
  assert.deepEqual(run.pkg.peerDependenciesMeta, { react: { optional: true } });
});

// The state a second run meets: react is in the umbrella from the run before, and the sibling
// that asked for it has since dropped it.
test('a peer no sibling asks for is cleared rather than kept', () => {
  const run = generate(
    { '@pwngh/economy-ui': {} },
    { 'economy/ui': '@pwngh/economy-ui' },
    {
      peerDependencies: { react: '^19.0.0' },
      peerDependenciesMeta: { react: { optional: true } },
    },
  );
  assert.equal(run.pkg.peerDependencies, undefined);
  assert.equal(run.pkg.peerDependenciesMeta, undefined);
});

// `export *` from a types-only module is a runtime no-op that still costs a resolution, and
// `export type *` from a module holding an enum drops a binding the consumer calls.
test('the export mode follows what the target actually exports', () => {
  const run = generate(
    {
      '@pwngh/economy-contracts': {
        sources: {
          'src/index.ts': 'export type Wire = { readonly id: string };\n',
        },
      },
      '@pwngh/economy-money': {
        sources: {
          'src/index.ts': 'export enum Currency {\n  Credit = "CREDIT",\n}\n',
        },
      },
    },
    {
      'economy/contracts': '@pwngh/economy-contracts',
      'economy/money': '@pwngh/economy-money',
    },
  );
  assert.match(run.door('contracts.ts'), /^export type \* from/m);
  assert.match(run.door('money.ts'), /^export \* from/m);
});

// The source behind a subpath is read off the package's own exports map, so a subpath that
// sits somewhere other than src/<sub>.ts is still classified from its own file.
test('a subpath is classified from its own source, not the package index', () => {
  const run = generate(
    {
      '@pwngh/economy-core': {
        exports: {
          ...ROOT_EXPORTS,
          './wire': {
            types: './dist/wire/index.d.ts',
            default: './dist/wire/index.js',
          },
        },
        sources: {
          'src/index.ts': 'export const go = () => 1;\n',
          'src/wire/index.ts':
            'export type Envelope = { readonly id: string };\n',
        },
      },
    },
    {
      'economy/app': '@pwngh/economy-core',
      'economy/wire': '@pwngh/economy-core/wire',
    },
  );
  assert.match(run.door('core/wire.ts'), /^export type \* from/m);
  assert.match(run.door('core.ts'), /^export \* from/m);
});

// A hardcoded range ships a wrong dependency the first time a package bumps out of step.
test('the dependency range follows the sibling version', () => {
  const run = generate(
    { '@pwngh/economy-core': { version: '2.5.1' } },
    { 'economy/app': '@pwngh/economy-core' },
  );
  assert.deepEqual(run.pkg.dependencies, { '@pwngh/economy-core': '^2.5.1' });
});
