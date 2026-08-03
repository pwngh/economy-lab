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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import '#test/support/dist-guard.ts';

import {
  createProgram,
  isInterfaceDeclaration,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  SymbolFlags,
} from 'typescript';

import type { Symbol as TsSymbol, TypeChecker } from 'typescript';

import {
  STORE_CAPABILITIES,
  capabilitiesOf,
  capabilityConflicts,
} from '@pwngh/economy-lab/store-kit';
import { memoryStore } from '@pwngh/economy-lab/adapters';
import { postgresStore } from '@pwngh/economy-postgres';
import {
  CAPABILITY_TESTS,
  agreesWithTheMemoryOracle,
  reOffersEveryUnmarkedRow,
} from '@pwngh/economy-conformance/internal';
import {
  leavesEveryStateItReaches,
  waitsOutTheReportedRetry,
} from '@pwngh/economy-conformance/internal';
import { memoryRateLimiter } from '@pwngh/economy-lab/adapters';
import {
  freshName,
  makeIsolatedMysqlStore,
  testMysqlUrl,
  testPostgresUrl,
} from '#test/support/adapters.ts';
import { rigUnconfigured } from '#test/support/engine-gate.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { RateLimiterHarness } from '@pwngh/economy-conformance/internal';
import type { RatePolicy } from '@pwngh/economy-lab/adapters';
import type {
  RateLimiter,
  Store,
  StoreCapability,
  Unit,
} from '@pwngh/economy-lab/ports';

// The roster is exact, not a floor. A capability the suite forgets to name is a surface nothing
// branches on, which is precisely how a test body comes to return early and report success.
const ROSTER: readonly StoreCapability[] = [
  'appendAll',
  'archive',
  'batchTransaction',
  'historySize',
  'idempotencyRetention',
  'journalRetention',
  'journalSessionIds',
  'lockMany',
  'reproof',
  'reservations',
  'sealHeads',
  'tableSizes',
];

// What each capability reads, as a knockout: deleting these members must flip that capability and
// no other. Paths are dotted from the store, with `ledger.` resolved against the transaction unit.
const KNOCKOUTS: Record<StoreCapability, string[]> = {
  appendAll: ['ledger.appendAll'],
  archive: [
    'ledger.archivePage',
    'ledger.prune',
    'checkpoints.archiveState',
    'checkpoints.putArchiveBoundary',
    'checkpoints.archiveHeads',
  ],
  batchTransaction: ['batchTransaction'],
  historySize: ['ledger.historySize'],
  idempotencyRetention: ['idempotency.deleteOlderThan'],
  journalRetention: ['movements.pruneSession'],
  journalSessionIds: ['movements.sessionIds'],
  lockMany: ['ledger.lockMany'],
  reproof: ['checkpoints.reproof', 'checkpoints.putReproof'],
  reservations: ['reservations'],
  sealHeads: ['checkpoints.sealHeads', 'checkpoints.putSealHeads'],
  tableSizes: ['tableSizes'],
};

// memoryStore carries ten of the twelve. Teaching the copy the missing two gives every roster
// entry something to knock out.
function fullStore(): { store: Store; unit: Unit } {
  const base = memoryStore();
  const noop = async () => {};
  const ledger = {
    ...base.ledger,
    lockMany: noop,
    appendAll: async () => [],
  } as Store['ledger'];
  return { store: { ...base, ledger }, unit: { ledger } as Unit };
}

function without(
  source: { store: Store; unit: Unit },
  path: string,
): { store: Store; unit: Unit } {
  const [head, member] = path.split('.') as [string, string | undefined];
  if (member === undefined) {
    const store = { ...source.store } as Record<string, unknown>;
    delete store[head];
    return { store: store as unknown as Store, unit: source.unit };
  }
  if (head === 'ledger') {
    const ledger = { ...source.unit.ledger } as Record<string, unknown>;
    delete ledger[member];
    return {
      store: { ...source.store, ledger: ledger as unknown as Store['ledger'] },
      unit: { ledger: ledger as unknown as Store['ledger'] } as Unit,
    };
  }
  const port = {
    ...(source.store[head as keyof Store] as unknown as Record<
      string,
      unknown
    >),
  };
  delete port[member];
  return {
    store: { ...source.store, [head]: port } as Store,
    unit: source.unit,
  };
}

