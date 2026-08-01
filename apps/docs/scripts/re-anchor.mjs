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

// Repairs drifted `#Lnn` chips after a source edit — the write half of the flow whose detection
// halves are app/anchors.test.ts (the chip resolves to a declaration) and scripts/check-ref.mjs
// (the working tree is byte-identical to the pinned REPO_REF). It shares app/anchors.ts with the
// gate, so the tool and the gate cannot disagree about what a chip means.
//
// A chip that already resolves is untouched. A drifted one moves to its symbol's DECLARATION,
// keeping its span. It never searches for the nearest textual occurrence: doing that once sent a
// chip eleven lines above its own start, into a neighbouring symbol's @example, where it passed the
// gate of the day. A symbol with no declaration left, or with more than one and no way to tell them
// apart, is reported rather than guessed.
//
//   npm run anchors:fix        # then re-run `npm test` to confirm, and re-pin after commit

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONTENT_DIR,
  collectChips,
  defaultContext,
  labelTarget,
  resolveChip,
} from '../app/anchors.ts';

const inventory = collectChips();
const ctx = defaultContext();

let fixed = 0;
let stranded = 0;
const edits = new Map();

for (const chip of inventory.chips) {
  if (chip.start === null || !chip.label) continue;
  if (resolveChip(chip, ctx) === null) continue;

  const where = `${chip.page}:${chip.line}`;
  const target = labelTarget(chip.label);
  const { declarations } = ctx.read(join(ctx.repoRoot, chip.path));
  const found = (declarations ?? []).filter((d) => d.name === target);
  if (found.length === 0) {
    console.error(`re-anchor: ${where}: ${chip.path} declares no ${target} — fix by hand`);
    stranded += 1;
    continue;
  }
  // Several declarations of one name is the case a tool must not pick between: `spend` is both the
  // function and every `kind: 'spend'` in the file. Nearest-to-where-it-was is a guess, so it asks.
  if (found.length > 1) {
    const lines = found.map((d) => `L${d.line}`).join(', ');
    console.error(`re-anchor: ${where}: ${chip.path} declares ${target} at ${lines} — pick one`);
    stranded += 1;
    continue;
  }
  const declaration = found[0];
  const span = (chip.end ?? chip.start) - chip.start;
  const before = `#L${chip.start}${span ? `-L${chip.end}` : ''}`;
  const after = `#L${declaration.line}${span ? `-L${declaration.line + span}` : ''}`;
  const list = edits.get(chip.page) ?? [];
  list.push({ raw: chip.raw, before, after, target });
  edits.set(chip.page, list);
  fixed += 1;
  console.log(`re-anchor: ${where}: ${chip.path}${before} -> ${after} (${target})`);
}

for (const [page, list] of edits) {
  const file = join(CONTENT_DIR, page);
  let text = readFileSync(file, 'utf8');
  for (const edit of list)
    text = text.replaceAll(edit.raw, edit.raw.replace(edit.before, edit.after));
  writeFileSync(file, text);
}

console.log(`re-anchor: ${fixed} chip(s) moved, ${stranded} need a human`);
if (stranded > 0) process.exit(1);
