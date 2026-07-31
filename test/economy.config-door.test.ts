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
 * The knob bounds are a property of the economy, not of the door that reached it. `mergeConfig`
 * covers every door that BUILDS a config; this file covers the doors that take a finished one and
 * hand it to the money path. The roster of those doors is resolved from `src/` rather than listed
 * here, so a new one either gets a cell below or fails the gate.
 *
 * The refusal legs assert balances rather than an outcome status, because the failure this file
 * exists to catch is money posted to the wrong account.
 *
 * **The roster is resolved by the TypeScript checker, not by matching the parameter's text.**
 * Matching text on `Ports` missed `createServer` for a release: it takes a `ServerPorts`, which is
 * a `Pick<Ports, …>` and carries the same `config` under a different name. So the question asked
 * here is the one that matters — does this parameter reach a property typed `Config` — and a bag
 * of any shape answers it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { createEconomy } from '#src/economy.ts';
import { createServer } from '#src/server.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { SYSTEM, earned, spendable } from '#src/accounts.ts';
import {
  createWorker,
  drainInbox,
  relayOutbox,
  runSweeps,
} from '#src/worker/index.ts';
import {
  InstanceEconomies,
  InstanceEconomy,
  openInstanceEconomies,
  openInstanceEconomy,
} from '#src/instance.ts';
import { makePorts, testConfig } from '#test/support/capabilities.ts';
import { adjust, credit, spend } from '#test/support/builders.ts';

import type { Config } from '#src/config.ts';
import type { Economy } from '#src/contract.ts';
import type { Dispatcher, Ports, Store } from '#src/ports.ts';

const ROOT = new URL('..', import.meta.url).pathname;

const BUYER = 'usr_door_buyer';
const SELLER = 'usr_door_seller';

// 30% is the fixture fee every worked amount in this file derives from, and it is inside the
// 0..10000 bps bound. 99999 is outside it: the env reader discards it for 1530 and the init path
// refuses it.
const OUT_OF_BOUND_FEE = 99_999;

// The refusal has to hand a caller the knob and the range, not a generic "config is invalid".
const FEE_FRAGMENT =
  'config.platformFeeBps must be a whole number from 0 to 10000';

// Measured on this tree at 3000 bps against a 10,000-minor funding and a 1,000-minor sale.
// There is no split a 99999 bps fee could post correctly, so the only non-defective outcome for
// that config is a refusal; comparing against these figures is what prints the legs it books.
const SPLIT = { buyer: 9000n, seller: 700n, revenue: 300n };

function bagWith(config: Config, store: Store = memoryStore()): Ports {
  return makePorts(store, { config });
}

const goodConfig = (): Config => testConfig();
const badConfig = (): Config => ({
  ...testConfig(),
  platformFeeBps: OUT_OF_BOUND_FEE,
});

// One funded sale, reported as the three balances the fee decides.
async function sellOnce(
  economy: Economy,
): Promise<{ buyer: bigint; seller: bigint; revenue: bigint }> {
  await economy.submit(
    adjust({
      account: spendable(BUYER),
      amount: credit('100.00'),
      reason: 'fund the buyer for the sale below',
    }),
  );
  await economy.submit(
    spend({
      buyerId: BUYER,
      sku: 'wrld_pass',
      price: credit('10.00'),
      recipients: [{ sellerId: SELLER, shareBps: 10_000 }],
    }),
  );
  return {
    buyer: (await economy.read.balance(spendable(BUYER))).minor,
    seller: (await economy.read.balance(earned(SELLER))).minor,
    revenue: (await economy.read.balance(SYSTEM.REVENUE)).minor,
  };
}

// A door's outcome, whichever way it reports: the thing it opened, or what it threw.
async function opening<T>(
  open: () => T | Promise<T>,
): Promise<{ opened?: T; refusal?: Error }> {
  try {
    return { opened: await open() };
  } catch (error) {
    return { refusal: error as Error };
  }
}

const stubEconomy = (): Economy => createEconomy(bagWith(goodConfig()));

const silentDispatcher: Dispatcher = async () => undefined;

/**
 * Every door that takes a finished `Config` and can reach a posting, each with the path its own
 * parameters reach the config by. The roster below is checked against the one resolved from
 * `src/`, so a door added there without a cell here fails the gate rather than shipping unchecked.
 *
 * `via` is pinned as well as the name, because it is the half that separates a bag from a bag
 * inside a bag: `createServer` reaches its config at `options.ports.config`, and every text match
 * on the type `Ports` read that as no config at all.
 */
