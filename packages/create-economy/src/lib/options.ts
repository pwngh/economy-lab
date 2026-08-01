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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Choice {
  readonly value: string;
  /** The one line `--list` prints beside the value. */
  readonly describe: string;
  /** What the reader gets, in the scaffolder's closing note. */
  readonly highlight: string;
}

export interface Question {
  readonly id: string;
  readonly flag: string;
  readonly short: string;
  /** The value's placeholder in the usage line. */
  readonly takes: string;
  readonly ask: string;
  readonly choices: readonly Choice[];
  /** The answer `--yes` takes, and the one a blank line accepts. */
  readonly fallback: string;
}

/**
 * Two templates, because the `economy` command has five verbs and every one of them runs or
 * explains a single module file. A template the command cannot drive would be scaffolding
 * nobody can check, and the walk gate could not prove it runs.
 */
export const QUESTIONS: readonly Question[] = [
  {
    id: 'template',
    flag: '--template',
    short: '-t',
    takes: 'name',
    ask: 'template',
    fallback: 'starter',
    choices: [
      {
        value: 'starter',
        describe:
          'the smallest module that boots: a catalog, a posture, a checkout route',
        highlight: 'one wallet, one sale',
      },
      {
        value: 'marketplace',
        describe:
          'the seller arc: fee splits, a provider webhook, payouts, an after handler',
        highlight:
          'a sale that pays a seller, and a payout that leaves the platform',
      },
    ],
  },
];

export type Selection = Readonly<Record<string, string>>;

export const question = (id: string): Question | undefined =>
  QUESTIONS.find((q) => q.id === id);

export const values = (id: string): readonly string[] =>
  question(id)?.choices.map((c) => c.value) ?? [];

export const choice = (id: string, value: string): Choice | undefined =>
  question(id)?.choices.find((c) => c.value === value);

/** Every answer left unspoken, filled with what `--yes` would have taken. */
export const defaults = (): Selection =>
  Object.fromEntries(QUESTIONS.map((q) => [q.id, q.fallback]));

/**
 * Every combination the scaffolder offers, in a stable order. The walk gate enumerates this
 * and proves each one runs, so an offered combination that does not work fails the suite.
 */
export function combinations(): readonly Selection[] {
  let out: Selection[] = [{}];
  for (const q of QUESTIONS) {
    out = out.flatMap((partial) =>
      q.choices.map((c) => ({ ...partial, [q.id]: c.value })),
    );
  }
  return out;
}

/** The template directory shipped in the tarball; `dist/lib` and `src/lib` are both two deep. */
export function templateRoot(): string {
  return fileURLToPath(new URL('../../templates', import.meta.url));
}

/** The chosen template's directory, or null when the roster names one the tarball lacks. */
export function templateDir(selection: Selection): string | null {
  const dir = join(templateRoot(), selection.template ?? '');
  return existsSync(join(dir, 'package.json')) ? dir : null;
}
