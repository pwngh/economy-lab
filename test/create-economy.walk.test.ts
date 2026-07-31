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
 * The create-economy walk: every combination the scaffolder offers, taken from the packed
 * tarball to a running service that moves money.
 *
 * This is the fast variant of the acceptance tier — `economy dev` is the memory posture, so the
 * whole file runs with no database and no Docker. `acceptance/rigs.test.ts` takes the same
 * projects to a real engine, and both drive one harness so the two postures cannot drift.
 *
 * The template Dockerfile is not a leg here. The walk installs from vendored tarballs, and the
 * image installs from the lockfile before it copies the tree, so `npm ci` inside the build
 * would look for tarballs that are not there yet. Its contents are asserted in
 * create-economy.test.ts instead; the build itself is proven once the umbrella is published.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  LEG_BOUND_MS,
  TEMPLATES,
  build,
  moveMoney,
  ok,
  openWorkspace,
  rows,
  run,
  scaffold,
  serve,
} from '#test/acceptance/harness.ts';

import type { Workspace } from '#test/acceptance/harness.ts';

// The walk installs, compiles, and binds a socket, so the fast inner loop can turn it off.
// It runs by default: an opt-in gate is one nobody takes.
const SKIP =
  process.env.ECONOMY_SKIP_WALK === '1' ? 'ECONOMY_SKIP_WALK=1' : false;

test('the scaffolder is built, so the walk has rows to take', () => {
  assert.ok(
    rows.length > 0,
    'packages/create-economy/dist is missing — run `npm run build:packages`',
  );
});

// The row list and the template directories are two readings of one roster, and the walk is only
// evidence about the scaffolder if they agree. A template shipped in the tarball and never
// offered on the menu would otherwise be walked by nothing.
test('every template on disk is a row, and every row is a template', () => {
  assert.deepEqual([...new Set(rows.map((row) => row.template))].sort(), [
    ...TEMPLATES,
  ]);
  assert.equal(rows.length, TEMPLATES.length);
  assert.equal(TEMPLATES.length, 2, 'the template roster changed size');
});

describe(
  'create-economy: every offered combination walks',
  { skip: SKIP },
  () => {
    let ws: Workspace | null = null;

    before(
      () => {
        ws = openWorkspace();
      },
      { timeout: LEG_BOUND_MS },
    );

    after(() => {
      ws?.clean();
    });

    for (const row of rows) {
      const label = Object.values(row).join(' + ');

      test(
        `${label}: scaffold, install, check, build, test, run`,
        { timeout: LEG_BOUND_MS },
        async () => {
          const project = scaffold(ws!, row);
          assert.ok(
            existsSync(join(project.dir, '.gitignore')),
            'the dotfile was renamed on the way out',
          );

          // Without secrets a template that decodes webhooks lints (exit 1); nothing may error
          // (exit 2), because that would mean the environment itself does not compile. Stated for
          // the same reason the boot below is: this repository's .env names a postgres and a redis
          // the scaffolded module supplies no port for, and preflight refuses that — so an
          // inherited environment makes the truth pass answer for a deployment nobody asked for.
          const bare = run('npm', ['run', 'check'], project.dir, {
            stated: true,
          });
          assert.notEqual(
            bare.code,
            2,
            `check found a hard fault\n${bare.out.slice(-4000)}`,
          );

          const checked = run('npm', ['run', 'check'], project.dir, {
            env: {
              WEBHOOK_SECRET: 'walk-webhook-secret',
              SIGNING_SECRET: 'walk-signing-secret',
            },
            stated: true,
          });
          ok(checked, 'npm run check');
          // `/clean/` matched `preflight` anywhere, so a module producing a lint but no preflight
          // issue satisfied it. Both halves of "came back clean" are named instead, and the
          // preflight half names both postures: `check` reports `deployed` and `dev` separately,
          // and prints this one agreeing row only when neither raises an issue.
          assert.match(
            checked.out,
            /^preflight deployed and dev agree — clean$/m,
            'the environment raised no preflight issue in either posture',
          );
          assert.match(
            checked.out,
            /^lints\s+none$/m,
            'and the module raised no lint',
          );

          build(project);

          // The count is read back, not just the exit code: a suite that ran nothing would
          // otherwise answer 0 and look like proof.
          const suite = run('npm', ['test'], project.dir);
          ok(suite, "the template's own suite");
          assert.match(
            suite.out,
            /# fail 0\b/,
            'the template suite reported no failures',
          );
          const passed = Number(/# pass (\d+)/.exec(suite.out)?.[1] ?? 0);
          assert.ok(
            passed > 0,
            `the template suite ran nothing\n${suite.out.slice(-2000)}`,
          );

          const service = await serve(project.dir, {
            argv: ['dev', '--app', 'dist/economy.app.js', '--port', '0'],
            env: { NODE_ENV: '' },
            // Stated, so the repository's own .env cannot hand the memory posture a rig URL and
            // turn the fast variant into a second, slower rig run.
            stated: true,
          });
          try {
            await moveMoney(service.base);
          } finally {
            await service.stop();
          }
        },
      );
    }
  },
);
