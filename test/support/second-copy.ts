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
 * Installs a real second copy of a module: a package written under its own `node_modules`
 * tree, compiled from the source file it names and resolved through package exports the way
 * any duplicated install is. The copy's classes are different objects built from identical
 * source, which is exactly the situation a brand has to survive.
 *
 * TWO TREES READ THIS FILE: the lab's own rig, and `packages/core`, which reaches it by
 * relative path. It therefore imports `node:` builtins and the root `typescript` — the
 * compiler both rigs already load — and never the lab: the second copy this file builds is
 * quarantined in a temp directory, while a lab-source import here would smuggle one into
 * the importing process itself.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

export interface SecondCopyOptions {
  /** The name the copy is installed and resolved under, e.g. `@pwngh/economy-core`. */
  packageName: string;
  /** Absolute path of the TypeScript source compiled into the copy's one module. */
  sourcePath: string;
}

export interface SecondCopy {
  /** The directory holding the install; the caller removes it. */
  readonly dir: string;
  /** A module whose `export *` resolves through the copy's exports map. */
  readonly consumer: string;
  /** SHA-256 of the source text the copy was compiled from. */
  readonly sha: string;
}

export function installSecondCopy(options: SecondCopyOptions): SecondCopy {
  const { packageName, sourcePath } = options;
  const dir = mkdtempSync(
    join(tmpdir(), `${packageName.split('/').pop()!}-two-copy-`),
  );
  const pkg = join(dir, 'node_modules', ...packageName.split('/'));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(pkg, 'package.json'),
    `{"name":"${packageName}","version":"0.0.0-copy",` +
      '"type":"module","exports":{".":"./errors.js"}}',
  );
  // Node refuses to strip types under node_modules, so the copy ships compiled.
  const source = readFileSync(sourcePath, 'utf8');
  writeFileSync(
    join(pkg, 'errors.js'),
    transpileModule(source, {
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
        useDefineForClassFields: true,
        verbatimModuleSyntax: true,
      },
    }).outputText,
  );
  // Double quotes: the roster gate reads single-quoted `from` clauses as imports, and the
  // consumer text this writes is a fixture, not an import of this file's.
  writeFileSync(join(dir, 'consumer.js'), `export * from "${packageName}";\n`);
  return {
    dir,
    consumer: join(dir, 'consumer.js'),
    sha: createHash('sha256').update(source).digest('hex'),
  };
}
