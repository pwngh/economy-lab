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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');

interface Manifest {
  readonly name?: string;
  readonly bin?: unknown;
  readonly files?: readonly string[];
  readonly exports?: unknown;
  readonly sideEffects?: unknown;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly repository?: { readonly directory?: string };
  readonly publishConfig?: {
    readonly access?: string;
    readonly exports?: unknown;
  };
}

interface Pkg {
  readonly dir: string;
  readonly slug: string;
  readonly name: string;
  readonly json: Manifest;
}

const packages: Pkg[] = readdirSync(PACKAGES, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() && existsSync(join(PACKAGES, d.name, 'package.json')),
  )
  .map((d) => {
    const dir = join(PACKAGES, d.name);
    const json = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    ) as Manifest;
    return { dir, slug: d.name, name: json.name ?? d.name, json };
  });

/** Every leaf string under an exports map, across subpaths and conditions alike. */
function targets(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node === null || typeof node !== 'object') return [];
  return Object.values(node as Record<string, unknown>).flatMap(targets);
}

// A files entry carrying a `*`, or a leading `!`, is a pattern. Only a literal one is a path.
const literal = (entry: string) =>
  !entry.startsWith('!') && !entry.includes('*');

// npm pack drops a listed file that is not there without a word, so the tarball ships
// unlicensed and nothing upstream complains.
test('every package ships the license text its files array promises', () => {
  assert.equal(packages.length, 18, `found ${packages.length} packages`);
  for (const p of packages) {
    const path = join(p.dir, 'LICENSE');
    assert.ok(
      existsSync(path),
      `${p.name}: files claims LICENSE, which is not there`,
    );
    assert.ok(statSync(path).size > 0, `${p.name}: LICENSE is empty`);
  }
});

// A scoped name defaults to restricted, so an unset access turns a public release private.
test('every package publishes public', () => {
  for (const p of packages) {
    assert.equal(
      p.json.publishConfig?.access,
      'public',
      `${p.name}: publishConfig.access must be "public"; @scope defaults to restricted`,
    );
  }
});

test('every literal files entry names something that exists', () => {
  for (const p of packages) {
    for (const entry of p.json.files ?? []) {
      if (!literal(entry)) continue;
      assert.ok(
        existsSync(join(p.dir, entry)),
        `${p.name}: files claims "${entry}", which is not there`,
      );
    }
  }
});

// npm replaces exports wholesale with this at publish, so a subpath added to one and not
// the other disappears from the tarball with nothing in the workspace to catch it.
test('no package redeclares its exports under publishConfig', () => {
  for (const p of packages) {
    assert.equal(
      p.json.publishConfig?.exports,
      undefined,
      `${p.name}: publishConfig.exports replaces exports at publish; keep one map`,
    );
  }
});

// Both spellings count: the dev exports the workspace resolves, and the publishConfig
// exports that overwrite them at publish time.
test('every export target is a built file under dist', () => {
  for (const p of packages) {
    const all = [
      ...targets(p.json.exports),
      ...targets(p.json.publishConfig?.exports),
    ];
    for (const target of all) {
      if (target === './package.json') continue;
      assert.ok(
        target.startsWith('./dist/'),
        `${p.name}: exports names "${target}", which is not under dist`,
      );
      assert.ok(
        !target.endsWith('.ts') || target.endsWith('.d.ts'),
        `${p.name}: exports names the TypeScript source "${target}"`,
      );
    }
  }
});

// Resolution falls back to main, then to index.js, when there is no map. Both reach past
// whatever the map would have said, so a package without one has no stated surface at all.
test('every package declares an exports map', () => {
  for (const p of packages) {
    assert.ok(
      p.json.exports !== undefined,
      `${p.name}: no exports map, so main and index.js decide what is importable`,
    );
  }
});

/** The files entries that carry a path, as the tarball roots they stand for. */
const shipped = (p: Pkg) =>
  (p.json.files ?? []).filter(literal).map((e) => e.replace(/^\.?\//, ''));

// files decides the tarball, exports decides what resolves inside it. Nothing reconciles
// them, so a package can name every target correctly and ship none of them.
test('every export target is inside a directory the files array ships', () => {
  for (const p of packages) {
    const roots = shipped(p);
    for (const target of targets(p.json.exports)) {
      const path = target.replace(/^\.\//, '');
      // npm always packs package.json, licenses and the readme, listed or not.
      if (/^(package\.json|LICENSE|README\.md)$/.test(path)) continue;
      assert.ok(
        roots.some((r) => path === r || path.startsWith(`${r}/`)),
        `${p.name}: exports names "${target}", which no files entry ships (files: ${roots.join(' ') || 'none'})`,
      );
    }
  }
});

// The directory is what deep-links the npm page at the right folder of the monorepo.
test('repository.directory names the directory the package sits in', () => {
  for (const p of packages) {
    assert.equal(
      p.json.repository?.directory,
      `packages/${p.slug}`,
      `${p.name}: repository.directory must be packages/${p.slug}`,
    );
  }
});

// Two TypeScript majors disagree about which `@types` they load by default, so a package on a
// version of its own passes its own gate and fails under the root's. Both halves are needed: the
// pins are what a reader sees, the absence of a second install is what the compiler acts on.
test('every package pins the compiler the root pins, and installs no other', () => {
  const root = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ) as Manifest;
  const pinned = packages.map(
    (p) => [p.name, p.json.devDependencies?.typescript] as const,
  );

  for (const [name, version] of pinned) {
    assert.ok(version, `${name}: names no typescript in devDependencies`);
  }
  // A sweep that read no package would satisfy every assertion around it, so the count is the
  // check: one pin per workspace member, none skipped.
  assert.equal(pinned.length, 18, `read ${pinned.length} package pins`);

  const versions = [...new Set(pinned.map(([, version]) => version))];
  assert.deepEqual(
    versions,
    [root.devDependencies?.typescript],
    `the tree pins ${versions.join(', ')} against the root's ${root.devDependencies?.typescript}`,
  );

  const forked = packages
    .filter((p) => existsSync(join(p.dir, 'node_modules', 'typescript')))
    .map((p) => p.name);
  assert.deepEqual(
    forked,
    [],
    `${forked.length} package(s) resolve a compiler of their own`,
  );
});

// false is a claim a bundler acts on. A bin runs its module body on load, so the package
// that ships one lists the files that do rather than claiming none.
test('sideEffects is declared, and a package with a bin never claims false', () => {
  for (const p of packages) {
    const declared = p.json.sideEffects;
    assert.ok(
      declared === false || Array.isArray(declared),
      `${p.name}: sideEffects must be false, or list the modules that have them`,
    );
    if (!p.json.bin) continue;
    assert.notEqual(
      declared,
      false,
      `${p.name}: the bin runs on load, so sideEffects cannot be false`,
    );
  }
});
