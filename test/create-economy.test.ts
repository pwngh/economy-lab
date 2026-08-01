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
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import '#test/support/dist-guard.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE = join(ROOT, 'packages', 'create-economy');
const BIN = join(PACKAGE, 'dist', 'bin.js');
const OPTIONS = join(PACKAGE, 'dist', 'lib', 'options.js');

interface Table {
  combinations(): readonly Readonly<Record<string, string>>[];
  templateDir(selection: Readonly<Record<string, string>>): string | null;
  QUESTIONS: readonly {
    id: string;
    flag: string;
    fallback: string;
    choices: readonly { value: string }[];
  }[];
}

test('the scaffolder is built', () => {
  assert.ok(
    existsSync(BIN),
    'packages/create-economy/dist/bin.js — run `npm run build:packages`',
  );
  assert.ok(existsSync(OPTIONS), 'packages/create-economy/dist/lib/options.js');
});

const table = (await import(pathToFileURL(OPTIONS).href)) as unknown as Table;

// spawnSync waits forever by default, and it blocks the event loop while it does, so a scaffolder
// that stopped exiting — a prompt asking a question nobody is there to answer is how that happens —
// would wedge the run rather than fail it. A run copies a template and returns in milliseconds.
const SCAFFOLD_BOUND_MS = 60_000;

/** One scaffolder run, in a throwaway directory. */
function create(args: string[], cwd: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: SCAFFOLD_BOUND_MS,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'economy-scaffold-'));
}

// The table is the menu, and the walk gate enumerates it. A row naming a template the tarball
// does not carry would offer a project nobody can scaffold.
test('every row in the option table names a template that is on disk', () => {
  const rows = table.combinations();
  assert.ok(rows.length > 0, 'the table offers at least one combination');
  for (const row of rows) {
    const dir = table.templateDir(row);
    assert.ok(dir, `${JSON.stringify(row)} names no template directory`);
    for (const required of [
      'package.json',
      'tsconfig.json',
      'economy.app.ts',
      'README.md',
      'Dockerfile',
      '_dockerignore',
      '_gitignore',
      '_env.example',
    ]) {
      assert.ok(
        existsSync(join(dir!, required)),
        `${row.template}: missing ${required}`,
      );
    }
  }
});

// npm drops a file named .gitignore from the tarball it publishes, so a template that stores
// one under its real name ships a project with no .gitignore and nothing says so.
test('no template ships a literal dotfile', () => {
  const root = join(PACKAGE, 'templates');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      assert.equal(
        entry.name.startsWith('.'),
        false,
        `${join(dir, entry.name)} is a dotfile — store it as _${entry.name.slice(1)}`,
      );
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(root);
});

