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

// Compiles every fenced `ts` sample in the docs content against the real package surface, so a
// prose sample cannot import a symbol the entry points do not export. Each sample becomes a
// module in .build-tmp/samples/ with `declare`d stand-ins for its free identifiers; import and
// member errors stay hard failures and map back to the .mdx line.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..');
const CONTENT = join(ROOT, 'apps/docs/app/content');
const OUT = join(ROOT, '.build-tmp/samples');

// Samples exempted by content match; each entry names the change that deletes it.
const SKIPS = [];

function mdxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdx'))
    .map((entry) => join(entry.parentPath, entry.name));
}

// One record per fenced `ts` block: where it lives and the lines inside the fence.
function extractSamples(path) {
  const samples = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    if (open === null) {
      if (lines[i].trim() === '```ts') open = { start: i + 2, body: [] };
    } else if (lines[i].trim() === '```') {
      samples.push({ file: relative(CONTENT, path), ...open });
      open = null;
    } else {
      open.body.push(lines[i]);
    }
  }
  return samples;
}

// The published specifier map, derived from the manifest so it can never drift: each entry
// point's `types` path names the source file that backs it.
function packagePaths() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const paths = {};
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (typeof value === 'string' || !value.types) continue;
    const source = value.types
      .replace('./dist/', './')
      .replace(/\.d\.ts$/, '.ts');
    paths[manifest.name + key.slice(1)] = [source];
  }
  return paths;
}

const options = {
  strict: true,
  // Prose samples may leave a callback parameter untyped; imports stay strict.
  noImplicitAny: false,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  lib: ['lib.esnext.d.ts'],
  types: ['node'],
  baseUrl: ROOT,
  paths: packagePaths(),
};

const FREE_NAME =
  /(?:Cannot find (?:name|namespace)|shorthand property) '([^']+)'/;
const FREE_CODES = new Set([2304, 2503, 2552, 18004]);

function diagnose(files) {
  const program = ts.createProgram(files, options);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && files.includes(d.file.fileName));
}

const samples = mdxFiles(CONTENT).flatMap(extractSamples);
const skipped = [];
const active = samples.filter((sample) => {
  const body = sample.body.join('\n');
  const skip = SKIPS.find(
    (s) => s.file === sample.file && body.includes(s.contains),
  );
  if (skip) skipped.push({ sample, reason: skip.reason });
  return !skip;
});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const files = active.map((sample, index) => {
  const path = join(OUT, `sample-${String(index).padStart(3, '0')}.ts`);
  writeFileSync(
    path,
    [
      `// ${sample.file}:${sample.start}`,
      ...sample.body,
      'export {};',
      '',
    ].join('\n'),
  );
  return path;
});

// Free identifiers are the sample's surrounding prose (an economy in scope, a request in hand).
// Declare each as both a value and a type, then let everything else stand as a real error.
for (let pass = 0; pass < 5; pass++) {
  const declared = new Map();
  for (const d of diagnose(files)) {
    if (!FREE_CODES.has(d.code)) continue;
    const name = ts
      .flattenDiagnosticMessageText(d.messageText, ' ')
      .match(FREE_NAME)?.[1];
    if (!name) continue;
    const names = declared.get(d.file.fileName) ?? new Set();
    names.add(name);
    declared.set(d.file.fileName, names);
  }
  if (declared.size === 0) break;
  for (const [file, names] of declared) {
    const stanzas = [...names].map(
      (name) => `declare const ${name}: any;\ntype ${name} = any;`,
    );
    writeFileSync(file, readFileSync(file, 'utf8') + stanzas.join('\n') + '\n');
  }
}

const failures = diagnose(files);
for (const d of failures) {
  const source = readFileSync(d.file.fileName, 'utf8').split('\n')[0].slice(3);
  const [file, start] = source.split(':');
  const line = d.file.getLineAndCharacterOfPosition(d.start).line;
  const at = line === 0 ? start : Number(start) + line - 1;
  const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  console.error(`apps/docs/app/content/${file}:${at}  TS${d.code} ${text}`);
}
for (const { sample, reason } of skipped) {
  console.log(`check-samples: skip ${sample.file}:${sample.start} (${reason})`);
}
if (failures.length > 0) {
  console.error(
    `check-samples: ${failures.length} error(s) across ${active.length} samples`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `check-samples: ${active.length} samples compiled clean, ${skipped.length} skipped`,
  );
}
