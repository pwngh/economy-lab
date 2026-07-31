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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  crossPackageFindings,
  dependencyOrder,
  planDrift,
  publishPlan,
  readRootPackage,
  readWorkspace,
  runtimeDependencies,
  satisfies,
} from '#scripts/support/workspace-graph.ts';
import {
  LAB_NAME,
  exportKeys,
  labSpecifiers,
} from '#test/support/lab-surface.ts';
import type {
  Member,
  RegistryState,
} from '#scripts/support/workspace-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UMBRELLA = '@pwngh/economy';

// execFileSync waits forever by default, and it blocks the event loop while it does. These runs
// plan a publish and print it; the one that reaches the registry is the publish itself, which no
// test invokes.
const PLAN_BOUND_MS = 120_000;

const workspace = readWorkspace(ROOT);
const root = readRootPackage(ROOT);
const order = dependencyOrder(workspace);
const external = new Map([[root.name, root.version]]);

/** A throwaway copy of the real workspace, for building a failure that never touches the tree. */
function clone(): Map<string, Member> {
  return new Map(
    [...workspace].map(([name, member]) => [
      name,
      { ...member, json: structuredClone(member.json) as Member['json'] },
    ]),
  );
}

// Every assertion below reads the live tree, so an empty or half-read sweep would pass them all.
test('the sweep finds the whole workspace', () => {
  assert.ok(
    workspace.size >= 17,
    `found ${workspace.size} packages: ${[...workspace.keys()].join(', ')}`,
  );
  assert.equal(order.length, workspace.size);
  assert.equal(
    new Set(order).size,
    order.length,
    'the order repeats a package',
  );
});

test('the computed order is topological for the tree as it stands', () => {
  const placed = new Map(order.map((name, index) => [name, index]));
  for (const [index, name] of order.entries()) {
    for (const dep of Object.keys(runtimeDependencies(workspace.get(name)!))) {
      if (!workspace.has(dep)) continue;
      assert.ok(
        placed.get(dep)! < index,
        `${name} is published at ${index + 1}, before its dependency ${dep} at ${placed.get(dep)! + 1}`,
      );
    }
  }
});

// The umbrella is the install everyone types, and it names all fifteen siblings at a caret range.
// Publish it first and `npm i @pwngh/economy` is broken until the last sibling lands.
const NOT_A_SIBLING = new Map([
  ['create-economy', 'the scaffolder is not a door; nothing imports it'],
  [UMBRELLA, 'the umbrella cannot depend on itself'],
]);

test('the umbrella is published after every package it depends on', () => {
  const umbrella = workspace.get(UMBRELLA);
  assert.ok(umbrella, `${UMBRELLA} is not in the workspace`);
  const deps = Object.keys(runtimeDependencies(umbrella!)).filter((d) =>
    workspace.has(d),
  );
  // Exact, and reconciled against the workspace: a sibling that drops off the umbrella has to be
  // named below rather than quietly shrinking the set this test walks.
  assert.equal(deps.length, 15, `${UMBRELLA} names ${deps.length} siblings`);
  assert.equal(
    deps.length + NOT_A_SIBLING.size,
    workspace.size,
    `${workspace.size} workspace packages, ${deps.length} depended on, ${NOT_A_SIBLING.size} exempted`,
  );
  for (const [name, why] of NOT_A_SIBLING) {
    assert.ok(
      workspace.has(name),
      `${name} is exempted but is not in the workspace (${why})`,
    );
    assert.ok(
      !deps.includes(name),
      `${name} is now an umbrella dependency; delete its exemption (${why})`,
    );
  }
  for (const dep of deps) {
    assert.ok(
      order.indexOf(dep) < order.indexOf(UMBRELLA),
      `${dep} is published after the umbrella that depends on it`,
    );
  }
});

test('a cycle in runtime dependencies is refused, not sorted', () => {
  const broken = clone();
  const [a, b] = [...broken.keys()];
  (
    broken.get(a)!.json as { dependencies: Record<string, string> }
  ).dependencies = { [b!]: '*' };
  (
    broken.get(b)!.json as { dependencies: Record<string, string> }
  ).dependencies = { [a!]: '*' };
  assert.throws(() => dependencyOrder(broken), /dependency cycle:/);
  assert.equal(
    dependencyOrder(clone()).length,
    order.length,
    'the real tree still sorts',
  );
});

test('the tree as it stands has no inconsistent cross-package range', () => {
  assert.deepEqual(crossPackageFindings(workspace, external), []);
});

