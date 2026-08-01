/**
 * @pwngh/economy-cli
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
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// H4: every refusal names its fix. The walker enumerates raise sites mechanically —
// every `new EconomyModuleError(` in this package and in the core, and every CLI refusal
// written as a literal onto the error stream — so a new refusal cannot ship fixless.
// The fix lives in the message's own text: a backticked command or export to reach for,
// an imperative verb, or the legal forms named. Sites that are genuinely fix-free go on
// the allowlist below, each with its reason.

const req = createRequire(import.meta.url);
const CLI = dirname(req.resolve('../package.json'));
const ECONOMY = dirname(req.resolve('@pwngh/economy-core/package.json'));

const sourceFiles = (): { file: string; text: string }[] => {
  const files = [
    ...readdirSync(join(CLI, 'src', 'lib'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(CLI, 'src', 'lib', f)),
    ...readdirSync(join(CLI, 'src', 'lib', 'commands'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(CLI, 'src', 'lib', 'commands', f)),
    ...readdirSync(join(ECONOMY, 'src'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(ECONOMY, 'src', f)),
  ];
  return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
};

// Slices the balanced-paren call text starting at the opening paren.
function callText(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced call');
}

// Top-level comma split, so the fix argument can be read apart from code/file/export.
function splitArgs(call: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < call.length; i += 1) {
    const c = call[i]!;
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      args.push(call.slice(start, i));
      start = i + 1;
    }
  }
  args.push(call.slice(start));
  return args;
}

// What counts as carrying a fix: a backticked thing to type, an imperative verb, or the
// legal forms named. Deliberately narrow — a message that only states the fault fails.
const ACTIONABLE = new RegExp(
  [
    '`[^`]+`',
    String.raw`\b(run|drop|pick|move|rename|create|set|unset|point|pass|regenerate|stop|copy|fill|align|change|use|apply|add|keep|send|state|fix)\b`,
    String.raw`\b(takes|needs|must be|must answer|one of|is not|are not|has no|form is|did you mean)\b`,
    // The legal set handed over whole, after the colon that introduces it.
    String.raw`:\s*\$\{[\w.]+\.join\(`,
    'Reads:|hosts:',
  ].join('|'),
  'i',
);

// The walker hands over raw source text, so the message still wears the quotes it was
// written with. Strip them: a template literal would otherwise satisfy the backtick branch
// on its own delimiters, which passed every interpolating fix in packages/core.
const carriesFix = (raw: string): boolean =>
  ACTIONABLE.test(raw.replace(/^[`'"]/, '').replace(/[`'"]$/, ''));

// file-basename:first-words → why this site carries no fix of its own.
//
// The walk that consults this list covers `packages/cli/src` only, so a key naming a file outside it
// can never be hit. `truth.ts:error  ${` was such a key: `truth.ts` is in `packages/core`, which the
// literal sweep skips. Every key here is asserted hit, so a dead entry is a failure rather than a
// silent shrink of what gets audited.
const ALLOWLIST: Record<string, string> = {
  'cli.ts:run `economy check` for':
    'the trailing fix line itself, printed under the named refusal',
  'service.ts:run `economy check` for':
    'the trailing fix line itself, printed under the named refusal',
  'service.ts:preflight  ${':
    'a report row — the closing line beneath it names the fix',
};

/** The allowlist key this site matches, or null. */
const allowedBy = (file: string, body: string): string | null =>
  Object.keys(ALLOWLIST).find((key) => {
    const [base, prefix] = [
      key.slice(0, key.indexOf(':')),
      key.slice(key.indexOf(':') + 1),
    ];
    return file.endsWith(base) && body.startsWith(prefix);
  }) ?? null;

test('the fix pattern reads the message, not the quotes around it', () => {
  assert.equal(carriesFix('`broken`'), false, 'delimiters are not a fix');
  assert.equal(carriesFix('`${detail}`'), false, 'nor is an interpolation');
  assert.equal(carriesFix("'the module is broken'"), false, 'fault only');
  assert.equal(
    carriesFix('`run \\`economy check\\` first`'),
    true,
    'a backticked thing to type still counts',
  );
  assert.equal(
    carriesFix("'must be an object'"),
    true,
    'so do the legal forms',
  );
});

test('every EconomyModuleError raise site carries an actionable fix argument', () => {
  const failures: string[] = [];
  let count = 0;
  for (const { file, text } of sourceFiles()) {
    for (const m of text.matchAll(/new EconomyModuleError\(/g)) {
      count += 1;
      const args = splitArgs(
        callText(text, m.index + 'new EconomyModuleError'.length),
      );
      const fix = args.slice(3).join(',').trim();
      const line = text.slice(0, m.index).split('\n').length;
      if (args.length < 4)
        failures.push(`${file}:${line} — no fix argument at all`);
      else if (!carriesFix(fix))
        failures.push(
          `${file}:${line} — fix is not actionable: ${fix.slice(0, 80)}`,
        );
    }
  }
  assert.equal(
    count,
    53,
    `raise sites moved: core/module.ts 37, core/app.ts 6, cli/lib/module.ts 7, cli/commands/service.ts 3. Re-count and set the new number here.`,
  );
  assert.deepEqual(failures, [], `fixless refusals:\n${failures.join('\n')}`);
});

// The floor this replaced counted raise sites and the allowlist removed them from scrutiny, and the
// two numbers were not connected: `count >= 7` against exactly seven sites, three of which the
// allowlist waved through, so four were audited and no number said so. An allowlist entry has to
// move a number here.
test('every literal CLI refusal on the error stream carries the fix or a stated allowlist reason', () => {
  const failures: string[] = [];
  const waved = new Set<string>();
  let count = 0;
  let audited = 0;
  for (const { file, text } of sourceFiles()) {
    if (!file.startsWith(CLI)) continue;
    // Refusals write to the injected error stream; console.error stays in the walk so a
    // hard-coded one cannot slip back in unaudited.
    for (const m of text.matchAll(/(?:console\.error|err\.write)\(/g)) {
      const body = callText(text, m.index + m[0].length - 1).trim();
      // Computed messages — a call, or a template opening on its interpolation — are
      // audited at their raise site.
      if (!/^['"`]/.test(body) || body.startsWith('`${')) continue;
      count += 1;
      const line = text.slice(0, m.index).split('\n').length;
      const literal = body.slice(1);
      const key = allowedBy(file, literal);
      if (key !== null) {
        waved.add(key);
        continue;
      }
      audited += 1;
      if (!/—|:/.test(literal) || !ACTIONABLE.test(literal)) {
        failures.push(
          `${file}:${line} — refusal without a fix: ${literal.slice(0, 80)}`,
        );
      }
    }
  }
  assert.deepEqual(failures, [], `fixless refusals:\n${failures.join('\n')}`);
  assert.equal(
    count,
    7,
    `literal refusals moved: cli.ts 1, commands/service.ts 6. Re-count and set the new number here.`,
  );
  assert.deepEqual(
    [...waved].sort(),
    Object.keys(ALLOWLIST).sort(),
    'an allowlist key that matches no site removes nothing and hides that it removed nothing',
  );
  assert.equal(
    audited,
    count - waved.size,
    'every site is either audited or waved through by a key stated above',
  );
  assert.equal(audited, 4, `audited ${audited} of ${count} literal refusals`);
});