describe('Store capability roster', () => {
  test('names every optional surface the conformance suite branches on', () => {
    assert.equal(STORE_CAPABILITIES.length, 12);
    assert.deepEqual([...STORE_CAPABILITIES], [...ROSTER]);
  });

  test('every roster entry is live: knocking its members out flips it and nothing else', () => {
    const full = fullStore();
    const all = capabilitiesOf(full.store, full.unit);
    assert.deepEqual(
      STORE_CAPABILITIES.filter((capability) => !all[capability]),
      [],
    );

    let knockedOut = 0;
    for (const capability of STORE_CAPABILITIES) {
      for (const path of KNOCKOUTS[capability]) {
        const stripped = without(full, path);
        const resolved = capabilitiesOf(stripped.store, stripped.unit);
        assert.equal(
          resolved[capability],
          false,
          `${capability} survived removing ${path}, so it reads nothing`,
        );
        const collateral = STORE_CAPABILITIES.filter(
          (other) => other !== capability && !resolved[other],
        );
        // `archive` legitimately shares the ledger with nothing else, so any other capability
        // flipping means two roster entries are reading the same member.
        assert.deepEqual(
          collateral,
          [],
          `removing ${path} also flipped ${collateral.join(', ')}`,
        );
        knockedOut += 1;
      }
    }
    assert.equal(knockedOut, 18);
  });
});

// The titles come out of the suite's own source, never out of CAPABILITY_TESTS: a roster checked
// against itself is what let a renamed test sit behind a passing gate. Both counts below are pinned
// exactly, because an extractor that matches nothing leaves every mismatch list empty.
const SUITE_SOURCE = readFileSync(
  new URL('../packages/conformance/src/store.ts', import.meta.url),
  'utf8',
);

// An identifier character or a dot in front of `test(` makes it a different call: without that
// guard `latest(` matches.
const TITLE_PATTERNS = [
  /(?:^|[^\w$.])test\(\s*'((?:[^'\\]|\\.)*)'/gm,
  /(?:^|[^\w$.])test\(\s*"((?:[^"\\]|\\.)*)"/gm,
];

/** Every title the store conformance suite registers, read from its source. */
function registeredTitles(source: string): Set<string> {
  const titles = new Set<string>();
  for (const pattern of TITLE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      titles.add(match[1]!);
    }
  }
  return titles;
}

describe('Store capability test roster', () => {
  const titles = registeredTitles(SUITE_SOURCE);

  test('reads every title the conformance suite registers', () => {
    assert.equal(titles.size, 78);
  });

  test('names the capability roster and nothing else', () => {
    assert.deepEqual(
      Object.keys(CAPABILITY_TESTS).sort(),
      [...STORE_CAPABILITIES].sort(),
    );
  });

  test('every title it names resolves to a test that exists', () => {
    let resolved = 0;
    for (const capability of STORE_CAPABILITIES) {
      const named = CAPABILITY_TESTS[capability];
      assert.notEqual(named.length, 0, `${capability} names no test`);
      for (const title of named) {
        assert.ok(
          titles.has(title),
          `${capability} names a test no longer registered: ${title}`,
        );
        resolved += 1;
      }
    }
    assert.equal(resolved, 14);
  });
});

// The live grid, pinned cell by cell. The two divergences it exists to hold are lockMany (absent
// on memory, present on both engines) and appendAll (the same). Flipping any one cell fails.
const MATRIX: Record<string, Record<StoreCapability, boolean>> = {
  memory: {
    appendAll: false,
    archive: true,
    batchTransaction: true,
    historySize: true,
    idempotencyRetention: true,
    journalRetention: true,
    journalSessionIds: true,
    lockMany: false,
    reproof: true,
    reservations: true,
    sealHeads: true,
    tableSizes: true,
  },
  postgres: {
    appendAll: true,
    archive: true,
    batchTransaction: true,
    historySize: true,
    idempotencyRetention: true,
    journalRetention: true,
    journalSessionIds: true,
    lockMany: true,
    reproof: true,
    reservations: true,
    sealHeads: true,
    tableSizes: true,
  },
  mysql: {
    appendAll: true,
    archive: true,
    batchTransaction: true,
    historySize: true,
    idempotencyRetention: true,
    journalRetention: true,
    journalSessionIds: true,
    lockMany: true,
    reproof: true,
    reservations: true,
    sealHeads: true,
    tableSizes: true,
  },
};

async function resolveLive(
  make: () => Promise<Store> | Store,
): Promise<Record<StoreCapability, boolean>> {
  const store = await make();
  try {
    let resolved: Record<StoreCapability, boolean> | null = null;
    await store.transaction(async (unit) => {
      resolved = capabilitiesOf(store, unit);
    });
    return resolved!;
  } finally {
    await store.close();
  }
}