test('preflight refuses a sibling range naming a version nobody is publishing', () => {
  const broken = clone();
  const victim = broken.get(UMBRELLA)!;
  const dep = Object.keys(victim.json.dependencies ?? {}).find((d) =>
    broken.has(d),
  )!;
  const real = broken.get(dep)!.version;
  (victim.json as { dependencies: Record<string, string> }).dependencies[dep] =
    '^99.0.0';
  const findings = crossPackageFindings(broken, external);
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0]!, /wants "\^99\.0\.0"/);
  assert.ok(findings[0]!.includes(`${dep} is at ${real}`), findings[0]);
  assert.deepEqual(
    crossPackageFindings(workspace, external),
    [],
    'the real tree is clean again',
  );
});

// A file: range resolves through the workspace symlink and nowhere else, so a tarball carrying
// one installs broken. It has to be caught here, not by the first consumer.
test('preflight refuses a workspace-local protocol in a shipped dependency', () => {
  const broken = clone();
  const victim = broken.get(UMBRELLA)!;
  const dep = Object.keys(victim.json.dependencies ?? {})[0]!;
  (victim.json as { dependencies: Record<string, string> }).dependencies[dep] =
    'file:../core';
  assert.match(
    crossPackageFindings(broken, external).join('\n'),
    /resolves in the workspace and nowhere else/,
  );
});

// The root is a dependency of most of the packages and is not published by this tool, so a root
// bump that leaves the ranges behind is a broken release nothing else would catch.
test('preflight refuses a range that the repository root no longer satisfies', () => {
  const dependants = [...workspace.values()].filter((m) =>
    Object.hasOwn(runtimeDependencies(m), root.name),
  );
  assert.ok(dependants.length > 0, 'no package depends on the root');
  const moved = new Map([[root.name, '99.0.0']]);
  assert.equal(
    crossPackageFindings(workspace, moved).length,
    dependants.length,
  );
  assert.deepEqual(crossPackageFindings(workspace, external), []);
});

test('a version already on the registry is skipped, never published again', () => {
  const absent: Map<string, RegistryState> = new Map(
    order.map((name) => [name, 'absent']),
  );
  assert.deepEqual(
    publishPlan(order, workspace, absent).map((s) => s.action),
    order.map(() => 'publish'),
  );

  const [first] = order;
  const partly = new Map(absent).set(first!, 'published');
  const plan = publishPlan(order, workspace, partly);
  assert.equal(plan[0]!.action, 'skip');
  assert.match(plan[0]!.reason, /already on the registry/);
  assert.deepEqual(
    plan.slice(1).map((s) => s.action),
    order.slice(1).map(() => 'publish'),
  );
});

// Not-yet-answered is not the same as not-there. Guessing here republishes or skips at random.
test('a registry that would not answer blocks the plan instead of guessing', () => {
  const state: Map<string, RegistryState> = new Map(
    order.map((name) => [name, 'absent']),
  );
  state.set(order[0]!, 'unknown');
  assert.equal(publishPlan(order, workspace, state)[0]!.action, 'blocked');
  assert.equal(
    publishPlan(order, workspace, new Map())[0]!.action,
    'blocked',
    'a missing answer is not a green light',
  );
});

// Observed while this was being written: a package appeared under packages/ and was gone again
// minutes later. A real run takes minutes, so the plan is checked against disk before it runs.
test('a workspace that moves after the plan is made stops the run', () => {
  const state: Map<string, RegistryState> = new Map(
    order.map((name) => [name, 'absent']),
  );
  const plan = publishPlan(order, workspace, state);
  assert.deepEqual(planDrift(plan, workspace), []);

  const moved = clone();
  const victim = moved.get(order[0]!)!;
  moved.set(order[0]!, { ...victim, version: '9.9.9' });
  assert.match(planDrift(plan, moved).join('\n'), /moved from .* to 9\.9\.9/);

  const gone = clone();
  gone.delete(order[0]!);
  assert.match(planDrift(plan, gone).join('\n'), /left the workspace/);

  const joined = clone();
  joined.set('@pwngh/economy-newcomer', {
    ...victim,
    name: '@pwngh/economy-newcomer',
  });
  assert.match(planDrift(plan, joined).join('\n'), /joined the workspace/);
});

test('caret and tilde ranges are read the way npm reads them', () => {
  assert.equal(satisfies('0.1.0', '^0.1.0'), true);
  assert.equal(satisfies('0.1.9', '^0.1.0'), true);
  assert.equal(satisfies('0.2.0', '^0.1.0'), false);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('1.9.0', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('0.7.0', '0.7.0'), true);
  assert.equal(satisfies('0.7.1', '0.7.0'), false);
  assert.equal(satisfies('0.7.0', '*'), true);
  // A form this gate does not read is null, which every caller treats as a refusal.
  assert.equal(satisfies('0.7.0', '>=0.6 <0.8'), null);
  assert.equal(satisfies('0.7.0', 'file:../..'), null);
  assert.equal(satisfies('0.7.0-rc.1', '^0.7.0'), null);
});

