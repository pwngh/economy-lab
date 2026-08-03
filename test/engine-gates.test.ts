/// <reference types="node" />
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
 * Holds the shape of every suite that needs a SQL rig: it registers, and the rig's absence is a
 * named skip. A suite registered inside a conditional disappears instead — an unconfigured run then
 * reports a shorter suite list with nothing saying a suite was meant to happen, which is
 * indistinguishable from a full pass. Two rosters, read from source: the files whose registrations
 * depend on a rig, and every `runStoreConformance` call site.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isStringLiteralLike,
  ScriptTarget,
  SyntaxKind,
} from 'typescript';

import type { CallExpression, Node } from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every test file whose registrations can depend on a rig: it names a store URL variable, one of
 * the two URL helpers, or the engine-gate registrar. Exact, so a new rig-reading suite has to join
 * this roster — which is the moment to decide how it behaves with no rig.
 */
const RIG_READER =
  /testMysqlUrl|testPostgresUrl|storeUrls|MYSQL_TEST_URL|PG_URL|DATABASE_URL|LOCAL_MYSQL_URL|LOCAL_POSTGRES_URL|engine-gate|describeEngine/;

/**
 * Files that name a store URL and read none. The pattern above is a substring match, so a file
 * that *asserts a workflow supplies* `DATABASE_URL` looks exactly like one that reads it — and
 * putting such a file on the roster would say its registrations depend on a rig, which is the one
 * thing the roster is for. Each exemption is re-earned on both sides below.
 */
const NAMES_A_URL_READS_NONE: Readonly<Record<string, string>> = {
  'test/check-gate.test.ts':
    "holds ci.yml's live job to the service containers its two steps need; the env names are literals it looks for in a workflow file, not values it reads",
};

const ENGINE_GATED_FILES: readonly string[] = [
  'packages/cli/test/honesty.test.ts',
  'packages/cli/test/hostile.test.ts',
  'packages/cli/test/live.test.ts',
  'packages/cli/test/render.test.ts',
  'packages/core/test/postures.test.ts',
  'packages/mysql/test/mysql.test.ts',
  'packages/mysql/test/revive-race.test.ts',
  'packages/postgres/test/postgres.test.ts',
  'test/acceptance/rigs.test.ts',
  'test/adapters/edge-host.test.ts',
  'test/adapters/mysql-money-install-race.test.ts',
  'test/adapters/mysql.test.ts',
  'test/adapters/postgres-transient-classes.test.ts',
  'test/adapters/postgres.test.ts',
  'test/adapters/statement-order.test.ts',
  'test/adapters/tilia-payees.test.ts',
  'test/adapters/wire-trial.test.ts',
  'test/bench-harness.test.ts',
  'test/conformance-contract.test.ts',
  'test/conformance/money-db.test.ts',
  'test/conformance/velocity.rollback.test.ts',
  'test/create-economy.test.ts',
  // This file, which names every variable it looks for. It is walked like the rest rather than
  // excused: a roster gate that exempts itself is how a sweep comes to read its own allowance.
  'test/engine-gates.test.ts',
  'test/engine-open.test.ts',
  'test/engines/leg-wire.test.ts',
  // Not a rig consumer: it pins store URL variable NAMES as roster data, which is exactly the
  // naming the reader regex exists to notice. Its registrations are unconditional.
  'test/env-surface.test.ts',
  'test/lab-app.test.ts',
  'test/maturity.test.ts',
  'test/money-sql.test.ts',
  'test/public-api.test.ts',
  'test/taskq-host.test.ts',
  'test/taskq-integration.test.ts',
  'test/wiring.test.ts',
  'test/worker/payouts-attempts-cas.test.ts',
];

/**
 * The one conditional registration that stays, with its reason: WIRE_TRIAL names an unpromoted
 * driver installed by hand (`npm install --no-save postgres`). Absent, no rig is missing and no
 * suite was meant to happen, so a permanent skip would name a capability nobody asked for.
 */
const CONDITIONAL_EXEMPTIONS: readonly string[] = [
  "test/adapters/wire-trial.test.ts :: runStoreConformance('postgres (postgres.js wire)')",
];

/** Every store the conformance suite certifies, and where. Exact: a store that stops being
 * certified is a coverage loss, and a call site that moves under a conditional is this item. */
const CONFORMANCE_SITES: readonly string[] = [
  'packages/conformance/test/oracle.test.ts :: memory oracle',
  'packages/mysql/test/mysql.test.ts :: economy-mysql',
  'packages/postgres/test/postgres.test.ts :: economy-postgres',
  'packages/postgres/test/postgres.test.ts :: economy-postgres (caller pool, driver defaults)',
  'test/adapters/entitlement-bitset.test.ts :: memory+bitset',
  'test/adapters/http.test.ts :: http',
  'test/adapters/memory.test.ts :: memory',
  'test/adapters/mysql.test.ts :: mysql',
  'test/adapters/mysql.test.ts :: mysql (mariadb wire)',
  'test/adapters/postgres.test.ts :: postgres',
  'test/adapters/postgres.test.ts :: postgres (partitioned layout)',
  'test/adapters/wire-trial.test.ts :: postgres (postgres.js wire)',
];

// Bare calls only. `regexp.test(sql)` is a method call on an object, and counting it as a
// registration put a false positive inside every ternary that matches SQL text.
const REGISTRARS = new Set([
  'describe',
  'it',
  'test',
  'describeEngine',
  'pinEngineGateRoster',
  'runStoreConformance',
]);