describe('Store capability matrix', () => {
  // Empty when nothing names MySQL, which makeIsolatedMysqlStore refuses — and the refusal is a
  // named skip below. The row was pushed conditionally until 2026-07-30, so an unconfigured run
  // resolved two engines and reported three passing tests where the third had not been written.
  const mysqlUrl = testMysqlUrl(process.env) ?? '';
  const engines: Array<[string, () => Promise<Store> | Store]> = [
    ['memory', () => memoryStore()],
    [
      'postgres',
      () =>
        postgresStore({
          url: testPostgresUrl(process.env),
          schemaName: freshName('el_caps'),
        }),
    ],
    // An isolated database, never the shared one. `applyMysqlSchema` drops and recreates its
    // tables, so running it against `economy_lab` deletes them out from under whichever suite is
    // mid-run in a parallel file — measured here as ER_NO_SUCH_TABLE across 32 tests.
    [
      'mysql',
      () =>
        mysqlUrl === ''
          ? Promise.reject(rigUnconfigured('mysql'))
          : makeIsolatedMysqlStore({
              url: mysqlUrl,
              digest: seededDigest(1),
              clock: fixedClock(0),
            }),
    ],
  ];

  let registered = 0;
  for (const [engine, make] of engines) {
    test(`${engine} resolves every capability exactly as pinned`, async (t) => {
      let resolved: Record<StoreCapability, boolean>;
      try {
        resolved = await resolveLive(make);
      } catch (error) {
        t.skip(
          `${engine} unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      let cells = 0;
      for (const capability of STORE_CAPABILITIES) {
        assert.equal(
          resolved[capability],
          MATRIX[engine]![capability],
          `${engine}.${capability}`,
        );
        cells += 1;
      }
      assert.equal(cells, 12);
    });
    registered += 1;
  }

  // The count of rows the matrix registered, not the count it could have. MySQL's row was pushed
  // conditionally until 2026-07-30, so an unconfigured run walked two engines and reported a clean
  // three-test suite where the third row had never been written.
  test('registers a row for every engine MATRIX names, configured or not', () => {
    assert.deepEqual(
      engines.map(([engine]) => engine),
      Object.keys(MATRIX),
    );
    assert.equal(registered, 3);
  });
});

// The anti-test. This is the exact shape of a real out-of-repo store: `lockMany` written onto the
// store's ledger, where the author can see it, and never reaching the transaction unit — which is
// the only level at which taking a lock means anything. Before the capability roster existed this
// store passed the published suite 57/57 with zero skips.
function liarStore(): Store {
  const base = memoryStore();
  return {
    ...base,
    ledger: { ...base.ledger, lockMany: async () => {} },
  } as Store;
}

describe('Store capability refusal', () => {
  test('a store whose lockMany never reaches the transaction unit resolves false', async () => {
    const store = liarStore();
    assert.notEqual(store.ledger.lockMany, undefined);
    let resolved: Record<StoreCapability, boolean> | null = null;
    await store.transaction(async (unit) => {
      resolved = capabilitiesOf(store, unit);
    });
    await store.close();
    assert.equal(resolved!.lockMany, false);
  });

  test('declaring lockMany over that store is refused, naming the capability', async () => {
    const store = liarStore();
    let resolved: Record<StoreCapability, boolean> | null = null;
    await store.transaction(async (unit) => {
      resolved = capabilitiesOf(store, unit);
    });
    await store.close();

    const conflicts = capabilityConflicts(resolved!, { lockMany: true });
    assert.equal(conflicts.length, 1);
    assert.match(
      conflicts[0]!,
      /^lockMany: declared true, but the store resolves false$/,
    );
  });

  test('an honest declaration over the same store is accepted', async () => {
    const store = liarStore();
    let resolved: Record<StoreCapability, boolean> | null = null;
    await store.transaction(async (unit) => {
      resolved = capabilitiesOf(store, unit);
    });
    await store.close();

    assert.deepEqual(
      capabilityConflicts(resolved!, { lockMany: false, appendAll: false }),
      [],
    );
  });

  test('every capability can be refused, not just the one that motivated this', async () => {
    const full = fullStore();
    const resolved = capabilitiesOf(full.store, full.unit);
    const denied = Object.fromEntries(
      STORE_CAPABILITIES.map((capability) => [capability, false]),
    ) as Record<StoreCapability, boolean>;
    assert.equal(capabilityConflicts(resolved, denied).length, 12);
  });
});

// The differential's anti-test, and it is the fault class `Q36` measured as structurally invisible:
// a store whose ordering key is not a commit-order column. The clock steps backwards, so every
// posting is dated below the one before it. Memory keeps insertion order, so the statement still
// comes back in commit order and every other case in the suite passes — `postedAt` no longer rises,
// and the differential is the only reader of that.
function steppedBackClockStore(): Store {
  let at = 9_000_000;
  return memoryStore({
    clock: {
      now: () => {
        at -= 1_000;
        return at;
      },
    },
  });
}

describe('Store differential refusal', () => {
  test('the oracle comparison refuses a store whose posting dates step backwards', async () => {
    const store = steppedBackClockStore();
    try {
      await assert.rejects(
        agreesWithTheMemoryOracle(store),
        /statement\.postedAtRises differs from the memory oracle over the same input/,
      );
    } finally {
      await store.close();
    }
  });

  test('every other case in the suite passes that same store', async () => {
    const store = steppedBackClockStore();
    let ran = 0;
    try {
      // The two cases that read the same postings against a written-out constant. Both pass, which
      // is what makes the refusal above evidence rather than a coincidence.
      await reOffersEveryUnmarkedRow(store);
      ran += 1;
      await agreesWithTheMemoryOracle(memoryStore());
      ran += 1;
    } finally {
      await store.close();
    }
    assert.equal(ran, 2);
  });
});

// The second anti-test, and the shape a durable claim would have: a lease, handing each row out
// once. Its rows do drain, so it satisfies every other queue case in the suite; what it strands is
// the rest of a batch whose caller died before marking it. The suite's own assertions about rows
// nobody returns are the shape that passes while examining nothing, so both sides are run here.
function leasedClaimStore(): Store {
  const base = memoryStore();
  const handedOut = new Set<string>();
  return {
    ...base,
    inbox: {
      ...base.inbox,
      claimInbound: async (input, options) => {
        const batch = await base.inbox.claimInbound(input, options);
        const fresh = batch.filter((entry) => !handedOut.has(entry.id));
        for (const entry of fresh) {
          handedOut.add(entry.id);
        }
        return fresh;
      },
    },
  } as Store;
}

describe('Store claim re-offer refusal', () => {
  test('the re-offer case refuses a claim that hands each row out once', async () => {
    const store = leasedClaimStore();
    try {
      await assert.rejects(
        reOffersEveryUnmarkedRow(store),
        /was claimed and left unmarked, and no later claim offered it again/,
      );
    } finally {
      await store.close();
    }
  });

  test('the same case passes the store the lease is written over', async () => {
    const store = memoryStore();
    try {
      await reOffersEveryUnmarkedRow(store);
    } finally {
      await store.close();
    }
  });
});

// The connect-or-skip contract, read off a real run of the emit `./testing` publishes. A suite
// reports its own skips, so nothing inside the runner can assert this — a child runner is the only
// reader — and the emit is the artifact a host installs. `AggregateError` is here because a refused
// `pg` connect is one, and its own `message` is empty: reading `message` alone produced a skip per
// test reading "backend unreachable: " and then nothing.
const CONFORMANCE_EMIT = new URL(
  '../packages/conformance/dist/store.js',
  import.meta.url,
).href;

const AGGREGATE_REASON =
  'connect ECONNREFUSED 127.0.0.1:5432; connect ECONNREFUSED ::1:5432';
const PLAIN_REASON = 'the schema_meta stamp is unreadable';

const SUBJECT = `import { runStoreConformance } from ${JSON.stringify(CONFORMANCE_EMIT)};
runStoreConformance('aggregate', () => {
  throw new AggregateError([
    new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    new Error('connect ECONNREFUSED ::1:5432'),
  ]);
});
runStoreConformance('plain', () => {
  throw new Error(${JSON.stringify(PLAIN_REASON)});
});
`;

describe('Store conformance connect-or-skip', () => {
  test('a factory that throws skips every test it registered, each naming the reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'economy-connect-or-skip-'));
    let out: string;
    try {
      const file = join(dir, 'subject.test.mjs');
      writeFileSync(file, SUBJECT);
      const env = { ...process.env };
      // node --test leaks this to children, and a child that inherits it reports to a parent that
      // is not listening and exits 0 whatever its tests did. Deleted, never blanked.
      delete env.NODE_TEST_CONTEXT;
      const ran = spawnSync(
        process.execPath,
        ['--test', '--test-reporter=tap', '--test-timeout=600000', file],
        { encoding: 'utf8', env, timeout: 120_000 },
      );
      out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const count = (field: string): number =>
      Number(new RegExp(`^# ${field} (\\d+)$`, 'm').exec(out)?.[1] ?? NaN);
    const naming = (reason: string, suite: string): number =>
      out
        .split('\n')
        .filter((line) =>
          line.includes(`# SKIP ${suite} backend unreachable: ${reason}`),
        ).length;

    const registered = count('tests');
    // Exit status is not evidence: a runner that matched no file also exits 0.
    assert.ok(
      registered > 0,
      `the child runner registered no tests, so it reported on nothing:\n${out}`,
    );
    assert.equal(count('fail'), 0, out);
    assert.equal(count('cancelled'), 0, out);
    // Each suite registers one case that reports how many cases it registers. It asks nothing of
    // a store, so it runs when none is reachable — and it is the only registered test that does.
    const pins = [...out.matchAll(/^\s*ok \d+ - registers the \d+ cases /gm)]
      .length;
    assert.equal(pins, 2, out);
    // Every other test the two suites registered skipped, and every skip carried its reason.
    assert.equal(count('skipped'), registered - pins, out);
    const fromAggregate = naming(AGGREGATE_REASON, 'aggregate');
    const fromPlain = naming(PLAIN_REASON, 'plain');
    assert.equal(fromAggregate + fromPlain, registered - pins, out);
    assert.equal(fromAggregate, fromPlain, out);
  });
});

// --- What the published suite actually calls ----------------------------------------

// `runStoreConformance` is what an out-of-repo store runs to declare itself correct, so a member it
// never invokes is a member a third party can ship wrong and still be certified. The roster below is
// resolved from the `Store` type by the checker and the invoked set from a real run, because a
// hand-written list of either has the same hole one level up: a 95th member arrives uncovered and
// nothing fails.

const PORTS_SOURCE = fileURLToPath(new URL('../src/ports.ts', import.meta.url));

function callable(checker: TypeChecker, symbol: TsSymbol): boolean {
  const at = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (at === undefined) {
    return false;
  }
  return (
    checker
      .getTypeOfSymbolAtLocation(symbol, at)
      .getNonNullableType()
      .getCallSignatures().length > 0
  );
}

/**
 * Every callable member of `Store`, dotted from the store, plus the sub-store handles they hang off
 * and the count of properties walked. `Store`'s own methods contribute their bare name; a sub-store
 * handle contributes one entry per method of its interface. `Unit` needs no separate walk — it hands
 * out the same interfaces, so a call through the transaction unit resolves to the same member.
 *
 * `optional` is the same walk read for the `?` marker, over members and handles alike, and it is
 * what the roster is held to: a capability resolves an optional member or it resolves nothing.
 */
function storePortSurface(): {
  members: string[];
  handles: string[];
  optional: Set<string>;
  walked: number;
} {
  const program = createProgram([PORTS_SOURCE], {
    target: ScriptTarget.ESNext,
    module: ModuleKind.NodeNext,
    moduleResolution: ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(PORTS_SOURCE);
  assert.notEqual(file, undefined, 'src/ports.ts did not load');
  const declaration = file!.statements.find(
    (statement) =>
      isInterfaceDeclaration(statement) && statement.name.text === 'Store',
  );
  assert.notEqual(declaration, undefined, 'no Store interface in src/ports.ts');
  const symbol = checker.getSymbolAtLocation(
    (declaration as import('typescript').InterfaceDeclaration).name,
  );
  const store = checker.getDeclaredTypeOfSymbol(symbol!);

  const members: string[] = [];
  const handles: string[] = [];
  const optional = new Set<string>();
  const isOptional = (of: TsSymbol): boolean =>
    (of.flags & SymbolFlags.Optional) !== 0;
  let walked = 0;
  for (const property of store.getProperties()) {
    walked += 1;
    if (isOptional(property)) {
      optional.add(property.name);
    }
    if (callable(checker, property)) {
      members.push(property.name);
      continue;
    }
    handles.push(property.name);
    const at = property.valueDeclaration ?? property.declarations?.[0];
    const port = checker
      .getTypeOfSymbolAtLocation(property, at!)
      .getNonNullableType();
    for (const member of port.getProperties()) {
      walked += 1;
      if (isOptional(member)) {
        optional.add(`${property.name}.${member.name}`);
      }
      if (callable(checker, member)) {
        members.push(`${property.name}.${member.name}`);
      }
    }
  }
  return { members: members.sort(), handles: handles.sort(), optional, walked };
}

const EMIT = (path: string): string =>
  JSON.stringify(new URL(path, import.meta.url).href);

// A Store that records the dotted path of every member a caller invokes, and nothing on a mere
// property read — presence resolution must not read as coverage. `transaction` and
// `batchTransaction` re-wrap the Unit they hand the work function, because that is where most of
// the suite's calls land.
const RECORDER = (handles: readonly string[]): string => `
const HANDLES = new Set(${JSON.stringify(handles)});
const seen = new Set();
const wrapPort = (port, prefix) =>
  port === undefined || port === null
    ? port
    : new Proxy(port, {
        get(target, key) {
          const value = target[key];
          if (typeof value !== 'function' || typeof key !== 'string') return value;
          return (...args) => {
            seen.add(prefix + '.' + key);
            return value.apply(target, args);
          };
        },
      });
const wrapUnit = (unit) =>
  new Proxy(unit, {
    get(target, key) {
      const value = target[key];
      if (typeof key === 'string' && HANDLES.has(key)) return wrapPort(value, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
const wrapStore = (store) =>
  new Proxy(store, {
    get(target, key) {
      const value = target[key];
      if (typeof key !== 'string') return value;
      if (HANDLES.has(key)) return wrapPort(value, key);
      if (typeof value !== 'function') return value;
      if (key === 'transaction')
        return (work, options) => {
          seen.add('transaction');
          return value.call(target, (unit) => work(wrapUnit(unit)), options);
        };
      if (key === 'batchTransaction')
        return (works, options) => {
          seen.add('batchTransaction');
          return value.call(
            target,
            works.map((one) => (unit) => one(wrapUnit(unit))),
            options,
          );
        };
      return (...args) => {
        seen.add(key);
        return value.apply(target, args);
      };
    },
  });
`;

/** Runs one generated subject, returning its TAP output and the members it recorded. */
function record(
  subject: (out: string) => string,
  args: readonly string[],
): { out: string; seen: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'economy-port-coverage-'));
  try {
    const recorded = join(dir, 'seen.json');
    const file = join(dir, 'subject.mjs');
    writeFileSync(file, subject(recorded));
    const env = { ...process.env };
    // Same reason as the connect-or-skip child: an inherited context makes a child exit 0
    // whatever its tests did.
    delete env.NODE_TEST_CONTEXT;
    const ran = spawnSync(process.execPath, [...args, file], {
      encoding: 'utf8',
      env,
      timeout: 300_000,
    });
    const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`;
    let seen: string[] = [];
    try {
      seen = JSON.parse(readFileSync(recorded, 'utf8')) as string[];
    } catch {
      // Left empty on purpose. The assertions read the TAP output too, so a subject that died
      // before writing fails on what it reported rather than on a missing file.
    }
    return { out, seen };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const COVERAGE_SUBJECT = (handles: readonly string[]) => (out: string) => `
import { writeFileSync } from 'node:fs';
import { runStoreConformance } from ${EMIT('../packages/conformance/dist/store.js')};
import { memoryStore } from ${EMIT('../dist/src/adapters/memory.js')};
${RECORDER(handles)}
process.on('exit', () => writeFileSync(${JSON.stringify(out)}, JSON.stringify([...seen].sort())));
runStoreConformance('recorded-memory', () => wrapStore(memoryStore()), {
  capabilities: { lockMany: false, appendAll: false },
});
`;

// The positive control, and the half that matters is the negative one: a recorder that reported
// every member of every port it wrapped would satisfy the gate above having proven nothing. This
// subject calls four members, one of them through the transaction unit, and the recorder must name
// exactly those four and the close.
const CONTROL_SUBJECT = (handles: readonly string[]) => (out: string) => `
import { writeFileSync } from 'node:fs';
import { memoryStore } from ${EMIT('../dist/src/adapters/memory.js')};
${RECORDER(handles)}
const store = wrapStore(memoryStore());
store.ledger.timeline('usr:control');
await store.sales.get('ord_control');
await store.transaction(async (unit) => {
  await unit.trust.read('subj_control');
});
await store.close();
writeFileSync(${JSON.stringify(out)}, JSON.stringify([...seen].sort()));
`;

const SURFACE = storePortSurface();

// Where the roster stops, held by the type rather than by a sentence. Every capability resolves an
// optional member of `Store`, which is what a store can be built with or without; a property with
// no member behind it — whether two transactions overlap, how the engine orders a page — cannot
// join the roster, because `capabilitiesOf` answers by looking at members and would have nothing to
// look at. `lockMany` is the near miss that makes this worth gating: it resolves a ledger method's
// presence, so leaning on it for "this store runs writers concurrently" reads as an answer and is a
// proxy. A racing case is gated on the capability whose own semantics need the overlap, and asserts
// the overlap it saw.
describe('Store capability boundary', () => {
  test('every capability resolves a member the port declares optional', () => {
    let checked = 0;
    for (const capability of STORE_CAPABILITIES) {
      const paths = KNOCKOUTS[capability];
      assert.notEqual(paths.length, 0, `${capability} knocks nothing out`);
      for (const path of paths) {
        assert.ok(
          SURFACE.optional.has(path),
          `${capability} reads ${path}, which Store does not declare optional`,
        );
        checked += 1;
      }
    }
    assert.equal(checked, 18);
  });

  // The optionality read has to be able to answer no, or the gate above passes on every path it is
  // ever handed. These four are required on the port and are what a behavioural capability would
  // have to reach for, having no optional member of its own.
  test('a required member is not optional, so the reading above can refuse', () => {
    let refused = 0;
    for (const path of [
      'transaction',
      'close',
      'ledger.append',
      'idempotency.claim',
    ]) {
      assert.ok(
        SURFACE.members.includes(path),
        `${path} is not a member of Store, so it controls nothing`,
      );
      assert.equal(
        SURFACE.optional.has(path),
        false,
        `${path} is required on the port and read as optional`,
      );
      refused += 1;
    }
    assert.equal(refused, 4);
  });

  // Exact, not a floor. An optional member nobody rostered is the surface the suite branches on
  // nothing for, which is the hole the roster exists to close, so a new one lands here first.
  test('names every optional member the port carries', () => {
    assert.deepEqual([...SURFACE.optional].sort(), [
      'batchTransaction',
      'checkpoints.archiveHeads',
      'checkpoints.archiveState',
      'checkpoints.putArchiveBoundary',
      'checkpoints.putReproof',
      'checkpoints.putSealHeads',
      'checkpoints.reproof',
      'checkpoints.sealHeads',
      'idempotency.deleteOlderThan',
      'ledger.appendAll',
      'ledger.archivePage',
      'ledger.historySize',
      'ledger.lockMany',
      'ledger.prune',
      'movements.pruneSession',
      'movements.sessionIds',
      'reservations',
      'tableSizes',
    ]);
  });
});

describe('Store port coverage', () => {
  const surface = SURFACE;

  test('resolves the whole Store surface from the type, dropping nothing', () => {
    // Exact, not a floor: a member added to the port has to land here, and the deep-equal below
    // then has to account for it.
    assert.equal(surface.members.length, 94);
    assert.equal(surface.handles.length, 15);
    // Every property walked came out as a member or as a handle. A sub-store carrying a
    // non-callable field would leave the counts apart, and that field would go silently uncovered.
    assert.equal(
      surface.walked,
      surface.members.length + surface.handles.length,
    );
  });

  test('the recorder names every member a caller invokes and no other', () => {
    const { out, seen } = record(CONTROL_SUBJECT(surface.handles), []);
    assert.deepEqual(
      seen,
      ['close', 'ledger.timeline', 'sales.get', 'transaction', 'trust.read'],
      out,
    );
  });

  test('the published suite invokes every member of the port it certifies', () => {
    const { out, seen } = record(COVERAGE_SUBJECT(surface.handles), [
      '--test',
      '--test-reporter=tap',
      '--test-timeout=600000',
    ]);
    const count = (field: string): number =>
      Number(new RegExp(`^# ${field} (\\d+)$`, 'm').exec(out)?.[1] ?? NaN);

    // The run has to have happened. An empty run records nothing, and nothing is a subset of
    // everything, so without these the deep-equal below would be satisfiable by a suite that
    // registered no tests at all.
    const registered = count('tests');
    assert.ok(registered > 0, `the child runner registered no tests:\n${out}`);
    assert.equal(count('fail'), 0, out);
    assert.equal(count('cancelled'), 0, out);
    assert.equal(count('pass'), registered - count('skipped'), out);
    assert.ok(count('pass') > 0, out);

    // What the reference store does not offer is excused, and the excuse is derived: the
    // capabilities it resolves false, mapped through the KNOCKOUTS table above, which the knockout
    // test holds live. A handle-level knockout stands for every member under it.
    const resolved = capabilitiesOf(memoryStore());
    const excused = new Set<string>();
    for (const capability of STORE_CAPABILITIES) {
      if (resolved[capability]) {
        continue;
      }
      for (const path of KNOCKOUTS[capability]) {
        for (const member of surface.members) {
          if (member === path || member.startsWith(`${path}.`)) {
            excused.add(member);
          }
        }
      }
    }
    assert.deepEqual(
      [...excused].sort(),
      ['ledger.appendAll', 'ledger.lockMany'],
      'the reference store offers ten of the twelve capabilities',
    );

    const strays = seen.filter((member) => !surface.members.includes(member));
    assert.deepEqual(
      strays,
      [],
      'recorded something the port does not declare',
    );
    assert.deepEqual(
      seen.sort(),
      surface.members.filter((member) => !excused.has(member)),
      'a member the suite never calls is a member a certified store can ship wrong',
    );
    assert.equal(seen.length, surface.members.length - excused.size);
  });
});

// --- The RateLimiter runner ----------------------------------------------------------

// `RateLimiter` had two implementations and no shared suite, while the memory adapter's own doc
// block claimed "the same observable contract as the Redis adapter" with nothing reading that
// sentence. The gate is the two channels the store half keeps: an exact title roster taken from the
// suite's source, and the cases run against a limiter wrong in the way they exist to catch.

const LIMITER_SOURCE = readFileSync(
  new URL('../packages/conformance/src/rate-limit.ts', import.meta.url),
  'utf8',
);

// The wedge `Q33` measured, written as a limiter of its own: the counter outlives the expiry meant
// to clear it, so it climbs forever and every denial reports a full window that no wait clears. Its
// `allow` never reads the clock, which is exactly the defect — a limiter cannot leave this state.
function wedgingLimiter(policy: RatePolicy): RateLimiter {
  const counts = new Map<string, number>();
  return {
    allow: async (key) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count <= policy.limit
        ? { allowed: true }
        : { allowed: false, retryAfterMs: policy.windowMs };
    },
  };
}

