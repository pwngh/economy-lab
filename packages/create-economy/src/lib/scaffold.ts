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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

/** Files a fresh checkout carries that do not count as "this directory is taken". */
const IGNORED = ['.git', '.DS_Store'];

/**
 * The token every template spells where the reader's project name belongs. Brace-form because
 * the earlier `__PROJECT_NAME__` was markdown bold: Prettier rewrote it to `**PROJECT_NAME**`
 * in the template READMEs and the substitution silently stopped matching. `{{…}}` round-trips
 * the formatter.
 */
export const NAME_TOKEN = '{{PROJECT_NAME}}';

export interface ScaffoldPlan {
  readonly from: string;
  readonly to: string;
  readonly packageName: string;
  readonly force: boolean;
}

export type ScaffoldResult =
  | { readonly ok: true; readonly written: readonly string[] }
  | { readonly ok: false; readonly refusal: string };

/**
 * npm drops a file named `.gitignore` from the tarball it publishes, so a template stores
 * its dotfiles with a leading underscore and this puts the dot back.
 */
export const scaffoldedName = (name: string): string =>
  name.startsWith('_') ? `.${name.slice(1)}` : name;

/** Entries that make a directory occupied, sorted for a stable refusal line. */
export function occupants(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => !IGNORED.includes(entry))
    .sort();
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** The template path a scaffolded file lands at: every `_name` segment becomes `.name`. */
export function targetPath(to: string, from: string, file: string): string {
  const parts = relative(from, file).split(/[/\\]/).map(scaffoldedName);
  return join(to, ...parts);
}

/**
 * Copies the template, substituting the project name. Refuses a directory that already
 * holds files unless `force` says otherwise; writes nothing before that check passes.
 */
export function scaffold(plan: ScaffoldPlan): ScaffoldResult {
  const taken = occupants(plan.to);
  if (taken.length && !plan.force) {
    const shown = taken.slice(0, 4).join(', ');
    return {
      ok: false,
      refusal:
        `${plan.to} already holds ${taken.length} entr${taken.length === 1 ? 'y' : 'ies'}` +
        ` (${shown}${taken.length > 4 ? ', …' : ''}) — pick an empty directory, or pass --force`,
    };
  }
  const written: string[] = [];
  for (const file of walk(plan.from)) {
    const target = targetPath(plan.to, plan.from, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(
      target,
      readFileSync(file, 'utf8').split(NAME_TOKEN).join(plan.packageName),
    );
    written.push(relative(plan.to, target));
  }
  return { ok: true, written };
}
