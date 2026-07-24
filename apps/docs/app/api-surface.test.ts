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

// The generated /api reference must cover the whole export surface: every exports-map subpath
// renders a module page, and every name an entry point exports renders a symbol page. This is
// what keeps typedoc.json's entryPoints from silently falling behind package.json, and the
// reference from silently dropping a symbol. Run `npm run docs:api` first if docs/ is absent.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const API_OUT = join(REPO_ROOT, 'docs');

// A subpath's module page is its source path with '/' → '_', minus the extension:
// './worker' → src/worker/index.ts → src_worker.html.
function modulePageOf(sourcePath: string): string {
  return sourcePath
    .replace(/^\.\/dist\//, '')
    .replace(/\.d\.ts$/, '')
    .replace(/\/index$/, '')
    .replace(/\//g, '_');
}

// The entry's source file for an exports-map types target: './dist/src/index.d.ts' → 'src/index.ts'.
function sourceFileOf(typesPath: string): string {
  return typesPath.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, '.ts');
}

type ExportsMap = Record<string, { types?: string } | string>;
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  exports: ExportsMap;
};
const entries = Object.values(pkg.exports).flatMap((target) =>
  typeof target === 'object' && target.types ? [target.types] : [],
);

// Every symbol page the reference rendered, by bare symbol name ('src_ports.Store' → 'Store').
const renderedSymbols = new Set(
  ['classes', 'functions', 'interfaces', 'types', 'variables'].flatMap((kind) => {
    const dir = join(API_OUT, kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.html'))
      .map((f) => f.slice(0, -5).split('.').pop() ?? '');
  }),
);

// Textual export parse — named re-export blocks plus direct declarations — so the library's
// sources stay out of this app's TypeScript program. None of the entry points uses `export *`.
function exportedNames(sourceFile: string): string[] {
  const text = readFileSync(join(REPO_ROOT, sourceFile), 'utf8');
  return [...text.matchAll(/^export (?:type )?\{([\s\S]*?)\}/gm)]
    .flatMap((block) => (block[1] ?? '').split(','))
    .map((name) => name.replace(/^\s*type\s+/, '').trim())
    .filter(Boolean)
    .map((name) => name.split(' as ').pop()?.trim() ?? name)
    .concat(
      [
        ...text.matchAll(
          /^export (?:async )?(?:function|const|class|type|interface) ([A-Za-z0-9_]+)/gm,
        ),
      ].flatMap((decl) => (decl[1] ? [decl[1]] : [])),
    );
}

describe('the generated reference covers every entry point', () => {
  test('the TypeDoc output exists', () => {
    expect(existsSync(join(API_OUT, 'index.html')), 'run npm run docs:api first').toBe(true);
  });

  for (const types of entries) {
    const modulePage = modulePageOf(types);
    test(`module page for ${types}`, () => {
      const page = join(API_OUT, 'modules', `${modulePage}.html`);
      expect(
        existsSync(page),
        `no module page ${modulePage}.html — entry point missing from typedoc.json?`,
      ).toBe(true);
    });
  }
});

describe('every export renders a symbol page', () => {
  for (const types of entries) {
    const sourceFile = sourceFileOf(types);
    test(`exports of ${sourceFile}`, () => {
      const names = exportedNames(sourceFile);
      expect(names.length).toBeGreaterThan(0);
      const missing = names.filter((name) => !renderedSymbols.has(name));
      expect(missing, 'exports with no rendered /api page').toEqual([]);
    });
  }
});