// Time genuinely passes on the harness's clock, so a case that fails here fails because the limiter
// will not leave the state and not because the window never elapsed.
function harnessOver(
  make: (policy: RatePolicy, clock: { now: () => number }) => RateLimiter,
): RateLimiterHarness {
  const clock = fixedClock(1_000_000);
  return {
    make: (policy) => make(policy, clock),
    elapse: async (ms) => {
      clock.advance(ms);
    },
  };
}

const LIMITER_SUBJECT = (out: string) => `
import { writeFileSync } from 'node:fs';
import { runRateLimiterConformance } from ${EMIT('../packages/conformance/dist/rate-limit.js')};
writeFileSync(${JSON.stringify(out)}, '[]');
runRateLimiterConformance('unreachable', () => {
  throw new Error('REDIS_URL unset');
});
`;

describe('RateLimiter conformance roster', () => {
  const titles = registeredTitles(LIMITER_SOURCE);

  test('reads every title the rate limiter suite registers', () => {
    assert.equal(titles.size, 6);
  });
});

describe('RateLimiter conformance refusal', () => {
  // The two exported cases are the ones that ask a window to reopen, so they are the two a wedged
  // limiter has to fail. Run as a pair, with the count asserted: one refusal proves one case.
  const RECOVERY: ReadonlyArray<{
    label: string;
    run: (harness: RateLimiterHarness) => Promise<void>;
    refusal: RegExp;
  }> = [
    {
      label: 'the wait a denial reports is one that elapses',
      run: waitsOutTheReportedRetry,
      refusal: /the wait the denial reported did not clear it/,
    },
    {
      label: 'leaves every state it reaches',
      run: leavesEveryStateItReaches,
      refusal: /the whole budget is back once the window has passed/,
    },
  ];

  test('the recovery cases refuse a limiter whose counter outlives its window', async () => {
    let refused = 0;
    for (const recovery of RECOVERY) {
      await assert.rejects(
        recovery.run(harnessOver((policy) => wedgingLimiter(policy))),
        recovery.refusal,
        recovery.label,
      );
      refused += 1;
    }
    assert.equal(refused, 2);
  });

  test('the same cases pass the limiter the wedge is written against', async () => {
    let passed = 0;
    for (const recovery of RECOVERY) {
      await recovery.run(
        harnessOver((policy, clock) => memoryRateLimiter(policy, clock)),
      );
      passed += 1;
    }
    assert.equal(passed, 2);
  });
});