// A registration reachable only when a branch is taken. `for` and `try` are not here: a loop over
// a fixed list registers every time, and a throw during registration fails the file loudly.
const BRANCHES = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.ConditionalExpression,
]);

interface Registration {
  readonly callee: string;
  readonly title: string;
  readonly branched: boolean;
}

/** Every registrar call in one file, each marked with whether a branch guards it. */
function registrationsIn(file: string, source: string): Registration[] {
  const found: Registration[] = [];
  const walk = (node: Node, branches: number): void => {
    if (isCallExpression(node) && isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (REGISTRARS.has(callee)) {
        const first = (node as CallExpression).arguments[0];
        found.push({
          callee,
          title:
            first !== undefined && isStringLiteralLike(first) ? first.text : '',
          branched: branches > 0,
        });
      }
    }
    const deeper = BRANCHES.has(node.kind) ? branches + 1 : branches;
    forEachChild(node, (child) => walk(child, deeper));
  };
  forEachChild(
    createSourceFile(file, source, ScriptTarget.Latest, true),
    (child) => walk(child, 0),
  );
  return found;
}

function testFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFilesUnder(path));
    else if (entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

/** Both test trees: this repository's, and every package's own. */
function allTestFiles(): string[] {
  const found = testFilesUnder(join(ROOT, 'test'));
  for (const entry of readdirSync(join(ROOT, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const dir = join(ROOT, 'packages', entry.name, 'test');
    try {
      found.push(...testFilesUnder(dir));
    } catch {
      // A package with no test directory. `tsconfig-coverage` is what holds that roster.
    }
  }
  return found.map((path) => relative(ROOT, path).split(sep).join('/')).sort();
}

// The positive control. Every assertion below reports an absence, and an extractor that reads
// nothing reports the same absence, so the extractor is shown finding the shape first.
const PLANTED = `import { describe, test } from 'node:test';
const url = process.env.MYSQL_TEST_URL ?? '';
describe('always here', () => {
  test('runs', () => {});
});
if (url) {
  describe('only with a rig', () => {
    test('vanishes without one', () => {});
  });
}
`;

describe('engine-gated suites: the extractor', () => {
  test('finds a registration a conditional guards, and the ones it does not', () => {
    const found = registrationsIn('planted.test.ts', PLANTED);
    assert.equal(found.length, 4);
    assert.deepEqual(
      found.map((one) => `${one.callee}:${one.title}:${one.branched}`),
      [
        'describe:always here:false',
        'test:runs:false',
        'describe:only with a rig:true',
        'test:vanishes without one:true',
      ],
    );
  });

  test('does not read a RegExp test call as a registration', () => {
    const found = registrationsIn(
      'planted.test.ts',
      'const isDrop = (sql: string) => (/^drop/.test(sql) ? 1 : 0);\n',
    );
    assert.deepEqual(found, []);
  });
});

describe('engine-gated suites: the rosters', () => {
  const files = allTestFiles();

  test('every test file whose registrations can depend on a rig is on the roster', () => {
    const readers = files.filter(
      (file) =>
        RIG_READER.test(readFileSync(join(ROOT, file), 'utf8')) &&
        !(file in NAMES_A_URL_READS_NONE),
    );
    assert.deepEqual(readers, [...ENGINE_GATED_FILES]);

    // Both halves of every exemption, re-earned here rather than trusted. The file must still
    // match — an exemption for a file that stopped naming a store URL is stale and goes — and it
    // must still not be a rig reader: no URL helper, and nothing registered inside a conditional,
    // which is the property this roster exists to force a decision about.
    for (const [file, why] of Object.entries(NAMES_A_URL_READS_NONE)) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      assert.ok(why.length > 20, `${file}: the exemption states no reason`);
      assert.ok(RIG_READER.test(source), `${file} no longer names a store URL`);
      assert.doesNotMatch(
        source,
        /testMysqlUrl|testPostgresUrl|storeUrls/,
        `${file} reaches a rig through a URL helper, so it belongs on the roster`,
      );
      const branched = registrationsIn(file, source).filter(
        (one) => one.branched,
      );
      assert.deepEqual(
        branched.map((one) => one.title),
        [],
        `${file} registers inside a conditional, so what it proves depends on the environment`,
      );
    }
    assert.equal(
      Object.keys(NAMES_A_URL_READS_NONE).length,
      1,
      'the exemption roster read a different size',
    );
  });

  test('no rig-reading suite registers inside a conditional, bar the named exemption', () => {
    let walked = 0;
    const branched: string[] = [];
    for (const file of ENGINE_GATED_FILES) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const one of registrationsIn(file, source)) {
        if (one.branched) {
          branched.push(`${file} :: ${one.callee}('${one.title}')`);
        }
      }
      walked += 1;
    }
    assert.equal(walked, ENGINE_GATED_FILES.length);
    assert.deepEqual(branched.sort(), [...CONDITIONAL_EXEMPTIONS]);
  });

  test('every store the conformance suite certifies is named, and only the trial is guarded', () => {
    const sites: string[] = [];
    const guarded: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      if (!source.includes('runStoreConformance(')) continue;
      for (const one of registrationsIn(file, source)) {
        if (one.callee !== 'runStoreConformance') continue;
        sites.push(`${file} :: ${one.title}`);
        if (one.branched) guarded.push(`${file} :: ${one.title}`);
      }
    }
    assert.deepEqual(sites.sort(), [...CONFORMANCE_SITES]);
    assert.deepEqual(guarded, [
      'test/adapters/wire-trial.test.ts :: postgres (postgres.js wire)',
    ]);
  });
});
