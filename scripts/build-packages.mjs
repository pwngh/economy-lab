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

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { markBinsExecutable } from './support/bin-mode.ts';
import { dependencyOrder, readWorkspace } from './support/workspace-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * What this loop will do to each package, resolved from the workspace on disk rather than from a
 * list kept here. `--plan` prints it and runs nothing, which is what
 * `test/tsconfig-coverage.test.ts` reads to hold the two rosters to the same source.
 */
function plan(workspace, order) {
  return order.map((name) => {
    const { dir, json } = workspace.get(name);
    return {
      name,
      dir,
      build: json.scripts?.build ?? null,
      check: json.scripts?.check ?? null,
    };
  });
}

function runScript(step, script) {
  try {
    // tsc reports on stdout, so inherit it — a swallowed build failure is unreadable.
    execFileSync('npm', ['run', script, '--silent'], {
      cwd: step.dir,
      stdio: 'inherit',
    });
    return true;
  } catch {
    console.error(`build-packages: ${step.name} failed ${script}`);
    return false;
  }
}

function main(argv) {
  const workspace = readWorkspace(ROOT);
  let order;
  try {
    order = dependencyOrder(workspace);
  } catch (cycle) {
    console.error(cycle.message);
    return 1;
  }
  const steps = plan(workspace, order);
  const wantBuild = steps.filter((step) => step.build !== null).length;
  const wantCheck = steps.filter((step) => step.check !== null).length;

  if (argv.includes('--plan')) {
    for (const step of steps) {
      console.log(
        `plan ${step.name} build=${step.build === null ? 'no' : 'yes'} check=${step.check === null ? 'no' : 'yes'}`,
      );
    }
    console.log(
      `build-packages: ${steps.length} packages in dependency order, ${wantBuild} with a build script, ${wantCheck} with a check script`,
    );
    return 0;
  }

  let built = 0;
  for (const step of steps) {
    if (step.build === null) continue;
    console.log(`build ${step.name}`);
    if (!runScript(step, 'build')) return 1;
    built += 1;
  }

  // Checked after every build, not beside each one: a package's own check compiles against its
  // siblings' emit, and the umbrella that half of them re-export is built last.
  let checked = 0;
  for (const step of steps) {
    if (step.check === null) continue;
    console.log(`check ${step.name}`);
    if (!runScript(step, 'check')) return 1;
    checked += 1;
  }
  if (built !== wantBuild || checked !== wantCheck) {
    console.error(
      `build-packages: ${wantBuild} build and ${wantCheck} check scripts were declared, and ${built} and ${checked} ran`,
    );
    return 1;
  }

  // A compiler writes its emit at 644, and a `bin` target at 644 is a command the kernel refuses
  // to exec however correct its shebang is.
  const { marked } = markBinsExecutable(ROOT);
  console.log(
    `build-packages: ${steps.length} packages in dependency order, ${built} built, ${checked} checked, ` +
      `${steps.length - checked} with no check script (their own tsconfig.json loads every file they have — ` +
      `test/tsconfig-coverage.test.ts), ${marked.length} bin target(s) executable`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