// The connect-or-skip contract for the limiter suite, read off a real run of the emit `./testing`
// publishes — the same reason the store half needs a child runner: a suite reports its own skips, so
// nothing inside it can assert this.
describe('RateLimiter conformance connect-or-skip', () => {
  test('a harness factory that throws skips every case it registered, naming the reason', () => {
    const { out } = record(LIMITER_SUBJECT, [
      '--test',
      '--test-reporter=tap',
      '--test-timeout=600000',
    ]);
    const count = (field: string): number =>
      Number(new RegExp(`^# ${field} (\\d+)$`, 'm').exec(out)?.[1] ?? NaN);

    // Exit status is not evidence: a runner that matched no file also exits 0.
    const registered = count('tests');
    assert.ok(
      registered > 0,
      `the child runner registered no tests, so it reported on nothing:\n${out}`,
    );
    assert.equal(count('fail'), 0, out);
    assert.equal(count('cancelled'), 0, out);
    // The case count asks nothing of a limiter, so it runs where every other case skips.
    const pins = [...out.matchAll(/^\s*ok \d+ - registers the \d+ cases /gm)]
      .length;
    assert.equal(pins, 1, out);
    assert.equal(count('skipped'), registered - pins, out);
    const naming = out
      .split('\n')
      .filter((line) =>
        line.includes(
          '# SKIP unreachable limiter unavailable: REDIS_URL unset',
        ),
      ).length;
    assert.equal(naming, registered - pins, out);
  });
});

