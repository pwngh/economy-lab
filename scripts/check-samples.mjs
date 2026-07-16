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
const SNIPPETS = join(ROOT, 'apps/docs/app/snippets');
const OUT = join(ROOT, '.build-tmp/samples');

// A fence marked `nocopy` is deliberately wrong code; the meta token is also the skip flag here,
// so intentional breakage is visible on the page and exempt from the gate in one gesture. The
// grammar is shared with apps/docs/vite.config.ts (parseFenceMeta) — change the two together.
const NOCOPY = /\bnocopy\b/;

// Fewer extracted samples than this means the extractor stopped matching fences (a meta-grammar
// change, most likely), not that the docs shrank. Raise it as samples are added; lower it only
// when a fence deliberately becomes a Runnable block.
const FLOOR = 72;

function mdxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdx'))
    .map((entry) => join(entry.parentPath, entry.name));
}

// One record per fenced `ts` block, meta-tagged or bare: where it lives, its fence meta, and the
// lines inside the fence.
function extractSamples(path) {
  const samples = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    if (open === null) {
      const fence = lines[i].trim().match(/^```ts(?:\s+(\S.*))?$/);
      if (fence) open = { start: i + 2, meta: fence[1] ?? '', body: [] };
    } else if (lines[i].trim() === '```') {
      samples.push({ file: relative(CONTENT, path), ...open });
      open = null;
    } else {
      open.body.push(lines[i]);
    }
  }
  return samples;
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// The published specifier map, derived from the manifest so it can never drift: each entry
// point's `types` path names the source file that backs it.
function packagePaths() {
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

// The recurring prose names carry their real published types, so a fence that drives `economy`
// or `worker` wrong fails the gate instead of compiling against `any`. Names outside the map
// still fall back to `any`.
const KNOWN = new Map([
  ['economy', 'Economy'],
  ['worker', 'Worker'],
  ['store', 'Store'],
  ['outcome', 'Outcome'],
  ['saga', 'Saga'],
  ['request', 'Operation'],
]);

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
if (samples.length < FLOOR) {
  throw new Error(
    `check-samples: only ${samples.length} samples extracted (floor ${FLOOR}) — the extractor has stopped matching fences`,
  );
}
const skipped = [];
const active = samples.filter((sample) => {
  if (NOCOPY.test(sample.meta)) {
    skipped.push({ sample, reason: 'nocopy' });
    return false;
  }
  return true;
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
    const stanzas = [...names].map((name) => {
      const type = KNOWN.has(name)
        ? `import('${manifest.name}').${KNOWN.get(name)}`
        : 'any';
      return `declare const ${name}: ${type};\ntype ${name} = ${type};`;
    });
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

// Second pass: the snippet files behind the Runnable blocks, compiled whole with the same
// entry-point map and nothing else in scope — a snippet can't quietly lean on `#src/` internals
// or the console facade.
const snippetFiles = readdirSync(SNIPPETS)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join(SNIPPETS, name));
const snippetFailures = diagnose(snippetFiles);
for (const d of snippetFailures) {
  const line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
  const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  console.error(
    `${relative(ROOT, d.file.fileName)}:${line}  TS${d.code} ${text}`,
  );
}
if (snippetFailures.length > 0) {
  console.error(
    `check-samples: ${snippetFailures.length} error(s) across ${snippetFiles.length} snippet files`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `check-samples: ${snippetFiles.length} snippet files compiled clean against the entry points`,
  );
}
