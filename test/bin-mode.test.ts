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

// Every command this workspace declares, run the way a person runs it: through the link npm
// writes into node_modules/.bin, which the kernel will not exec unless the file it points at
// carries the executable bit. `node <path>` never consults that bit, so a root script spelling
// out the path stays green while the same command through the bin is dead — which is how
// `npm run dev` sat broken with the whole table green.
//
// The roster is read off the manifests here and marked by scripts/support/bin-mode.ts there.
// Two readers of one source: a bin this file cannot see is a bin that script did not mark.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readRootPackage,
  readWorkspace,
} from '#scripts/support/workspace-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The three bits `chmod +x` sets, and the mode a compiler writes without them. */
const EXECUTABLE = 0o111;
const NOT_EXECUTABLE = 0o644;

/** No probe may outlive this. A command that wedges is not a command that runs. */
const PROBE_MS = 60_000;

interface Declared {
  readonly package: string;
  readonly command: string;
  readonly target: string;
  readonly link: string;
}

/**
 * The `bin` maps, read straight off the manifests: a bare string is one command named after the
 * package, an object is one command per key.
 */
function declared(): Declared[] {
  const members = [readRootPackage(ROOT), ...readWorkspace(ROOT).values()];
  assert.ok(members.length > 10, `the sweep read ${members.length} manifests`);
  return members
    .flatMap((member) => {
      const bin = member.json.bin;
      if (bin === undefined) return [];
      const pairs =
        typeof bin === 'string'
          ? [[member.name.replace(/^@[^/]+\//, ''), bin] as const]
          : Object.entries(bin);
      return pairs.map(([command, target]) => ({
        package: member.name,
        command,
        target: join(member.dir, target),
        link: join(ROOT, 'node_modules', '.bin', command),
      }));
    })
    .sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * What each command is asked, and the first thing it must say back. `--help` is the one verb
 * that boots nothing and reaches no service, so the probe proves the file executed and stops.
 * A command with no entry here fails the reconciliation below rather than going unprobed.
 */
const PROBES = new Map([
  ['economy', { argv: ['--help'], says: 'usage: economy <verb>' }],
  ['create-economy', { argv: ['--help'], says: 'usage: create-economy' }],
]);

/** Spawned with a ceiling, and never with the runner's own context in the environment. */
function probe(command: string, argv: readonly string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(command, [...argv], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: PROBE_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    run,
    output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    wedged: run.signal !== null,
  };
}

/**
 * Edited deliberately when a command is added. Both sides of a reconciliation fall together when
 * a manifest loses its `bin`, so the size is pinned apart from the roster.
 */
const DECLARED_COMMANDS = 2;

test('every declared bin is rostered, built and executable', () => {
  const bins = declared();
  assert.equal(
    bins.length,
    DECLARED_COMMANDS,
    `the manifests declare ${bins.map((bin) => bin.command).join(', ') || 'nothing'}`,
  );
  assert.deepEqual(
    bins.map((bin) => bin.command).sort(),
    [...PROBES.keys()].sort(),
    'a declared command has no probe, or a probe names a command nothing declares',
  );
  const wrong: string[] = [];
  for (const bin of bins) {
    if (!existsSync(bin.target)) {
      wrong.push(
        `${bin.package} declares ${bin.command} and ${relative(ROOT, bin.target)} is not built`,
      );
      continue;
    }
    if ((statSync(bin.target).mode & EXECUTABLE) !== EXECUTABLE) {
      wrong.push(
        `${relative(ROOT, bin.target)} is mode ${(statSync(bin.target).mode & 0o777).toString(8)}; run node scripts/support/bin-mode.ts`,
      );
    }
    if (!existsSync(bin.link)) {
      wrong.push(`npm linked no ${bin.command} into node_modules/.bin`);
      continue;
    }
    if (lstatSync(bin.link).isSymbolicLink()) {
      assert.equal(
        realpathSync(bin.link),
        realpathSync(bin.target),
        `node_modules/.bin/${bin.command} points somewhere other than ${relative(ROOT, bin.target)}`,
      );
    }
  }
  assert.deepEqual(wrong, []);
});

test('the linked bin runs, executed rather than handed to node', () => {
  const bins = declared();
  assert.ok(bins.length > 0, 'nothing was probed');
  for (const bin of bins) {
    const { argv, says } = PROBES.get(bin.command)!;
    // The link is spawned as the program. Passing it to `node` would prove the file parses and
    // nothing about the bit, which is the whole defect.
    const { run, output, wedged } = probe(bin.link, argv);
    assert.ok(
      !wedged,
      `${bin.command} ${argv.join(' ')} was killed by ${run.signal} after ${PROBE_MS}ms`,
    );
    assert.equal(
      run.error,
      undefined,
      `${bin.command} could not be executed: ${run.error?.message}`,
    );
    assert.equal(
      run.status,
      0,
      `${bin.command} ${argv.join(' ')} exited ${run.status}\n${output.slice(-2000)}`,
    );
    assert.ok(
      output.includes(says),
      `${bin.command} ran and did not say ${JSON.stringify(says)}\n${output.slice(-2000)}`,
    );
  }
});

test('the probe can tell an unexecutable command from a working one', () => {
  // Positive control. Both assertions above pass against a machine that ignores the mode
  // entirely, so the detector is turned on a file whose bit is known — first off, then on.
  const dir = mkdtempSync(join(tmpdir(), 'economy-bin-mode-'));
  const script = join(dir, 'control');
  try {
    writeFileSync(
      script,
      '#!/usr/bin/env node\nprocess.stdout.write("ran\\n");\n',
    );

    chmodSync(script, NOT_EXECUTABLE);
    const refused = probe(script, []);
    assert.ok(
      !refused.wedged,
      'the unexecutable control was killed, not refused',
    );
    assert.equal(
      (refused.run.error as NodeJS.ErrnoException | undefined)?.code,
      'EACCES',
      `a mode ${NOT_EXECUTABLE.toString(8)} file was not refused; this platform does not enforce the bit, so the probes above prove nothing`,
    );
    assert.ok(
      !refused.output.includes('ran'),
      'the unexecutable control ran anyway',
    );

    chmodSync(script, NOT_EXECUTABLE | EXECUTABLE);
    const allowed = probe(script, []);
    assert.ok(!allowed.wedged, 'the executable control was killed');
    assert.equal(
      allowed.run.error,
      undefined,
      `the control was refused with its bit set: ${allowed.run.error?.message}`,
    );
    assert.ok(
      allowed.output.includes('ran'),
      `the control did not run with its bit set\n${allowed.output.slice(-1000)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
