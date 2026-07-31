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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SNAPSHOT = fileURLToPath(
  new URL('./fixtures/openapi.snapshot.json', import.meta.url),
);

// The two repos already assume they are siblings: each generator reaches back for this very
// snapshot by the mirror of this path. The override exists so a checkout elsewhere can gate too.
const OVERRIDE = process.env.ECONOMY_CLIENTS_DIR;
const CLIENTS =
  OVERRIDE ??
  fileURLToPath(new URL('../../../economy-clients-git', import.meta.url));

// spawnSync waits forever by default, and it blocks the event loop while it does, so a generator
// that stops terminating would wedge the run rather than fail it. Each of these reads one snapshot
// and writes one file; the slowest measured under a second.
const GENERATOR_BOUND_MS = 60_000;

interface Client {
  readonly slug: string;
  /** Generator entry point, relative to the client directory. */
  readonly generator: string;
  /** The file that generator writes, relative to the client directory. */
  readonly output: string;
}

const CLIENTS_TABLE: readonly Client[] = [
  {
    slug: 'economy-client-python',
    generator: 'generate.mjs',
    output: join('economy_lab_client', '_ops.py'),
  },
  {
    slug: 'economy-client-php',
    generator: 'generate.mjs',
    output: join('src', 'Ops.php'),
  },
];

/**
 * The default checkout going missing skips by name; a missing explicit override fails instead.
 * A skip has to mean "not here to test", never "the rig is broken".
 */
function skipReason(): string | false {
  if (existsSync(CLIENTS)) return false;
  if (OVERRIDE !== undefined) return false;
  return `no client checkout at ${CLIENTS} (clone economy-clients-git beside economy-lab-git to gate it)`;
}

describe(
  'The Generated Clients Track The Wire Contract',
  { skip: skipReason() },
  () => {
    test('the client checkout is whole, so the gate has something to compare', () => {
      assert.ok(
        existsSync(CLIENTS),
        `ECONOMY_CLIENTS_DIR points at ${CLIENTS}, which does not exist`,
      );
      for (const client of CLIENTS_TABLE) {
        const dir = join(CLIENTS, client.slug);
        assert.ok(existsSync(dir), `${client.slug} is missing from ${CLIENTS}`);
        assert.ok(
          existsSync(join(dir, client.generator)),
          `${client.slug}/${client.generator} is missing — the generator is the contract's only door`,
        );
        assert.ok(
          existsSync(join(dir, client.output)),
          `${client.slug}/${client.output} is missing — run \`node ${client.generator}\` in ${dir}`,
        );
      }
    });

    for (const client of CLIENTS_TABLE) {
      test(`${client.slug} is what the current snapshot generates`, () => {
        const source = join(CLIENTS, client.slug);
        const committed = readFileSync(join(source, client.output), 'utf8');

        // Generate into a copy. A gate that regenerated in place would repair the drift it
        // exists to report, and could never fail twice.
        const work = mkdtempSync(join(tmpdir(), 'economy-clients-gate-'));
        try {
          cpSync(source, work, { recursive: true });
          const env = { ...process.env };
          delete env.NODE_TEST_CONTEXT;
          delete env.NODE_OPTIONS;
          const run = spawnSync(
            process.execPath,
            [join(work, client.generator), SNAPSHOT],
            { cwd: work, encoding: 'utf8', env, timeout: GENERATOR_BOUND_MS },
          );
          const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
          assert.equal(
            run.status,
            0,
            `${client.slug}/${client.generator} failed against the current snapshot:\n${output}`,
          );
          assert.match(
            output,
            /generated/,
            `${client.slug}/${client.generator} exited 0 but reported nothing generated:\n${output}`,
          );

          const emitted = join(work, client.output);
          assert.ok(
            existsSync(emitted),
            `${client.slug}/${client.generator} exited 0 but wrote no ${client.output}:\n${output}`,
          );
          assert.equal(
            readFileSync(emitted, 'utf8'),
            committed,
            `${client.slug}/${client.output} is not what the current wire snapshot generates.\n` +
              `Either the contract moved and the client was left behind, or the file was edited by hand.\n` +
              `Fix: cd ${source} && node ${client.generator}`,
          );
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
    }
  },
);