// The umbrella is the install everyone is told to make. A template that reached past it for one
// of the individual packages would teach the shape we do not want.
test('every template depends on the umbrella and nothing else', () => {
  for (const row of table.combinations()) {
    const json = JSON.parse(
      readFileSync(join(table.templateDir(row)!, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.deepEqual(
      Object.keys(json.dependencies),
      ['@pwngh/economy'],
      `${row.template}: dependencies must be the umbrella alone`,
    );
  }
});

test('every economy command a template script runs is a verb the bin dispatches', async () => {
  const { VERBS } =
    (await import('../packages/cli/dist/lib/parse-args.js')) as {
      VERBS: string[];
    };
  assert.ok(VERBS.length > 0, 'the verb roster loaded');
  for (const row of table.combinations()) {
    const { scripts } = JSON.parse(
      readFileSync(join(table.templateDir(row)!, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const [name, line] of Object.entries(scripts)) {
      for (const m of line.matchAll(/\beconomy ([a-z-]+)/g)) {
        assert.ok(
          VERBS.includes(m[1]!),
          `${row.template}: script "${name}" runs \`economy ${m[1]}\` (roster: ${VERBS.join(' ')})`,
        );
      }
    }
  }
});

// The image is the one artifact nobody reads before running it. Each of these is a way a
// container looks healthy and is not: a shell-form command never sees SIGTERM, and a probe
// that shells out to curl fails on node:slim, which ships neither curl nor wget.
test('every template Dockerfile drains, probes, and runs in production posture', () => {
  for (const row of table.combinations()) {
    const source = readFileSync(
      join(table.templateDir(row)!, 'Dockerfile'),
      'utf8',
    );
    // Instructions only: a comment may name curl to say the image has none.
    const file = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const where = `${row.template}: Dockerfile`;

    assert.match(file, /^FROM node:22-slim/m, `${where} pins a node 22 base`);
    assert.match(
      file,
      /^ENV NODE_ENV=production$/m,
      `${where} sets the production posture`,
    );
    assert.match(
      file,
      /^CMD \[/m,
      `${where} CMD must be exec form, or the app is not PID 1`,
    );
    assert.match(
      file,
      /HEALTHCHECK[\s\S]*?CMD \[/,
      `${where} HEALTHCHECK must be exec form`,
    );
    assert.match(
      file,
      /\/readyz/,
      `${where} probes /readyz, not just the socket`,
    );
    assert.equal(
      /\b(curl|wget)\b/.test(file),
      false,
      `${where} node:slim has no curl or wget`,
    );

    // The image runs what `npm run build` emitted, so the compile has to happen in it.
    assert.match(file, /npm run build/, `${where} builds the module it serves`);
    assert.match(
      file,
      /npm ci --omit=dev/,
      `${where} ships production dependencies only`,
    );

    // The template ships no lockfile — the reader's first `npm install` writes one — so a COPY
    // naming `package-lock.json` outright fails the build of a fresh scaffold. A context copy
    // globs it; the runtime stage may take the one the build stage resolved.
    assert.equal(
      /^COPY (?!--from=)[^\n]*package-lock\.json(?!\*)/m.test(file),
      false,
      `${where} COPY names a lockfile the template does not ship — glob it (package-lock.json*) or take it --from=build`,
    );

    const ignore = readFileSync(
      join(table.templateDir(row)!, '_dockerignore'),
      'utf8',
    );
    for (const excluded of ['node_modules', '.env']) {
      assert.match(
        ignore,
        new RegExp(`^${excluded.replace('.', '\\.')}$`, 'm'),
        `${row.template}: .dockerignore must exclude ${excluded}`,
      );
    }
  }
});

// A placeholder secret is worse than a blank one: it gets copied to .env and looks set, and
// preflight then refuses on a value nobody meant to use.
test('no template example environment carries a secret value', () => {
  const SECRET =
    /^([A-Z0-9_]*(SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL))\s*=\s*(.+)$/;
  for (const row of table.combinations()) {
    const file = readFileSync(
      join(table.templateDir(row)!, '_env.example'),
      'utf8',
    );
    for (const line of file.split('\n')) {
      const m = SECRET.exec(line.trim());
      assert.equal(
        m,
        null,
        `${row.template}: .env.example gives ${m?.[1]} the value ${m?.[3]}`,
      );
    }
  }
});

// The framework never imports a database driver from a URL scheme; the host module states the
// store, and `DATABASE_URL` only names the engine it meant. So a template inviting the variable
// while its module opens no store must say where the wiring goes, or the reader's first
// production deploy meets a refusal the scaffold set up.
test('the DATABASE_URL the example invites is documented as module wiring', () => {
  let examined = 0;
  for (const row of table.combinations()) {
    const dir = table.templateDir(row)!;
    const env = readFileSync(join(dir, '_env.example'), 'utf8');
    assert.match(
      env,
      /^DATABASE_URL=$/m,
      `${row.template}: .env.example lost its DATABASE_URL line`,
    );
    assert.match(
      env,
      /^#[^\n]*economy\.app\.ts[^\n]*\nDATABASE_URL=$/m,
      `${row.template}: the line above DATABASE_URL must say the store is wiring in economy.app.ts`,
    );

    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    assert.match(
      readme,
      /^export const ports = \{$/m,
      `${row.template}: the README never shows the ports export the store needs`,
    );
    assert.match(
      readme,
      /store: await postgres\(process\.env\.DATABASE_URL\)/,
      `${row.template}: the README never wires DATABASE_URL to a store`,
    );
    assert.match(
      readme,
      /@pwngh\/economy\/postgres/,
      `${row.template}: the store import must come through the umbrella door`,
    );
    assert.match(
      readme,
      /@pwngh\/economy\/mysql/,
      `${row.template}: the mysql door is the other half of the choice`,
    );
    examined += 1;
  }
  assert.equal(examined, 2, 'both templates were examined');
});

test('--list names every value the table offers', () => {
  const dir = scratch();
  try {
    const listed = create(['--list'], dir);
    assert.equal(listed.code, 0);
    for (const q of table.QUESTIONS) {
      for (const c of q.choices) {
        assert.match(
          listed.out,
          new RegExp(`\\b${c.value}\\b`),
          `--list omits ${c.value}`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--version answers the version the package declares', () => {
  const dir = scratch();
  try {
    const { version } = JSON.parse(
      readFileSync(join(PACKAGE, 'package.json'), 'utf8'),
    ) as {
      version: string;
    };
    const answered = create(['--version'], dir);
    assert.equal(answered.code, 0);
    assert.match(answered.out, new RegExp(version.replace(/\./g, '\\.')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad flag, a bad answer, and a missing directory each refuse by name', () => {
  const dir = scratch();
  try {
    const unknownFlag = create(['shop', '--turbo'], dir);
    assert.equal(unknownFlag.code, 2);
    assert.match(unknownFlag.out, /--turbo is not a flag/);

    const unknownTemplate = create(['shop', '--template', 'nope'], dir);
    assert.equal(unknownTemplate.code, 2);
    assert.match(unknownTemplate.out, /"nope" is not a template/);

    const noValue = create(['shop', '--template'], dir);
    assert.equal(noValue.code, 2);
    assert.match(noValue.out, /--template needs a value/);

    const twoDirs = create(['shop', 'store', '--yes'], dir);
    assert.equal(twoDirs.code, 2);
    assert.match(twoDirs.out, /one directory at a time/);

    // No answer is possible without a terminal, so the run refuses instead of guessing.
    const noDirectory = create([], dir);
    assert.equal(noDirectory.code, 2);
    assert.match(noDirectory.out, /needs a directory/);

    assert.deepEqual(readdirSync(dir), [], 'a refused run writes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The templates on offer. The content tests above iterate the option table; the write-behaviour
 * tests below took the `starter` fallback and proved the writes for one template of two, so a
 * marketplace file whose name broke `targetPath` was invisible to all of them.
 */
const WRITTEN_TEMPLATES = ['starter', 'marketplace'];

test('the write-behaviour tests below cover every template on offer', () => {
  const offered = [
    ...new Set(table.combinations().map((selection) => selection.template)),
  ].sort();
  assert.deepEqual(
    offered,
    [...WRITTEN_TEMPLATES].sort(),
    'a template added to the table is written by these tests too',
  );
});

// The refusal has to come before the first write, or a mistyped directory leaves a project
// half-overwritten with no way to tell which files are the reader's.
for (const template of WRITTEN_TEMPLATES) {
  test(`an occupied directory is refused whole, and --force takes it (${template})`, () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'shop.txt'), 'mine');
      const refused = create(['.', '--yes', '--template', template], dir);
      assert.equal(refused.code, 1);
      assert.match(refused.out, /already holds 1 entry/);
      assert.deepEqual(
        readdirSync(dir),
        ['shop.txt'],
        'nothing was written past the refusal',
      );

      const forced = create(
        ['.', '--yes', '--force', '--template', template],
        dir,
      );
      assert.equal(forced.code, 0);
      assert.ok(
        existsSync(join(dir, 'economy.app.ts')),
        '--force wrote the template',
      );
      assert.ok(
        existsSync(join(dir, 'shop.txt')),
        '--force leaves what was already there',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`the scaffolder folds a directory name npm would refuse into a legal package name (${template})`, () => {
    const dir = scratch();
    try {
      assert.equal(
        create(['My Shop!', '--yes', '--template', template], dir).code,
        0,
      );
      const json = JSON.parse(
        readFileSync(join(dir, 'My Shop!', 'package.json'), 'utf8'),
      ) as {
        name: string;
      };
      assert.equal(json.name, 'my-shop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The name travels as a textual token, and the token has an enemy in the toolchain: Prettier
  // rewrites `__X__` to `**X**` in markdown, which is how every scaffolded README came to open
  // with a bold PROJECT_NAME nobody substituted. The rendered output is what is asserted, against
  // literals — a gate re-running the same substitution would agree with any token.
  test(`a scaffolded project carries its own name, and no file keeps the token (${template})`, () => {
    const dir = scratch();
    try {
      assert.equal(
        create(['shop', '--yes', '--template', template], dir).code,
        0,
      );
      const project = join(dir, 'shop');

      const readme = readFileSync(join(project, 'README.md'), 'utf8');
      assert.equal(
        readme.split('\n')[0],
        '# shop',
        'the README opens with the project name as its title',
      );
      assert.match(
        readme,
        /^docker build -t shop \.$/m,
        'the docker quickstart names the image after the project',
      );
      const { name } = JSON.parse(
        readFileSync(join(project, 'package.json'), 'utf8'),
      ) as { name: string };
      assert.equal(name, 'shop', 'the package is named after the project');

      // Every written file, not the ones known to carry the token: a leftover anywhere is a
      // template whose substitution silently stopped matching.
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const path = join(d, entry.name);
          if (entry.isDirectory()) walk(path);
          else files.push(path);
        }
      };
      walk(project);
      assert.equal(
        files.length,
        9,
        `the sweep saw ${files.length} files where the template ships 9`,
      );
      for (const file of files) {
        assert.doesNotMatch(
          readFileSync(file, 'utf8'),
          /PROJECT_NAME/,
          `${relative(project, file)} still carries the template token`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a scaffolded project carries its dotfiles with the dots put back (${template})`, () => {
    const dir = scratch();
    try {
      assert.equal(
        create(['shop', '--yes', '--template', template], dir).code,
        0,
      );
      const written = readdirSync(join(dir, 'shop')).sort();
      assert.ok(
        written.includes('.gitignore'),
        `_gitignore was not renamed: ${written.join(' ')}`,
      );
      assert.ok(
        written.includes('.env.example'),
        `_env.example was not renamed: ${written.join(' ')}`,
      );
      assert.equal(
        written.includes('_gitignore'),
        false,
        'the underscore form must not survive',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