const DOORS: ReadonlyArray<{
  readonly name: string;
  readonly via: string;
  readonly open: (config: Config) => unknown;
}> = [
  {
    name: 'createEconomy',
    via: 'ports.config',
    open: (config) => createEconomy(bagWith(config)),
  },
  {
    name: 'createWorker',
    via: 'ports.config',
    open: (config) => createWorker(bagWith(config), stubEconomy()),
  },
  {
    name: 'runSweeps',
    via: 'ports.config',
    open: (config) => {
      const store = memoryStore();
      return runSweeps(store, bagWith(config, store), { only: [] });
    },
  },
  {
    name: 'drainInbox',
    via: 'ports.config',
    open: (config) => {
      const store = memoryStore();
      return drainInbox(store, bagWith(config, store), {
        economy: stubEconomy(),
        now: 0,
        limit: 1,
      });
    },
  },
  {
    name: 'relayOutbox',
    via: 'ports.config',
    open: (config) => {
      const store = memoryStore();
      return relayOutbox(store, bagWith(config, store), {
        dispatcher: silentDispatcher,
        limit: 1,
      });
    },
  },
  {
    name: 'openInstanceEconomy',
    via: 'deps.config',
    open: (config) => openInstanceEconomy(bagWith(config), 'sess:door:0', {}),
  },
  {
    name: 'new InstanceEconomy',
    via: 'deps.config',
    open: (config) => new InstanceEconomy(bagWith(config), 'sess:door:1', {}),
  },
  {
    name: 'openInstanceEconomies',
    via: 'deps.config',
    open: (config) =>
      openInstanceEconomies(bagWith(config), {}).laneFor('door'),
  },
  {
    name: 'new InstanceEconomies',
    via: 'deps.config',
    open: (config) =>
      new InstanceEconomies(bagWith(config), {}).laneFor('door'),
  },
  {
    name: 'createServer',
    via: 'options.ports.config',
    open: (config) =>
      createServer({
        economy: stubEconomy(),
        ports: bagWith(config),
        authenticate: false,
      }),
  },
];

// --- The rosters, resolved from src/ -------------------------------------------------

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found;
}

const SOURCES = sourceFiles(join(ROOT, 'src'));

// One program over src/, shared by all three rosters below. Roughly half a second, and it is what
// buys the answer to "does this Pick still carry a config" without restating type resolution here.
const program = ts.createProgram(SOURCES, {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  types: [],
});
const checker = program.getTypeChecker();

function walk(visit: (file: ts.SourceFile, relative: string) => void): void {
  for (const path of SOURCES) {
    const file = program.getSourceFile(path);
    if (file !== undefined) {
      visit(file, path.slice(ROOT.length));
    }
  }
}

const exported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (one) => one.kind === ts.SyntaxKind.ExportKeyword,
  );

// The type of a `config` member, as the checker renders it, or null when the type has no such
// member. `Pick`, `Omit`, an intersection and a plain interface all answer the same way.
function configMember(type: ts.Type): string | null {
  const property = type.getProperty('config');
  const declared = property?.valueDeclaration ?? property?.declarations?.[0];
  if (property === undefined || declared === undefined) {
    return null;
  }
  return checker.typeToString(
    checker.getTypeOfSymbolAtLocation(property, declared),
  );
}

/**
 * The path from a parameter to a config the bounds check has not seen: `config` when the bag holds
 * one directly, `ports.config` when it holds a bag that does, and null when nothing it carries is
 * an unchecked `Config`. A `CheckedConfig` is not a hit — that one is held by the compiler.
 *
 * Fields only, and never through a call signature: a door is what a caller hands in, not what
 * something it calls might build later.
 */
function pathToConfig(
  type: ts.Type,
  seen: Set<ts.Type> = new Set(),
  depth = 0,
): string | null {
  if (depth > 4 || seen.has(type)) {
    return null;
  }
  seen.add(type);
  if (configMember(type) === 'Config') {
    return 'config';
  }
  for (const property of type.getProperties()) {
    const declared = property.valueDeclaration ?? property.declarations?.[0];
    if (declared === undefined) {
      continue;
    }
    const held = checker.getTypeOfSymbolAtLocation(property, declared);
    if (held.getCallSignatures().length > 0) {
      continue;
    }
    const deeper = pathToConfig(held, seen, depth + 1);
    if (deeper !== null) {
      return `${property.name}.${deeper}`;
    }
  }
  return null;
}