// --- The install gate -------------------------------------------------------------
//
// A package resolves `@pwngh/economy-lab/<sub>` through the workspace symlink here and through
// the registry tarball at a consumer's `npm i`. Those are two different exports maps, and they
// have already come apart once: 0.7.0 shipped five subpaths this tree no longer has and lacks
// three it now imports. Nothing noticed until an install was tried.
//
// THE SWEEP READS THE WHOLE PACKAGE AND SORTS IT IN TWO, because the two halves are held to
// different rules. `shipped` is every file under a directory the package's own `files` array
// puts in the tarball — `src`, and also `demos`, `example` and `templates`, which do ship — and
// those are the ones the registry has to answer for. The rest are rigs: a test or a script
// resolves through the workspace symlink, never reaches a consumer, and so is held only to
// resolving against THIS tree's exports map. Sorting them is the point; pooling them would either
// block a release over a test import or let a shipped demo through unchecked.

const allSpecifiers = labSpecifiers(ROOT);
const specifiers = allSpecifiers.filter((s) => s.shipped);
const rigSpecifiers = allSpecifiers.filter((s) => !s.shipped);
const localExports = exportKeys(ROOT);
const published = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./fixtures/lab-published-exports.json', import.meta.url),
    ),
    'utf8',
  ),
) as { version: string; capturedOn: string; exports: Record<string, unknown> };

/**
 * The subpaths a released lab does not carry yet, and the packages that import them.
 *
 * This list is the release blocker, made mechanical. It is stated rather than tolerated: the
 * assertion is that the unresolvable set is EXACTLY this, so a sixth package joining it fails
 * here rather than at somebody's install. It empties when the lab publishes a version carrying
 * these subpaths and the fixture beside it is recaptured.
 */
const AWAITING_A_LAB_RELEASE = new Map([
  ['./client', ['@pwngh/economy-client', '@pwngh/economy-ui']],
  ['./contract', ['@pwngh/economy-core']],
  ['./sql-kit', ['@pwngh/economy-mysql', '@pwngh/economy-postgres']],
  // `./ops` renamed. 0.7.0 answers the old path and nothing answers this one until the lab
  // publishes again, so it blocks the same way a new subpath does.
  ['./supervisor', ['@pwngh/economy-core']],
]);

test('every lab specifier the packages ship resolves against the lab exports map', () => {
  const missing = specifiers.filter((s) => !localExports.includes(s.subpath));
  assert.deepEqual(
    missing.map((s) => `${s.file} imports ${s.specifier}`),
    [],
  );
  // A sweep whose regex quietly stopped matching would report the same empty list, so the count
  // of what was read is the assertion that matters.
  assert.equal(specifiers.length, 127, `read ${specifiers.length} specifiers`);
  assert.equal(
    new Set(specifiers.map((s) => s.package)).size,
    13,
    'the sweep did not reach every package that imports the lab',
  );
});

// The half that is not in the tarball. It cannot break an install, so it is not held to the
// published lab — but it does have to resolve here, and a subpath rename is exactly what makes it
// stop: `./ops` became `./supervisor` on 2026-07-30, and until this ran, a rig left on the old
// spelling would have surfaced as ERR_PACKAGE_PATH_NOT_EXPORTED in a fan-out run rather than as a
// named file in the root suite.
test('every lab specifier in a package rig resolves against this tree', () => {
  const missing = rigSpecifiers.filter(
    (s) => !localExports.includes(s.subpath),
  );
  assert.deepEqual(
    missing.map((s) => `${s.file} imports ${s.specifier}`),
    [],
  );
  assert.equal(
    rigSpecifiers.length,
    53,
    `read ${rigSpecifiers.length} rig specifiers`,
  );
  assert.equal(
    new Set(rigSpecifiers.map((s) => s.package)).size,
    12,
    'the sweep did not reach every package whose rigs import the lab',
  );
  // A rig may name a subpath no published lab answers — `packages/postgres/test` imports
  // ./sql-kit — and that is not a release blocker. Stated as a count so the day it becomes zero
  // is a decision rather than a drift.
  const awaiting = rigSpecifiers.filter((s) =>
    AWAITING_A_LAB_RELEASE.has(s.subpath),
  );
  assert.equal(awaiting.length, 1, awaiting.map((s) => s.file).join(' '));
});

