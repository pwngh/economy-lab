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
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE = fileURLToPath(new URL('../apps/console', import.meta.url));

/** Generated or vendored trees hold no authored import; reading them would count noise as work. */
const SKIP_DIRS = new Set(['node_modules', '.react-router', 'build', 'public']);

const SOURCE = /\.(ts|tsx)$/;

/**
 * The assembly verbs an app must not call. `boot`, `openPorts` and `memoryPorts` assemble the
 * ports bag; `createEconomy`, `createServer`, `createWorker` and `handleWebhook` assemble the
 * halves an app is supposed to receive already built.
 */
const ASSEMBLY_VERBS = [
  'boot',
  'openPorts',
  'memoryPorts',
  'createEconomy',
  'createServer',
  'createWorker',
  'handleWebhook',
] as const;

/** Only the umbrella's doors. `@pwngh/economy-core` is a door's destination, not a door. */
const ALLOWED_SPECIFIER = /^@pwngh\/economy\/[a-z0-9/-]+$/;
const OURS = /^(#|@pwngh\/economy)/;

/**
 * The one exemption, and the reason it is one file rather than a pattern. Everything the console
 * needs that no door carries lives here, so the debt is countable and cannot spread: 40 symbols.
 * The roster below is pinned exactly, so a symbol cannot join it without this gate failing.
 *
 * `MemoryLedger` is the one entry here that made the file smaller: the console declared the shape
 * by hand before, and reached it through `as unknown as`.
 *
 * It may reach the lab's PUBLIC subpaths only — never `#src/*`. The console reached raw source
 * before this migration; the escape hatch that replaced it does not.
 */
const QUARANTINE = 'app/lab-gap.ts';
const QUARANTINE_ALLOWED = /^@pwngh\/economy-lab(\/[a-z-]+)?$/;
const QUARANTINE_EXPORTS = 40;

const sources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (SOURCE.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(CONSOLE);
  return out.sort();
};

const endOfLine = (src: string, from: number): number => {
  let i = from;
  while (i < src.length && src[i] !== '\n') i += 1;
  return i;
};

const endOfBlock = (src: string, from: number): number => {
  let i = from + 2;
  while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
  return i + 2;
};

/** From the opening quote to just past the closing one, with the body kept or dropped. */
function readString(
  src: string,
  from: number,
  keepBody: boolean,
): { text: string; next: number } {
  const quote = src[from];
  let body = '';
  let i = from + 1;
  while (i < src.length && src[i] !== quote) {
    const escaped = src[i] === '\\';
    if (keepBody) body += escaped ? src.slice(i, i + 2) : src[i];
    i += escaped ? 2 : 1;
  }
  return { text: quote + body + quote, next: i + 1 };
}

/**
 * Blanks comments, and optionally string bodies too. Written as a state walk rather than a regex
 * because `'https://x'` carries a `//` that a comment regex reads as the start of a comment.
 *
 * The two callers want different things and conflating them is a hole: specifiers live *inside*
 * strings, so a string-blanked source resolves no imports at all. Identifiers are the mirror
 * case: they must be matched with strings gone, or a sentence naming a verb reads as code
 * calling it.
 */
function strip(src: string, alsoStrings: boolean): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      i = endOfLine(src, i);
    } else if (two === '/*') {
      i = endOfBlock(src, i);
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const read = readString(src, i, !alsoStrings);
      out += read.text;
      i = read.next;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

/** Comments gone, strings intact — module specifiers survive. */
const importable = (src: string): string => strip(src, false);

/** Comments and string bodies gone — an identifier match means the code names the thing. */
const codeOnly = (src: string): string => strip(src, true);

/** Every module specifier the file names, from static imports, re-exports and dynamic import(). */
function specifiers(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) out.push(match[1]);
  }
  return out;
}

/**
 * The floor tracks reality rather than being set once: a bug that stopped the walk after one
 * directory would satisfy every assertion below on an empty set. Raise it when the console grows.
 */
const MIN_FILES = 60;

test('the console reaches this tree only through the umbrella doors', () => {
  const files = sources();
  let examined = 0;
  let resolved = 0;
  for (const file of files) {
    const where = relative(CONSOLE, file);
    const src = readFileSync(file, 'utf8');
    examined += 1;
    const quarantined = where === QUARANTINE;
    for (const specifier of specifiers(importable(src))) {
      if (!OURS.test(specifier)) continue;
      resolved += 1;
      if (quarantined) {
        assert.ok(
          QUARANTINE_ALLOWED.test(specifier),
          `${where} imports "${specifier}" — the quarantine may reach the lab's public subpaths, never #src/*`,
        );
        continue;
      }
      assert.ok(
        ALLOWED_SPECIFIER.test(specifier),
        `${where} imports "${specifier}" — the console may only import @pwngh/economy/<door>, or add it to ${QUARANTINE} with a GAP entry`,
      );
    }
  }
  assert.ok(
    examined >= MIN_FILES,
    `read ${examined} console sources, expected at least ${MIN_FILES}`,
  );
  assert.ok(
    resolved > 0,
    `read ${examined} sources and found no import from this tree at all — the walk is broken, or the console no longer uses the economy`,
  );
});

// An exemption nobody counts stops being an exemption and becomes the new front door. This is the
// odometer on the debt: it only moves when someone changes the number here and says why.
test('the quarantine is one file, and exactly as large as the register says', () => {
  const file = join(CONSOLE, QUARANTINE);
  const src = importable(readFileSync(file, 'utf8'));

  const reachers = sources().filter((f) => {
    const where = relative(CONSOLE, f);
    if (where === QUARANTINE) return false;
    return specifiers(importable(readFileSync(f, 'utf8'))).some((s) =>
      s.startsWith('@pwngh/economy-lab'),
    );
  });
  assert.deepEqual(
    reachers.map((f) => relative(CONSOLE, f)),
    [],
    'only the quarantine may reach the lab directly',
  );

  const exported = [...src.matchAll(/^export (?:type )?\{([^}]*)\}/gm)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(
    exported.length,
    QUARANTINE_EXPORTS,
    `${QUARANTINE} re-exports ${exported.length} symbols, pinned at ${QUARANTINE_EXPORTS} — a symbol joining or leaving this roster is a door decision, not a pin update`,
  );
});

test('the console names none of the seven assembly verbs', () => {
  const files = sources();
  let examined = 0;
  for (const file of files) {
    const where = relative(CONSOLE, file);
    const code = codeOnly(readFileSync(file, 'utf8'));
    examined += 1;
    for (const verb of ASSEMBLY_VERBS) {
      const hit = new RegExp(`\\b${verb}\\b`).test(code);
      assert.ok(
        !hit,
        `${where} names the assembly verb "${verb}" — it is the escape hatch, and reaching it makes the console prove nothing about the shipped surface`,
      );
    }
  }
  assert.ok(
    examined >= MIN_FILES,
    `read ${examined} console sources, expected at least ${MIN_FILES}`,
  );
});