/**
 * Every exported function and class constructor in `src/` whose parameters reach an unchecked
 * `Config`, each mapped to the path it reaches it by. This is the roster `DOORS` above must match.
 */
function resolvedDoors(): Record<string, string> {
  const rows: Record<string, string> = {};
  const record = (
    name: string,
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
  ): void => {
    for (const parameter of parameters) {
      const via = pathToConfig(checker.getTypeAtLocation(parameter));
      if (via !== null) {
        rows[name] = `${parameter.name.getText()}.${via}`;
        return;
      }
    }
  };
  walk((file) => {
    file.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name && exported(node)) {
        record(node.name.text, node.parameters);
        return;
      }
      if (ts.isClassDeclaration(node) && node.name && exported(node)) {
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member)) {
            record(`new ${node.name.text}`, member.parameters);
          }
        }
      }
    });
  });
  for (const name of Object.keys(EXEMPT_DOORS)) {
    delete rows[name];
  }
  return rows;
}

/** Named exemptions from the door roster, with the reason each is not a way in. */
const EXEMPT_DOORS: Readonly<Record<string, string>> = {
  checkedPorts: 'the check itself, not a way past it',
};

/**
 * Every named type in `src/` that carries a `config` member, whatever shape the type is written
 * in, mapped to the type of that member. `ServerPorts` is the row this roster exists for: it is a
 * `Pick<Ports, …>`, so nothing in `src/server.ts` is spelled `Config` and the declaration roster
 * below cannot see it.
 */
function configTypes(): Record<string, string> {
  const rows: Record<string, string> = {};
  walk((file, relative) => {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isClassDeclaration(node)) &&
        node.name !== undefined
      ) {
        const symbol = checker.getSymbolAtLocation(node.name);
        const held =
          symbol === undefined
            ? null
            : configMember(checker.getDeclaredTypeOfSymbol(symbol));
        if (held !== null) {
          rows[`${relative} ${node.name.text}`] = held;
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  });
  return rows;
}

/**
 * Every config type `src/` states a bounds table over: the type argument of a
 * `satisfies Readonly<Record<keyof X, …>>`. That constraint is the mechanism itself — a knob
 * added to `X` leaves the table short a key and fails `tsc` — so this resolves the bound rather
 * than a name that stands for one.
 */
