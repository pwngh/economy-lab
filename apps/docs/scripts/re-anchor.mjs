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

// Repairs drifted `#Lnn` sourceRefs chips after a source edit — the write half of the flow
// whose detection halves are app/anchors.test.ts (symbol within range, against the working
// tree) and scripts/check-ref.mjs (working tree byte-identical to the pinned REPO_REF).
//
// A chip whose range no longer contains its label token gets re-pointed: the token occurrence
// nearest the old start wins (definition-looking lines first), the range start moves there,
// and the span is preserved. Chips that still anchor are untouched; a label with no
// occurrence left in its file is reported, not guessed — that chip needs a human.
//
//   npm run anchors:fix        # then re-run `npm test` to confirm, and re-pin after commit

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const CONTENT = join(import.meta.dirname, '../app/content');

// The same chip grammar anchors.test.ts parses: `path[#Lstart[-Lend]][ · label]`.
const REF_SHAPE = /^([^#\s·]+)(?:#L(\d+)(?:-L(\d+))?)?(?:\s*·\s*(.+))?$/;

const mdxFiles = (dir) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => join(dir, f));

// The page's operation kind counts as a symbol, mirroring the test's pageKind.
const pageKind = (page) =>
  (page.split('/').at(-1) ?? page).replace('.mdx', '').replace(/-(\w)/g, (_, c) => c.toUpperCase());

function chipsOf(text) {
  return [
    ...text.matchAll(/'((?:src|test|scripts|db)\/[^']+)'/g),
    ...text.matchAll(/<SourceLink to="([^"]+)"/g),
  ].flatMap((m) => (m[1] ? [m[1]] : []));
}

let fixed = 0;
let stranded = 0;
for (const page of mdxFiles(CONTENT)) {
  let text = readFileSync(page, 'utf8');
  for (const raw of chipsOf(text)) {
    const m = REF_SHAPE.exec(raw.trim());
    if (!m || !m[2] || !m[4]) continue; // no line anchor or no label: nothing to repair
    const [, path, startS, endS, label] = m;
    const start = Number(startS);
    const end = endS ? Number(endS) : start;
    const lines = readFileSync(join(REPO_ROOT, path), 'utf8').split('\n');
    const tokens = [...label.trim().matchAll(/[A-Za-z_$][\w$]*/g)].map((t) => t[0]);
    const candidates = [...tokens, pageKind(page)];
    const range = lines.slice(start - 1, end).join('\n');
    if (candidates.some((t) => range.includes(t))) continue; // still anchored

    const word = new RegExp(`\\b(${candidates.join('|')})\\b`);
    const defish = /\b(export|const|function|interface|type|class)\b/;
    const hits = [];
    lines.forEach((line, i) => {
      if (word.test(line)) hits.push({ line: i + 1, def: defish.test(line) });
    });
    if (hits.length === 0) {
      console.error(
        `re-anchor: no occurrence of [${candidates.join(', ')}] left in ${path} (${page.split('/content/')[1]}) — fix by hand`,
      );
      stranded += 1;
      continue;
    }
    const best = hits.sort(
      (a, b) =>
        Number(b.def) - Number(a.def) || Math.abs(a.line - start) - Math.abs(b.line - start),
    )[0];
    const newStart = best.line;
    const newEnd = newStart + (end - start);
    const oldAnchor = `#L${start}${endS ? `-L${end}` : ''}`;
    const newAnchor = `#L${newStart}${endS ? `-L${newEnd}` : ''}`;
    text = text.replaceAll(raw, raw.replace(oldAnchor, newAnchor));
    fixed += 1;
    console.log(
      `re-anchor: ${page.split('/content/')[1]}: ${path}${oldAnchor} -> ${newAnchor} (${label.trim()})`,
    );
  }
  writeFileSync(page, text);
}

console.log(`re-anchor: ${fixed} chip(s) moved, ${stranded} need a human`);
if (stranded > 0) process.exit(1);
