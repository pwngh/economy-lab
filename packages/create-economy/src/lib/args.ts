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

import { QUESTIONS, values } from './options.js';
import type { Selection } from './options.js';

export interface Args {
  /** The directory to write into, relative to the cwd; empty means ask. */
  readonly directory: string;
  /** Only the questions answered on the command line; the rest are asked or defaulted. */
  readonly answered: Selection;
  /** Take the fallback for every unanswered question instead of asking. */
  readonly yes: boolean;
  /** Write into a directory that already has files in it. */
  readonly force: boolean;
}

export type Parsed =
  | { readonly ok: true; readonly args: Args }
  | { readonly ok: false; readonly refusal: string }
  | { readonly ok: 'print'; readonly text: string };

const flagLine = (): string[] =>
  QUESTIONS.map(
    (q) =>
      `  ${`${q.flag} ${q.takes}`.padEnd(14)}one of: ${values(q.id).join(', ')} (default ${q.fallback})`,
  );

export const USAGE = [
  'usage: create-economy [directory] [flags]',
  ...flagLine(),
  '  --yes         take every default and ask nothing',
  '  --force       write into a directory that already has files',
  '  --list        print the choices and leave',
  '  help:         create-economy --help · create-economy --version',
].join('\n');

/** The choices, grouped by the question they answer. */
export const choiceTable = (): string =>
  QUESTIONS.flatMap((q) => [
    `${q.id}:`,
    ...q.choices.map((c) => `  ${c.value.padEnd(12)} ${c.describe}`),
  ]).join('\n');

const refuse = (refusal: string): Parsed => ({ ok: false, refusal });

/**
 * Refuses on an unknown flag, a question flag without a value or with an answer outside its
 * table, and a second positional. An absent directory means ask.
 */
// complexity 17: one argv walk, a named refusal per malformed flag.
// eslint-disable-next-line complexity
export function parse(argv: readonly string[], version: string): Parsed {
  let directory = '';
  let yes = false;
  let force = false;
  const answered: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--help' || token === '-h')
      return { ok: 'print', text: USAGE };
    if (token === '--version' || token === '-v') {
      return { ok: 'print', text: `create-economy ${version}` };
    }
    if (token === '--list') return { ok: 'print', text: choiceTable() };
    if (token === '--yes' || token === '-y') {
      yes = true;
      continue;
    }
    if (token === '--force' || token === '-f') {
      force = true;
      continue;
    }
    const q = QUESTIONS.find(
      (each) => each.flag === token || each.short === token,
    );
    if (q) {
      const value = argv[(i += 1)];
      if (value === undefined || value.startsWith('-')) {
        return refuse(
          `${q.flag} needs a value — one of: ${values(q.id).join(', ')}`,
        );
      }
      if (!values(q.id).includes(value)) {
        return refuse(
          `"${value}" is not a ${q.id} — one of: ${values(q.id).join(', ')}`,
        );
      }
      answered[q.id] = value;
      continue;
    }
    if (token.startsWith('-'))
      return refuse(`${token} is not a flag\n${USAGE}`);
    if (directory)
      return refuse(
        `one directory at a time — got "${directory}" and "${token}"`,
      );
    directory = token;
  }
  return { ok: true, args: { directory, answered, yes, force } };
}

// npm refuses uppercase, a leading dot or underscore, and anything outside the URL-safe set,
// so the directory the reader typed is folded rather than copied into package.json.
export function packageName(directory: string): string {
  const base =
    directory
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  const folded = base
    .toLowerCase()
    .replace(/[^a-z0-9-~._]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '')
    .slice(0, 214);
  return folded || 'economy-app';
}
