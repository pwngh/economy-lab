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

// Holds the docs' code to two standards at once, because there are two kinds of it.
//
// A fenced `ts` sample in the prose is COMPILED against the real package surface, so a sample
// cannot import a symbol the entry points do not export. Each becomes a module in
// .build-tmp/samples/ with `declare`d stand-ins for its free identifiers; import and member errors
// stay hard failures and map back to the .mdx line.
//
// A snippet behind a `<Runnable>` block is EXECUTED — by `apps/docs`' own snippet suite, against a
// real engine — and this gate holds that suite to the whole roster. Both counts are exact, which is
// the point: a fence promoted to a Runnable block moves one out of the compiled set and into the
// executed set, and a promotion that stopped at "it still compiles" fails here rather than shipping
// a Run button nothing has ever pressed.
//
// Exact, not floors. A floor is satisfied by a sweep that has stopped matching most of what it
// used to.

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
const SNIPPET_SUITE = join(ROOT, 'apps/docs/runner/snippets.test.ts');
const OUT = join(ROOT, '.build-tmp/samples');

// A fence marked `nocopy` is deliberately wrong code. The meta token is also the skip flag
// here, so intentional breakage is visible on the page and exempt from the gate in one gesture. The
// grammar is shared with apps/docs/vite.config.ts (parseFenceMeta) — change the two together.
// A fence that is not valid TypeScript on its own is marked with it rather than left for the
// compiler to trip over, which is why this count is pinned as tightly as the others.
const NOCOPY = /\bnocopy\b/;

// The three exact counts of the compiled set, edited deliberately when the docs change. A sample
// count that fell would mean the extractor stopped matching fences (a meta-grammar change, most
// likely), not that the docs shrank.
const EXPECTED = { fences: 106, nocopy: 1, compiled: 105 };

function mdxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdx'))
    .map((entry) => join(entry.parentPath, entry.name));
}

// Each fenced `ts` block, meta-tagged or bare, yields one record. The record holds where the
// block lives, its fence meta, and the lines inside the fence.
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

// This derives the published specifier map from the manifest so it can never drift. Each entry
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
  // Prose samples may leave a callback parameter untyped. Imports stay strict.
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
  if (NOCOPY.test(sample.meta)) {
    skipped.push({ sample, reason: 'nocopy' });
    return false;
  }
  return true;
});

const counted = {
  fences: samples.length,
  nocopy: skipped.length,
  compiled: active.length,
};
for (const [what, expected] of Object.entries(EXPECTED)) {
  if (counted[what] !== expected) {
    throw new Error(
      `check-samples: ${counted[what]} ${what}, and this gate declares ${expected} — edit EXPECTED to the new count, deliberately`,
    );
  }
}

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

// The second pass compiles the snippet files behind the Runnable blocks. It compiles them
// whole with the same entry-point map and nothing else in scope, so a snippet can't quietly
// lean on `#src/` internals or the console facade.
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

// The third pass: compiling a snippet proves it type-checks, and a Runnable block claims more than
// that. Every snippet with a `run` export is driven for real by apps/docs' snippet suite, and this
// resolves that suite's own references back to the files on disk — so a snippet added and never
// driven fails here instead of shipping a Run button nobody has pressed.
const RUN_EXPORT = /^export\s+(?:async\s+)?function\s+run\b/m;
const suite = readFileSync(SNIPPET_SUITE, 'utf8');

const runnable = snippetFiles
  .filter((path) => RUN_EXPORT.test(readFileSync(path, 'utf8')))
  .map((path) => path.slice(SNIPPETS.length + 1, -'.ts'.length))
  .sort();

// Every `app/snippets/<stem>` the suite names, however it reaches it: a static import, a dynamic
// one, or a source read the sandbox executes.
const driven = [
  ...new Set(
    [...suite.matchAll(/app\/snippets\/([\w.-]+?)(?:\.ts)?['"]/g)].map(
      (found) => found[1],
    ),
  ),
].sort();

const undriven = runnable.filter((stem) => !driven.includes(stem));
const unresolved = driven.filter(
  (stem) => !snippetFiles.includes(join(SNIPPETS, `${stem}.ts`)),
);

// The counts, exact on both sides. A roster that quietly emptied would satisfy every difference
// above it, and a snippet file that stopped exporting `run` would leave the executed set smaller
// than the page it backs.
const EXPECTED_SNIPPETS = { files: 23, runnable: 22 };

if (undriven.length > 0 || unresolved.length > 0) {
  for (const stem of undriven) {
    console.error(
      `apps/docs/app/snippets/${stem}.ts  exports run and apps/docs/runner/snippets.test.ts never drives it`,
    );
  }
  for (const stem of unresolved) {
    console.error(
      `apps/docs/runner/snippets.test.ts  names app/snippets/${stem}, which is not a snippet file`,
    );
  }
  process.exitCode = 1;
} else if (
  snippetFiles.length !== EXPECTED_SNIPPETS.files ||
  runnable.length !== EXPECTED_SNIPPETS.runnable
) {
  console.error(
    `check-samples: ${snippetFiles.length} snippet files of which ${runnable.length} runnable, and this gate declares ` +
      `${EXPECTED_SNIPPETS.files}/${EXPECTED_SNIPPETS.runnable} — edit EXPECTED_SNIPPETS to the new counts, deliberately`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `check-samples: ${runnable.length} of ${snippetFiles.length} snippet files export run, and all ${runnable.length} are executed by apps/docs' snippet suite`,
  );
}
