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

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  readWorkspace,
  runtimeDependencies,
} from '#scripts/support/workspace-graph.ts';

export interface Suite {
  readonly name: string;
  readonly dir: string;
  /** Absolute, sorted: the files this suite's own script names, not the files near it. */
  readonly files: readonly string[];
  readonly needsEngine: boolean;
  readonly skipBudget: number;
}

// A member with no suite of its own. Named, never inferred: a package that merely forgot its
// tests must still fail.
export const NO_SUITE = new Map([
  [
    '@pwngh/economy',
    'generated doors only — every door is proven by test/manifest.test.ts',
  ],
]);

// A member whose suite is not under its own test/ directory, root-relative. The scaffolder's
// suite packs and installs the whole workspace, so it lives beside the tree it packs.
export const ELSEWHERE = new Map([
  ['create-economy', ['test/create-economy.test.ts']],
]);

// Every driver a backend package owns. A member declaring one cannot prove anything without
// that engine live. test/no-shims.test.ts reads the same list to keep the drivers out of the lab.
export const DRIVERS = [
  'pg',
  'mysql2',
  'mariadb',
  'ioredis',
  '@aws-sdk/client-sqs',
] as const;

// A suite that skipped proved less than it printed, and an unreachable backend skips rather
// than fails. Every suite here runs at zero skips, so nothing is allowed one.
const SKIP_BUDGET = 0;

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The path patterns a test script hands to `node --test`, in order. Anything before `--test`
 * is the runner's own flags, and anything after it starting with `-` is a flag too.
 */
export function testPatterns(script: string): string[] {
  const tokens = script.split(/\s+/).filter((token) => token !== '');
  const at = tokens.indexOf('--test');
  if (at === -1) return [];
  return tokens.slice(at + 1).filter((token) => !token.startsWith('-'));
}

/**
 * The files one pattern names, sorted. Only a `*` in the final segment is read, which is the
 * shape every package uses; a pattern globbing a directory throws rather than resolving to a
 * guess, because a pattern silently matching nothing is how a suite leaves the gate green.
 */
function match(dir: string, pattern: string): string[] {
  const absolute = resolve(dir, pattern);
  const parent = dirname(absolute);
  const name = basename(absolute);
  if (parent.includes('*')) {
    throw new Error(
      `package-suites: cannot read "${pattern}" — only the last segment may glob`,
    );
  }
  if (!name.includes('*')) return existsSync(absolute) ? [absolute] : [];
  if (!existsSync(parent)) return [];
  const wanted = new RegExp(`^${name.split('*').map(escape).join('[^/]*')}$`);
  return readdirSync(parent)
    .filter((entry) => wanted.test(entry))
    .map((entry) => join(parent, entry))
    .sort();
}

/** Every workspace member that owns a suite, in the order the workspace reads them. */
export function suitePlan(root: string): readonly Suite[] {
  const plan: Suite[] = [];
  for (const member of readWorkspace(root).values()) {
    if (NO_SUITE.has(member.name)) continue;
    const files = testPatterns(member.json.scripts?.test ?? '').flatMap(
      (pattern) => match(member.dir, pattern),
    );
    const dependencies = runtimeDependencies(member);
    plan.push({
      name: member.name,
      dir: member.dir,
      files: [...new Set(files)].sort(),
      needsEngine: DRIVERS.some((driver) => driver in dependencies),
      skipBudget: SKIP_BUDGET,
    });
  }
  return plan;
}