// The two halves have to add up to the whole package, or a tree is in neither and this file is
// back to certifying less than it says. Derived from `files`, so a directory added to the tarball
// joins the shipped half on its own.
test('every lab import in the packages is sorted into exactly one of the two halves', () => {
  assert.equal(specifiers.length + rigSpecifiers.length, allSpecifiers.length);
  assert.ok(specifiers.length > 0 && rigSpecifiers.length > 0);
  assert.equal(allSpecifiers.length, 180);

  const shippedRoots = new Set(
    specifiers.map((s) => s.file.split('/').slice(0, 3).join('/')),
  );
  const rigRoots = new Set(
    rigSpecifiers.map((s) => s.file.split('/').slice(0, 3).join('/')),
  );
  for (const tree of shippedRoots) {
    const [, slug, dir] = tree.split('/');
    const files = (
      JSON.parse(
        readFileSync(join(ROOT, 'packages', slug!, 'package.json'), 'utf8'),
      ) as { files?: readonly string[] }
    ).files;
    assert.ok(
      files?.includes(dir!),
      `${tree} is swept as shipped and ${slug} does not list "${dir}" in files`,
    );
  }
  for (const tree of rigRoots) {
    const [, slug, dir] = tree.split('/');
    const files = (
      JSON.parse(
        readFileSync(join(ROOT, 'packages', slug!, 'package.json'), 'utf8'),
      ) as { files?: readonly string[] }
    ).files;
    assert.ok(
      !files?.includes(dir!),
      `${tree} is swept as a rig and ${slug} ships "${dir}"`,
    );
  }
  assert.equal(shippedRoots.size, 13, [...shippedRoots].sort().join(' '));
  assert.equal(rigRoots.size, 13, [...rigRoots].sort().join(' '));
});

// A lab import resolving from devDependencies works in the workspace and is absent from the
// tarball, so the package installs and fails on its first import.
test('every package importing the lab depends on it at runtime', () => {
  let examined = 0;
  for (const name of new Set(specifiers.map((s) => s.package))) {
    examined += 1;
    const member = workspace.get(name);
    assert.ok(member, `${name} imports the lab and is not in the workspace`);
    const range = runtimeDependencies(member!)[LAB_NAME];
    assert.ok(range, `${name} imports the lab and does not depend on it`);
    assert.equal(
      satisfies(root.version, range),
      true,
      `${name} wants ${LAB_NAME}@${range} and the lab is at ${root.version}`,
    );
  }
  assert.equal(examined, 13, `read ${examined} lab-importing packages`);
});

test('the specifiers no published lab satisfies are exactly the ones the release is for', () => {
  const unresolvable = new Map<string, Set<string>>();
  for (const s of specifiers) {
    if (
      !satisfies(
        published.version,
        runtimeDependencies(workspace.get(s.package)!)[LAB_NAME]!,
      )
    ) {
      // No published version answers this range at all, which the test above already refuses.
      continue;
    }
    if (Object.hasOwn(published.exports, s.subpath)) continue;
    unresolvable.set(
      s.subpath,
      (unresolvable.get(s.subpath) ?? new Set()).add(s.package),
    );
  }
  assert.deepEqual(
    [...unresolvable].map(([sub, pkgs]) => [sub, [...pkgs].sort()]).sort(),
    [...AWAITING_A_LAB_RELEASE].sort(),
    `against published ${published.version}, captured ${published.capturedOn}`,
  );
  // Each blocked subpath must be one this tree actually carries, or the list is naming a
  // specifier that is simply wrong rather than one waiting on a release.
  for (const subpath of AWAITING_A_LAB_RELEASE.keys()) {
    assert.ok(
      localExports.includes(subpath),
      `${subpath} is listed as awaiting a release and the lab does not export it either`,
    );
  }
  assert.equal(AWAITING_A_LAB_RELEASE.size, 4);
});

const cli = (args: readonly string[]) => {
  try {
    return {
      status: 0,
      out: execFileSync(
        process.execPath,
        ['scripts/publish-packages.mjs', ...args],
        {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: PLAN_BOUND_MS,
        },
      ),
    };
  } catch (error) {
    const failed = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failed.status ?? 1,
      out: `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
    };
  }
};

// The safety interlock, checked on the real command line: publishing takes a flag nobody types
// by accident, and it cannot be combined with the flag that means the opposite.
test('the command line defaults to a dry run and refuses a contradiction', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.out, /A dry run by default/);
  assert.match(help.out, /--publish-for-real/);

  const contradiction = cli(['--dry-run', '--publish-for-real']);
  assert.equal(contradiction.status, 1);
  assert.match(contradiction.out, /contradict each other/);

  const nonsense = cli(['--publish-everything']);
  assert.equal(nonsense.status, 1);
  assert.match(nonsense.out, /unknown option/);
});
