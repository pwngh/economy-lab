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
 * Pins the event roster. EconomyEvent.type is the EVENT_TYPES union, so an emit outside the
 * roster fails to compile; this test keeps the roster itself deliberate.
 *
 * It also holds every emitter to one version constant. The type system cannot: `version` is a
 * `number`, so any literal compiles, and a stamp written as `version: 2` ships an event no
 * consumer decodes. The two sweeps below read the source of every stamp instead.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_TYPES } from '#src/ports.ts';
import { sourceFiles } from '#test/support/dedupe.ts';

const ROOT = process.cwd();

/** Every shipped lab source file, keyed by its repo-relative path. */
const labSources = (): { file: string; text: string }[] =>
  sourceFiles(ROOT)
    // `lab` scope now covers test/ and scripts/ too, and this gate is about what src/ emits.
    .filter(({ scope, tree }) => scope === 'lab' && tree === 'shipped')
    .map(({ path }) => ({
      file: relative(ROOT, path),
      text: readFileSync(path, 'utf8'),
    }));

/**
 * A `type:` naming an event, or the submit pipeline's `descriptor.type`, with `version:` on the
 * next line: the shape every emitted-event literal is written in.
 */
const STAMP =
  /type:\s*(?:'economy\.[a-z_.]+'|descriptor\.type)\s*,\s*\n\s*version:\s*([^,\n]+),/g;

/** Every `version:` in the source, whichever shape it is written in. */
const ANY_VERSION = /\bversion:\s*([^,;\n]+)[,;\n]/g;

type Stamp = { at: string; expression: string };

function stampsIn(file: string, text: string): Stamp[] {
  const found: Stamp[] = [];
  for (const match of text.matchAll(STAMP)) {
    const line = text.slice(0, match.index).split('\n').length + 1;
    found.push({ at: `${file}:${line}`, expression: match[1]!.trim() });
  }
  return found;
}

/**
 * Which files stamp a version, and how many times each. Six literals plus the submit pipeline's
 * one `descriptor.type` read, which covers nine of the fourteen types. An eighth stamp, or one in
 * a new file, has to be read and added here. Counted per file rather than per line so an edit
 * above a stamp does not send the next reader looking for a line number to re-aim.
 */
const STAMP_SITES: Record<string, number> = {
  'src/economy.ts': 1,
  'src/instance.ts': 1,
  'src/operations/settlePayout.ts': 1,
  'src/worker/payouts.ts': 1,
  'src/worker/subscriptions.ts': 2,
  'src/worker/treasury.ts': 1,
};

/**
 * `version:` reads that are not an event stamp, each with its reason. The escape sweep below
 * subtracts these, so a stamp written in a shape STAMP does not match cannot hide in the
 * remainder.
 */
const NOT_A_STAMP: Record<string, string> = {
  'src/ports.ts': 'the EconomyEvent.version field declaration itself',
  'src/operation.ts': 'a TSDoc example of an optional wire field',
  'src/wire-contract.ts':
    'the wire envelope version, a string and not this constant',
  'src/adapters/event-wire.ts':
    "passes the stamped event's own version through to the wire",
};

test('EVENT_TYPES is the fourteen-event roster, unique and economy-prefixed', () => {
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(new Set(EVENT_TYPES).size, 14);
  for (const t of EVENT_TYPES) assert.match(t, /^economy\.[a-z_]+\.[a-z_]+$/);
  assert.deepEqual([...EVENT_TYPES].sort(), [
    'economy.credits.clawed_back',
    'economy.credits.topped_up',
    'economy.fees.swept',
    'economy.instance.settled',
    'economy.payout.requested',
    'economy.payout.reversed',
    'economy.payout.settled',
    'economy.promo.granted',
    'economy.sale.completed',
    'economy.sale.refunded',
    'economy.subscription.canceled',
    'economy.subscription.lapsed',
    'economy.subscription.renewed',
    'economy.subscription.started',
  ]);
});

// The detector, proved against a sample carrying the defect, before it is pointed at real source.
// A sweep that finds nothing passes every assertion under it, and one that cannot see a bad stamp
// passes them for the wrong reason.
test('the stamp sweep sees a literal version where a constant belongs', () => {
  const good =
    "      type: 'economy.fees.swept',\n      version: EVENT_VERSION,\n";
  const bad = "      type: 'economy.fees.swept',\n      version: 2,\n";
  const pipeline = '    type: descriptor.type,\n    version: EVENT_VERSION,\n';

  assert.deepEqual(
    stampsIn('sample.ts', good).map((s) => s.expression),
    ['EVENT_VERSION'],
  );
  assert.deepEqual(
    stampsIn('sample.ts', bad).map((s) => s.expression),
    ['2'],
    'a literal stamp is read, not skipped',
  );
  assert.deepEqual(
    stampsIn('sample.ts', pipeline).map((s) => s.expression),
    ['EVENT_VERSION'],
    "the submit pipeline's descriptor read is a stamp too",
  );
  assert.deepEqual(stampsIn('sample.ts', good + bad + pipeline).length, 3);
  assert.equal(
    stampsIn('sample.ts', "  version: 2,\n  type: 'economy.fees.swept',\n")
      .length,
    0,
    'the order is part of the shape: this is what the escape sweep is for',
  );
});

test('every event stamp in the lab reads EVENT_VERSION, and there are seven', () => {
  const perFile: Record<string, number> = {};
  const literals: string[] = [];
  for (const { file, text } of labSources()) {
    for (const stamp of stampsIn(file, text)) {
      perFile[file] = (perFile[file] ?? 0) + 1;
      if (stamp.expression !== 'EVENT_VERSION') {
        literals.push(`${stamp.at} stamps ${stamp.expression}`);
      }
    }
  }
  assert.deepEqual(literals, [], `stamps that do not read the constant:`);
  assert.deepEqual(
    perFile,
    STAMP_SITES,
    'the stamp roster moved — re-read the emitters and set the new counts',
  );
  assert.equal(
    Object.values(perFile).reduce((sum, n) => sum + n, 0),
    7,
    'seven stamps cover the fourteen types',
  );
});

// The stamp sweep keys on `type:` sitting above `version:`. An emitter written the other way round
// would be invisible to it, so every remaining `version:` in the lab is named and reasoned.
test('no version read in the lab escapes the stamp sweep unreasoned', () => {
  const stamped = new Set<string>();
  const unexplained: string[] = [];
  let examined = 0;
  for (const { file, text } of labSources()) {
    for (const stamp of stampsIn(file, text)) stamped.add(stamp.at);
    for (const match of text.matchAll(ANY_VERSION)) {
      examined += 1;
      const line = text.slice(0, match.index).split('\n').length;
      if (stamped.has(`${file}:${line}`)) continue;
      if (NOT_A_STAMP[file] !== undefined) continue;
      unexplained.push(`${file}:${line} — ${match[0]!.trim()}`);
    }
  }
  assert.deepEqual(
    unexplained,
    [],
    'a version read that is neither a stamp nor on the reasoned list',
  );
  assert.equal(examined, 11, `swept ${examined} version reads, expected 11`);
  assert.equal(stamped.size, 7);
  assert.deepEqual(Object.keys(NOT_A_STAMP).sort(), [
    'src/adapters/event-wire.ts',
    'src/operation.ts',
    'src/ports.ts',
    'src/wire-contract.ts',
  ]);
});
