/**
 * create-economy
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { packageName, parse, USAGE } from './args.js';
import { scaffold } from './scaffold.js';
import { choice, defaults, QUESTIONS, templateDir } from './options.js';
import type { Selection } from './options.js';
import {
  askDirectory,
  askQuestions,
  interactive,
  terminalAsker,
} from './prompt.js';
import type { Asker } from './prompt.js';

/** Where a run writes: the process streams, or whatever a host hands it. */
export interface Sink {
  write(text: string): unknown;
}

export interface RunOptions {
  readonly stdout?: Sink;
  readonly stderr?: Sink;
  /** The directory the project is written beside; defaults to the process cwd. */
  readonly cwd?: string;
  /** The terminal to question; absent means ask the real one, when there is one. */
  readonly asker?: Asker;
}

export function version(): string {
  const json = readFileSync(
    new URL('../../package.json', import.meta.url),
    'utf8',
  );
  return (JSON.parse(json) as { version: string }).version;
}

/** The closing note: what the reader runs next, in the order they will run it. */
function nextSteps(dir: string, selection: Selection): string {
  const chosen = QUESTIONS.map((q) => choice(q.id, selection[q.id]!)?.highlight)
    .filter((h): h is string => h !== undefined)
    .join('; ');
  return [
    `created ${dir} — ${chosen}`,
    '',
    `  cd ${dir}`,
    '  npm install',
    '  npm run check     # the module and the environment, compiled to one truth pass',
    '  npm run dev       # http://127.0.0.1:3000, memory store, dev tokens',
    '',
    '`npm run routes` prints what it mounts, `npm test` runs the arc on deterministic',
    'ports, and the Dockerfile builds the production image. README.md has the rest.',
  ].join('\n');
}

/** The answers, from the flags plus either the terminal or the table's fallbacks. */
async function resolveAnswers(
  directory: string,
  answered: Selection,
  asker: Asker | null,
): Promise<{ directory: string; selection: Selection }> {
  if (!asker) return { directory, selection: { ...defaults(), ...answered } };
  try {
    return {
      directory: directory || (await askDirectory(asker)),
      selection: await askQuestions(asker, answered),
    };
  } finally {
    asker.close();
  }
}

/**
 * Runs one invocation and resolves its exit code. Never calls `process.exit`, so a test can
 * drive it in-process; the bin is the only place that exits.
 */
// complexity 17: the scaffold sequence, branching per prompt answer and per refusal.
// eslint-disable-next-line complexity
export async function runCreateEconomy(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();

  const parsed = parse(argv, version());
  if (parsed.ok === 'print') {
    out.write(`${parsed.text}\n`);
    return 0;
  }
  if (!parsed.ok) {
    err.write(`${parsed.refusal}\n`);
    return 2;
  }
  const args = parsed.args;
  const open =
    !args.directory || QUESTIONS.some((q) => args.answered[q.id] === undefined);
  const asker =
    args.yes || !open
      ? null
      : (options.asker ?? (interactive() ? terminalAsker() : null));
  if (!asker && !args.directory) {
    err.write(
      `create-economy needs a directory when nothing can be asked\n${USAGE}\n`,
    );
    return 2;
  }
  const { directory, selection } = await resolveAnswers(
    args.directory,
    args.answered,
    asker,
  );

  const from = templateDir(selection);
  if (from === null) {
    err.write(
      `the ${selection.template} template is missing from this install` +
        ' — reinstall create-economy\n',
    );
    return 1;
  }
  const to = resolve(cwd, directory);
  const result = scaffold({
    from,
    to,
    packageName: packageName(directory),
    force: args.force,
  });
  if (!result.ok) {
    err.write(`${result.refusal}\n`);
    return 1;
  }
  out.write(`${nextSteps(relative(cwd, to) || '.', selection)}\n`);
  return 0;
}