/**
 * The case count each conformance suite declares is only worth the diff it forces if the counter
 * counts. Read off the emit `./testing` publishes, because that is the copy every driving package
 * loads and the copy a late rebuild moves.
 *
 * The failing half is the point: a counter that assigned itself the declared number would satisfy
 * every pin in the tree and would still be counting nothing.
 */
const CASES_SUBJECT = (declared: number) => (): string => `
import { test as nodeTest } from 'node:test';
import { countedCases } from ${EMIT('../packages/conformance/dist/cases.js')};
const test = countedCases('fixture', ${declared}, (name, body) => nodeTest(name, body));
test('one', () => {});
test('two', () => {});
`;

describe('conformance case counts', () => {
  // Three registrations: the two above and the count itself.
  const run = (declared: number): string =>
    record(CASES_SUBJECT(declared), [
      '--test',
      '--test-reporter=tap',
      '--test-timeout=60000',
    ]).out;

  test('a suite that declares what it registers passes', () => {
    const out = run(3);
    assert.match(out, /^# pass 3$/m, out);
    assert.match(out, /^# fail 0$/m, out);
  });

  test('a suite that registers a case it did not declare fails, naming both numbers', () => {
    const out = run(2);
    assert.match(out, /^# fail 1$/m, out);
    assert.match(out, /fixture registers 3 cases and declares 2/, out);
  });
});
