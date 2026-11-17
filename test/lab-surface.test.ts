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
 * The surface gate: the lab's public roster is exactly what the fixture records, per subpath and
 * in both directions.
 *
 * The export map moved once between two releases — three subpaths added, five removed — and
 * nothing in the tree noticed. What a package exports is its contract, so it is asserted the way
 * a contract is: an exact roster, cross-checked against named exemptions, never a floor.
 *
 * WHAT IT CANNOT SEE, AND WHY THE TOTALS ARE NOT A SAFETY SIGNAL. The fixture is a subpath →
 * symbol → kind map read off THIS tree. Three real breaks have passed it, and it read the same
 * two totals on both sides of each: a removed interface member, a subpath the registry carries
 * and this tree does not, and a subpath key renamed with its symbols intact. So "the surface
 * held" is not evidence a change was additive, and it is not evidence it was breaking either —
 * this gate has nothing to say about any of the three. `BLIND_SPOTS` below names them, and each
 * one is demonstrated against the live roster rather than asserted, so a reader learns the scope
 * here instead of by being wrong first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NON_MODULE_EXPORT,
  exportKeys,
  moduleSubpaths,
  readSurface,
  sourceClosure,
} from '#test/support/lab-surface.ts';
import type { Roster } from '#test/support/lab-surface.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, 'test', 'fixtures', 'lab-surface.json');
const REGENERATE =
  'run `node test/fixtures/generate-lab-surface.ts > test/fixtures/lab-surface.json` only after deciding the change is one we mean to ship';

const pinned = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Roster;
const live = readSurface(ROOT);

/** What the registry answers today, for the one blind spot that needs the other side to show. */
const published = JSON.parse(
  readFileSync(
    join(ROOT, 'test', 'fixtures', 'lab-published-exports.json'),
    'utf8',
  ),
) as { version: string; exports: Record<string, unknown> };

/**
 * The subpaths whose `types` entry is emitted from outside `src/`.
 *
 * Named rather than inferred: everything else the lab publishes is library source, and a rig
 * promoted to contract by accident is the failure this names its way around.
 */
const OFF_SOURCE_SUBPATHS = new Map([
  [
    './testing',
    'the conformance suite lives in test/conformance and is published on purpose, so a host writing its own Store can prove it against the same cases the engines pass',
  ],
]);

/**
 * Every `src/` file no public subpath reaches, with the reason it is outside the closure.
 *
 * This is the mechanical half of "nothing is promoted out of a file that reaches no entry point":
 * a promotion out of one of these pulls it into the closure, and its exemption stops being real.
 */
const UNREACHED_SOURCES = new Map([
  [
    'src/adapters/edge-inbound.ts',
    'the @pwngh/economy-edge bridge, reached by its own test and nothing that ships',
  ],
  [
    'src/adapters/edge-reconcile.ts',
    'the @pwngh/economy-edge bridge, reached by its own test and nothing that ships',
  ],
  [
    'src/adapters/edge-tilia.ts',
    'the @pwngh/economy-edge bridge, reached by its own test and economy/lib/edge-host.ts',
  ],
  [
    'src/adapters/edge-webhooks.ts',
    'the @pwngh/economy-edge bridge, reached by its own test and economy/lib/edge-host.ts',
  ],
  [
    'src/adapters/http.ts',
    'the HTTP store transport: a test rig for proving the Store contract across a process boundary, not a backend anyone deploys',
  ],
  [
    'src/adapters/http-server.ts',
    'the answering half of the HTTP store transport, imported only by src/adapters/http.ts',
  ],
  [
    'src/adapters/tilia-payees.ts',
    'the durable Tilia payee directory, reached by its own test and economy/lib/edge-host.ts',
  ],
  [
    'src/webassembly.d.ts',
    'ambient declarations for the WebAssembly globals fold-column.ts uses; it declares and exports nothing',
  ],
  [
    'src/wintercg.d.ts',
    'ambient declarations for the runtime globals the core may use; it declares and exports nothing',
  ],
]);

/**
 * The breaks this fixture is structurally unable to report, each with the incident that found it.
 *
 * Written down because two readers have taken a held surface as evidence a change was additive,
 * and one of them was the coordinator. Every entry is demonstrated against the live roster below
 * rather than asserted, so an entry cannot outlive the shape that makes it true.
 */
