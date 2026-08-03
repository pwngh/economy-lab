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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = fileURLToPath(new URL('../packages', import.meta.url));
const MANIFEST = join(PACKAGES, 'economy', 'manifest.json');

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

const doors = (): [string, string][] =>
  Object.entries(readJson(MANIFEST) as Record<string, string>).filter(
    ([k]) => !k.startsWith('_'),
  );

const siblings = (): { name: string; exports: string[]; bin: boolean }[] =>
  readdirSync(PACKAGES, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && existsSync(join(PACKAGES, d.name, 'package.json')),
    )
    .map((d) => {
      const json = readJson(join(PACKAGES, d.name, 'package.json'));
      return {
        name: json.name as string,
        exports: Object.keys((json.exports ?? {}) as object),
        bin: json.bin !== undefined,
      };
    })
    .filter((p) => p.name !== '@pwngh/economy');

test('every door is spelled economy/… onto a @pwngh/… package', () => {
  for (const [key, specifier] of doors()) {
    assert.ok(
      key.startsWith('economy/'),
      `door "${key}" must start with economy/`,
    );
    assert.ok(
      specifier.startsWith('@pwngh/'),
      `door "${key}" points at "${specifier}"`,
    );
  }
});

test('every door resolves to a real export of a real package', () => {
  const byName = new Map(siblings().map((p) => [p.name, p]));
  for (const [key, specifier] of doors()) {
    const pkgName = specifier.split('/').slice(0, 2).join('/');
    const pkg = byName.get(pkgName);
    assert.ok(
      pkg,
      `door "${key}" names ${pkgName}, which is not a workspace package`,
    );
    const sub = specifier.slice(pkgName.length);
    assert.ok(
      pkg!.exports.includes(sub === '' ? '.' : `.${sub}`),
      `door "${key}" points at ${specifier}, which ${pkgName} does not export`,
    );
  }
});

// The scaffolder is run once with npx, before the project that would import anything exists.
// A door onto it would also point the umbrella at the tool that writes projects installing the
// umbrella. Named, not inferred: a package that merely forgot its exports must still fail.
const DOORLESS = ['create-economy'];

// A package built and then forgotten is the failure this exists to catch: it would ship, be
// installable, and be unreachable through the umbrella everyone actually installs.
test('every workspace package has at least one door, or is a named exemption', () => {
  const named = new Set(
    doors().map(([, s]) => s.split('/').slice(0, 2).join('/')),
  );
  for (const pkg of siblings()) {
    if (DOORLESS.includes(pkg.name)) continue;
    assert.ok(named.has(pkg.name), `${pkg.name} has no door in the manifest`);
  }
});

// The exemption is spent only on a package that has nothing to put behind a door, so it cannot
// quietly grow to cover one that does.
test('every doorless package is a bin with no importable export', () => {
  const byName = new Map(siblings().map((p) => [p.name, p]));
  for (const name of DOORLESS) {
    const pkg = byName.get(name);
    assert.ok(
      pkg,
      `${name} is exempted from the door rule but is not a workspace package`,
    );
    assert.deepEqual(
      pkg!.exports.filter((k) => k !== './package.json'),
      [],
      `${name} exports something importable, so it needs a door rather than the exemption`,
    );
    assert.ok(
      pkg!.bin,
      `${name} is exempted from the door rule but ships no bin`,
    );
  }
});

/**
 * Every package export a consumer is meant to reach, spelled the way the manifest spells its
 * targets. An export absent from here and from the manifest is unreachable through the umbrella.
 */
const DOORLESS_EXPORTS = new Map([
  [
    '@pwngh/economy-core/internal',
    "the sibling packages' seam, carrying no semver contract: cli and adapters import it, integrator code never does",
  ],
  [
    '@pwngh/economy-conformance/internal',
    'the pieces of the suites only their own tests read: the lab holds the suites to their own shape through it, and a caller running conformance never needs it',
  ],
  [
    '@pwngh/economy-postgres/driver',
    'the raw pg pool for tooling that keeps its own tables beside the ledger, reached past the front door on purpose',
  ],
]);

/** Node reads a package manifest through its own export. It is metadata, not a module. */
const MANIFEST_EXPORT = './package.json';

// The mirror of the door rule above: a package can also grow an export nobody gave a door, which
// ships and installs and is still unreachable from the one specifier a consumer types.
test('every package export has a door, or is a named exemption', () => {
  const behind = new Set(doors().map(([, specifier]) => specifier));
  let examined = 0;
  for (const pkg of siblings()) {
    for (const sub of pkg.exports) {
      if (sub === MANIFEST_EXPORT) continue;
      examined += 1;
      const specifier = pkg.name + (sub === '.' ? '' : sub.slice(1));
      const reason = DOORLESS_EXPORTS.get(specifier);
      assert.ok(
        behind.has(specifier) || reason !== undefined,
        `${specifier} has no door in the manifest and no named exemption`,
      );
      assert.ok(
        !(behind.has(specifier) && reason !== undefined),
        `${specifier} has a door and an exemption saying it should not: ${reason}`,
      );
    }
  }
  // A gate that read no package would satisfy every assertion above it, so the count is the
  // check: it is the doors and the exemptions exactly, with nothing over and nothing missing.
  assert.equal(examined, 27, `read ${examined} package exports`);
  assert.equal(examined, doors().length + DOORLESS_EXPORTS.size);
});

// An exemption outliving the export it was written for stops being a reason and becomes a hole.
test('every exempted export is a real export carrying a real reason', () => {
  const byName = new Map(siblings().map((p) => [p.name, p]));
  for (const [specifier, reason] of DOORLESS_EXPORTS) {
    const pkgName = specifier.split('/').slice(0, 2).join('/');
    const pkg = byName.get(pkgName);
    assert.ok(
      pkg,
      `${specifier} names ${pkgName}, which is not a workspace package`,
    );
    assert.ok(
      pkg!.exports.includes(`.${specifier.slice(pkgName.length)}`),
      `${specifier} is exempted from the door rule but ${pkgName} does not export it`,
    );
    assert.ok(
      reason.length > 20,
      `${specifier} is exempted with no reason worth reading`,
    );
  }
  assert.equal(DOORLESS_EXPORTS.size, 3);
});

test('no two doors point at the same export', () => {
  const seen = new Map<string, string>();
  for (const [key, specifier] of doors()) {
    const first = seen.get(specifier);
    assert.equal(
      first,
      undefined,
      `"${key}" and "${first}" both point at ${specifier} — one door per export`,
    );
    seen.set(specifier, key);
  }
});