function boundedConfigTypes(): string[] {
  const found = new Set<string>();
  walk((file) => {
    const visit = (node: ts.Node): void => {
      if (ts.isSatisfiesExpression(node)) {
        const keyed = keyofTable(node.type);
        if (keyed !== null) {
          found.add(keyed);
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  });
  return [...found].sort();
}

// `Readonly<Record<keyof X, …>>` → `X`, and null for any other shape. A mapped type over a union
// is not this: the row-per-key constraint is what makes the table exhaustive.
function keyofTable(type: ts.TypeNode): string | null {
  const inner =
    ts.isTypeReferenceNode(type) &&
    type.typeName.getText() === 'Readonly' &&
    type.typeArguments?.length === 1
      ? type.typeArguments[0]
      : type;
  if (
    !ts.isTypeReferenceNode(inner) ||
    inner.typeName.getText() !== 'Record' ||
    inner.typeArguments === undefined
  ) {
    return null;
  }
  const key = inner.typeArguments[0];
  return ts.isTypeOperatorNode(key) &&
    key.operator === ts.SyntaxKind.KeyOfKeyword &&
    ts.isTypeReferenceNode(key.type)
    ? key.type.typeName.getText()
    : null;
}

// The config a `CONFIG_TYPES` row holds, with the wrappers a carrier writes it in taken off. A
// brand is the table's own output, so it reduces to the config the table bounds.
function boundedBy(held: string): string {
  return held
    .replace(' | undefined', '')
    .replace(/^Partial<(.+)>$/, '$1')
    .replace(/^CheckedConfig$/, 'Config');
}

// The nearest named declaration around a node, so a row survives an edit that moves a line and
// still tells two carriers in one file apart.
function owner(node: ts.Node, file: ts.SourceFile): string {
  for (let up = node.parent; up !== undefined; up = up.parent) {
    if (
      (ts.isInterfaceDeclaration(up) ||
        ts.isTypeAliasDeclaration(up) ||
        ts.isClassDeclaration(up) ||
        ts.isFunctionDeclaration(up) ||
        ts.isMethodDeclaration(up) ||
        ts.isVariableDeclaration(up)) &&
      up.name !== undefined
    ) {
      return up.name.getText(file);
    }
  }
  return '<file>';
}

/**
 * Every declaration in `src/` that carries a whole `Config` — a field or a parameter typed exactly
 * `Config`. Each one is a place an unchecked config can sit, so each is admitted below by name.
 */
function configCarriers(): string[] {
  const rows: string[] = [];
  walk((file, relative) => {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertySignature(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isParameter(node)) &&
        node.type !== undefined &&
        node.type.getText(file) === 'Config'
      ) {
        rows.push(
          `${relative} ${owner(node, file)}.${node.name.getText(file)}`,
        );
      }
      node.forEachChild(visit);
    };
    visit(file);
  });
  return rows.sort();
}

/**
 * The carriers that may hold a config the bounds check has not seen, each with the reason. A row
 * leaving this list means a new place a finished `Config` sits; it is either checked at its own
 * boundary or admitted here on purpose.
 */
/**
 * Every named type in `src/` holding a `config`, and the type it holds. A `CheckedConfig` row is
 * held by the compiler; a `Config` row is a bag a host builds by hand, and each one is a door
 * above. The two `Partial<Config>` rows are override bags, which `mergeConfig` bounds.
 */
const CONFIG_TYPES: Readonly<Record<string, string>> = {
  'src/contract.ts CheckedPorts': 'CheckedConfig',
  'src/contract.ts Ctx': 'CheckedConfig',
  'src/contract.ts WorkerCtx': 'CheckedConfig',
  'src/index.ts BootInit': 'Partial<Config> | undefined',
  'src/index.ts PortsInit': 'Partial<Config> | undefined',
  'src/instance.ts InstanceEconomy': 'CheckedConfig',
  'src/instance.ts InstanceEconomyDeps': 'Config',
  'src/maturity.ts MaturedAtLeastOptions': 'CheckedConfig',
  'src/maturity.ts MaturityOptions': 'CheckedConfig',
  'src/ports.ts Ports': 'Config',
  'src/server.ts ServerPorts': 'Config',
  'src/supervisor/supervisor.ts Pass': 'SupervisorConfig',
  'src/supervisor/supervisor.ts SupervisorPorts':
    'Partial<SupervisorConfig> | undefined',
};

const ADMITTED_CARRIERS: Readonly<Record<string, string>> = {
  'src/config.ts checkedConfig.config': 'the check itself',
  'src/config.ts mergeConfig.base':
    'mergeConfig checks the overrides; the base is loadConfig output at every internal call',
  'src/index.ts openSelected.config':
    "openSelected's own deps, inside openPorts, downstream of mergeConfig",
  'src/instance.ts InstanceEconomyDeps.config':
    'the published input bag; the lane checks it in its constructor',
  'src/maturity.ts maturityHorizonMs.config':
    'reads one horizon out of a checked config',
  'src/maturity.ts lotMaturesAt.config':
    'reads one horizon out of a checked config',
  'src/maturity.ts isMatured.config':
    'reads one horizon out of a checked config',
  'src/maturity.ts tailSlices.config': 'walks lots against a checked config',
  'src/maturity.ts collectLots.config': 'walks lots against a checked config',
  'src/operations/subscribe.ts validatedPrice.config':
    'reads the price band off ctx.config, which is checked',
  'src/ports.ts Ports.config':
    'the published input bag; every door checks it on the way in',
  'src/trust.ts assessRisk.config':
    'reads a velocity limit off ctx.config, which is checked',
  'src/trust.ts classLimitMinor.config':
    'reads a velocity limit off ctx.config, which is checked',
};

// --- The gate -----------------------------------------------------------------------

describe('a finished Config reaches the money path only through the bounds check', () => {
  test('createEconomy refuses a platform fee outside the bound instead of booking the whole price to platform revenue', async () => {
    const door = await opening(() => createEconomy(bagWith(badConfig())));

    if (door.opened !== undefined) {
      assert.deepEqual(
        await sellOnce(door.opened),
        SPLIT,
        `createEconomy accepted ${OUT_OF_BOUND_FEE} bps and the sale posted`,
      );
    }

    assert.ok(
      door.refusal,
      `createEconomy took a platform fee of ${OUT_OF_BOUND_FEE} bps`,
    );
    assert.equal(
      (door.refusal as { code?: string }).code,
      'CONFIG.INVALID',
      'the refusal carries the config fault code',
    );
    assert.ok(
      door.refusal.message.includes(FEE_FRAGMENT),
      `the refusal has to hand over "${FEE_FRAGMENT}"; it said "${door.refusal.message}"`,
    );
  });

  test('a config inside the bounds still opens every door, and the sale still splits', async () => {
    let opened = 0;
    for (const entry of DOORS) {
      const door = await opening(() => entry.open(goodConfig()));
      assert.equal(
        door.refusal,
        undefined,
        `${entry.name} refused a config inside the bounds: ${door.refusal?.message}`,
      );
      opened += 1;
    }
    assert.equal(opened, DOORS.length);
    assert.equal(opened, 10, `opened ${opened} doors`);

    assert.deepEqual(
      await sellOnce(createEconomy(bagWith(goodConfig()))),
      SPLIT,
      'the in-bound fee still posts the split it always did',
    );
  });

  test('every door that takes a finished Config refuses one outside the bounds', async () => {
    const refused: string[] = [];
    for (const entry of DOORS) {
      const door = await opening(() => entry.open(badConfig()));
      assert.ok(
        door.refusal,
        `${entry.name} opened on ${OUT_OF_BOUND_FEE} bps`,
      );
      assert.equal(
        (door.refusal as { code?: string }).code,
        'CONFIG.INVALID',
        `${entry.name} threw something other than the config fault: ${door.refusal.message}`,
      );
      assert.ok(
        door.refusal.message.includes(FEE_FRAGMENT),
        `${entry.name} has to hand over "${FEE_FRAGMENT}"; it said "${door.refusal.message}"`,
      );
      refused.push(entry.name);
    }
    assert.equal(refused.length, DOORS.length);
    assert.equal(refused.length, 10, `refused at ${refused.length} doors`);
  });

  test('the doors driven above are exactly the ones src/ declares, by the path each reaches a config', () => {
    const declared = resolvedDoors();
    assert.deepEqual(
      declared,
      Object.fromEntries(DOORS.map((one) => [one.name, one.via])),
      'an exported door reaches an unchecked Config and has no cell above',
    );
    assert.equal(
      Object.keys(declared).length,
      10,
      `resolved ${Object.keys(declared).length} doors`,
    );
  });

  test('every named type in src/ holding a config is pinned to the config it holds', () => {
    const resolved = configTypes();
    assert.deepEqual(
      resolved,
      CONFIG_TYPES,
      'a type gained, lost or changed a config member: give it a door cell above, or pin it here',
    );
    assert.equal(
      Object.keys(resolved).length,
      13,
      `examined ${Object.keys(resolved).length} types`,
    );
  });

  // Resolved from src/, not read off CONFIG_TYPES: pinning a new row above must not be a way to
  // make a config nothing bounds go quiet.
  test('every config a src/ type carries is bounded by a table keyed to it, not merely listed here', () => {
    const bounded = boundedConfigTypes();
    const carried = [
      ...new Set(Object.values(configTypes()).map(boundedBy)),
    ].sort();

    assert.deepEqual(
      carried.filter((one) => !bounded.includes(one)),
      [],
      'a type carries a config nothing bounds: give it a table keyed by keyof it, the way KNOBS and SUPERVISOR_KNOBS are',
    );
    assert.deepEqual(
      bounded,
      ['Config', 'SupervisorConfig'],
      'src/ states a bounds table over a config this roster does not know about',
    );
    assert.equal(carried.length, 2, `examined ${carried.length} config types`);
  });

  test('every place src/ carries a whole Config is checked at its boundary or admitted by name', () => {
    const carriers = configCarriers();
    const unadmitted = carriers.filter(
      (row) => ADMITTED_CARRIERS[row] === undefined,
    );
    assert.deepEqual(
      unadmitted,
      [],
      'a new carrier of a whole Config: check it at its boundary, or admit it with a reason',
    );
    assert.deepEqual(
      Object.keys(ADMITTED_CARRIERS)
        .filter((row) => !carriers.includes(row))
        .sort(),
      [],
      'the admission list names a carrier src/ no longer has',
    );
    assert.equal(carriers.length, 13, `examined ${carriers.length} carriers`);
  });
});