const BLIND_SPOTS = new Map([
  [
    'a member added to or removed from a published interface',
    'the roster records a symbol name and whether it is usable in a value position; an interface member has nowhere in the file to be recorded, in either direction. ServerOptions.catalog was removed on 2026-07-30 and every assertion here held',
  ],
  [
    'a subpath the published lab carries and this tree does not',
    'the roster is read off this tree, so a dropped subpath leaves nothing behind to compare against and only regenerates smaller. 0.7.0 shipped five subpaths this tree no longer had and nothing noticed until an install was tried (Q155). The registry side is test/fixtures/lab-published-exports.json, read by test/publishing.test.ts',
  ],
  [
    'the two totals a report quotes, across a subpath key renamed with its symbols intact',
    'both are sums over the map and a rename moves neither, so 11 / 526 reads the same on both sides of a breaking change. The key list below does fail and forces a regenerate — what is blind is the pair of numbers, and ./ops becoming ./supervisor on 2026-07-30 is the case (Q26)',
  ],
]);

const rosters = Object.entries(live);
const symbolCount = (roster: Roster) =>
  Object.values(roster).reduce(
    (sum, named) => sum + Object.keys(named).length,
    0,
  );

test('the exports map is the module subpaths plus one named non-module', () => {
  const keys = exportKeys(ROOT);
  const subpaths = moduleSubpaths(ROOT).map((entry) => entry.subpath);
  assert.equal(subpaths.length, 11, `read ${subpaths.length} module subpaths`);
  assert.equal(keys.length, subpaths.length + 1);

  const exempt = keys.filter((key) => !subpaths.includes(key));
  assert.deepEqual(exempt, [NON_MODULE_EXPORT]);
  assert.equal(
    typeof JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).exports[
      NON_MODULE_EXPORT
    ],
    'string',
    `${NON_MODULE_EXPORT} is exempt from the roster because it resolves to a file, not a module`,
  );
});

test('every subpath carries exactly the roster the fixture pins', () => {
  assert.deepEqual(Object.keys(live), Object.keys(pinned), REGENERATE);
  for (const [subpath, named] of rosters) {
    assert.deepEqual(named, pinned[subpath], `${subpath}: ${REGENERATE}`);
  }
  // deepEqual over two empty rosters passes, so the count is what proves the probe read anything.
  assert.equal(symbolCount(live), 533, `resolved ${symbolCount(live)} symbols`);
  assert.equal(symbolCount(live), symbolCount(pinned));
});

// The two totals differ by the symbols carried on more than one route, so stating all three
// catches a symbol that quietly gains a second door as well as one that gains a first.
test('the roster totals reconcile through the symbols on more than one route', () => {
  const routes = new Map<string, string[]>();
  for (const [subpath, named] of rosters) {
    for (const name of Object.keys(named)) {
      routes.set(name, [...(routes.get(name) ?? []), subpath]);
    }
  }
  const shared = [...routes.values()].filter((on) => on.length > 1);
  const extra = shared.reduce((sum, on) => sum + on.length - 1, 0);

  assert.equal(routes.size, 483, `${routes.size} distinct symbols`);
  assert.equal(
    shared.length,
    47,
    `${shared.length} symbols on more than one route`,
  );
  assert.equal(extra, 50);
  assert.equal(symbolCount(live), routes.size + extra);
});

// A symbol reachable in a type position only, or the other way round, is a break no name list
// would show: the import compiles and the call site does not.
test('no symbol is a value on one route and a type on another', () => {
  const kinds = new Map<string, string>();
  for (const [subpath, named] of rosters) {
    for (const [name, kind] of Object.entries(named)) {
      const first = kinds.get(name);
      assert.ok(
        first === undefined || first === kind,
        `${name} is a ${first} elsewhere and a ${kind} on ${subpath}`,
      );
      kinds.set(name, kind);
    }
  }
  assert.equal(kinds.size, 483);
});

// exports points at dist and never at src — a src-pointing map sends a consumer into the shipped
// TypeScript and breaks a file: install under plain Node.
test('every subpath declares a built pair and names the source behind it', () => {
  let examined = 0;
  for (const entry of moduleSubpaths(ROOT)) {
    examined += 1;
    assert.match(
      entry.types,
      /^\.\/dist\/.+\.d\.ts$/,
      `${entry.subpath}: types is "${entry.types}"`,
    );
    assert.equal(
      entry.runtime,
      entry.types.replace(/\.d\.ts$/, '.js'),
      `${entry.subpath}: default is not the sibling of its types`,
    );
    assert.ok(
      existsSync(join(ROOT, entry.source)),
      `${entry.subpath}: types is emitted from ${entry.source}, which is not there`,
    );

    const reason = OFF_SOURCE_SUBPATHS.get(entry.subpath);
    assert.ok(
      entry.source.startsWith('src/') || reason !== undefined,
      `${entry.subpath} publishes ${entry.source} from outside src/ with no stated reason`,
    );
    assert.ok(
      !(entry.source.startsWith('src/') && reason !== undefined),
      `${entry.subpath} is exempted as publishing from outside src/ and publishes ${entry.source}`,
    );
  }
  assert.equal(examined, 11, `read ${examined} subpaths`);
  assert.equal(OFF_SOURCE_SUBPATHS.size, 1);
});

test('every src file is inside the public closure or a named exemption', () => {
  const { all, reached, unreached } = sourceClosure(ROOT);
  for (const file of unreached) {
    const reason = UNREACHED_SOURCES.get(file);
    assert.ok(reason, `${file} reaches no subpath and has no named exemption`);
    assert.ok(
      reason!.length > 20,
      `${file} is exempted with no reason worth reading`,
    );
  }
  // An exemption outliving the file it was written for stops being a reason and becomes a hole,
  // and one written for a file that is now public would hide the promotion it exists to catch.
  for (const file of UNREACHED_SOURCES.keys()) {
    assert.ok(
      existsSync(join(ROOT, file)),
      `${file} is exempted and is not there`,
    );
    assert.ok(
      unreached.includes(file),
      `${file} is exempted as unreached and a subpath now reaches it`,
    );
  }
  assert.equal(all.length, 106, `walked ${all.length} src files`);
  assert.equal(reached.length, 97);
  assert.equal(unreached.length, UNREACHED_SOURCES.size);
  assert.equal(reached.length + unreached.length, all.length);
});

// Every assertion below resolves an ABSENCE on purpose, and none of them is evidence the surface
// is right. They exist so the scope of this file is read off the file: a blind spot left in prose
// goes stale, and this one has already cost two wrong readings.
test('the three breaks this fixture cannot report are still the three it cannot report', () => {
  assert.equal(BLIND_SPOTS.size, 3);
  for (const [spot, why] of BLIND_SPOTS) {
    assert.ok(
      why.length > 60,
      `${spot} is stated with no reason worth reading`,
    );
  }

  // 1. A symbol resolves to one of two kind words and nothing else, so there is no place in the
  //    file for a member to be recorded, gained or lost.
  const recorded = rosters.flatMap(([, named]) => Object.values(named));
  assert.deepEqual([...new Set(recorded)].sort(), ['type', 'value']);
  assert.equal(
    recorded.length,
    533,
    `read ${recorded.length} recorded symbols`,
  );

  // 2. The roster is this tree's. The subpaths the registry answers and this tree does not are
  //    absent from it entirely, so their removal is not something it can report on.
  const localKeys = exportKeys(ROOT);
  const publishedOnly = Object.keys(published.exports).filter(
    (key) => !localKeys.includes(key),
  );
  for (const key of publishedOnly) {
    assert.ok(
      !Object.hasOwn(pinned, key),
      `${key} is on published ${published.version} and in this fixture, so the fixture does span the registry`,
    );
  }
  assert.equal(
    publishedOnly.length,
    7,
    `${publishedOnly.length} subpaths are on published ${published.version} and gone from this tree`,
  );
  assert.equal(
    localKeys.filter((key) => !Object.hasOwn(published.exports, key)).length,
    4,
    'subpaths this tree carries that no published lab answers',
  );

  // 3. Renaming a key moves neither total. Shown on a throwaway copy, because the two numbers are
  //    what gets quoted out of this file and both survive a breaking rename unchanged.
  const [first] = Object.keys(live);
  const renamed = Object.fromEntries(
    Object.entries(live).map(([key, named]) =>
      key === first ? ['./renamed', named] : [key, named],
    ),
  ) as Roster;
  assert.notDeepEqual(
    Object.keys(renamed),
    Object.keys(live),
    'the copy is not renamed, so it demonstrates nothing',
  );
  assert.equal(Object.keys(renamed).length, Object.keys(live).length);
  assert.equal(symbolCount(renamed), symbolCount(live));
});
