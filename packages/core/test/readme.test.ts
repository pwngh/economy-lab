/**
 * @pwngh/economy-core
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
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';

const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const { name } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string };

// V2: the README is governed — counts and claims assert against the tree, not memory.
test('README claims hold', async () => {
  // Derived, so a rename moves the pin with it.
  assert.ok(
    md.startsWith(`# ${name.replace('@pwngh/economy-', '')}\n`),
    'the h1 is the package, short-named like its siblings',
  );
  // Every README installs the umbrella; the split below it is a publishing concern.
  assert.ok(
    md.includes('npm i @pwngh/economy\n'),
    'the install line names the umbrella',
  );
  assert.ok(
    !md.includes('npm i @pwngh/economy-core'),
    'the install line does not name this package',
  );
  const core = (await import('../src/index.js')) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(core).sort(),
    ['createApp', 'withDev'],
    'the README shows the whole root, and it is two names',
  );

  const ops = (await import('../src/ops.js')) as Record<string, unknown>;
  for (const name of [
    'topUp',
    'idempotencyKey',
    'isRejection',
    'requireSuccess',
  ]) {
    assert.ok(name in ops, `README imports ${name}, ./ops exports it`);
  }
  // The split that moved the vocabulary: building an amount is the money package's job.
  assert.ok(
    !('credits' in ops) && !('usd' in ops),
    'credits and usd left ./ops',
  );
  // Imports go through the umbrella's door, not the package name behind it.
  assert.ok(
    md.includes("from '@pwngh/economy/money'"),
    'the README builds amounts at the money door',
  );

  const { KNOWN_EXPORTS } = await import('../src/module.js');
  assert.ok(
    md.includes(`KNOWN_EXPORTS.length; // ${KNOWN_EXPORTS.length}`),
    'the stated seam count is the roster length',
  );
  for (const seam of KNOWN_EXPORTS) {
    assert.ok(md.includes(`\`${seam}\``), `the seam roster names ${seam}`);
  }

  // The escape hatch is a claim about what is absent, so each name is resolved three ways:
  // named in the README, absent from this door, present on the lab root the README points at.
  // The roster comes from the door's own `Never re-exported:` comment — the README once listed
  // six of its seven, and a written-out list here could not see the missing one.
  const doorSource = readFileSync(
    new URL('../src/index.ts', import.meta.url),
    'utf8',
  );
  const hatchComment = /Never re-exported: ([^.]+)\./.exec(
    doorSource.replace(/\n\/\/ ?/g, ' '),
  );
  assert.ok(hatchComment, 'src/index.ts states the never-re-exported roster');
  const HATCH = hatchComment[1]!.split(',').map((name) => name.trim());
  assert.equal(HATCH.length, 7, `the roster names ${HATCH.length} symbols`);
  // The README's claim is package-granular — "add @pwngh/economy-lab and import it from
  // there" — and one of the seven (handleWebhook) lives on that package's ./server door
  // rather than its root, so both doors count as "there".
  const lab = (await import('@pwngh/economy-lab')) as Record<string, unknown>;
  const labServer = (await import('@pwngh/economy-lab/server')) as Record<
    string,
    unknown
  >;
  for (const verb of HATCH) {
    assert.ok(
      md.includes(verb),
      `the README names ${verb} as reachable only from the lab`,
    );
    assert.ok(!(verb in core), `${verb} is not on the door`);
    assert.ok(
      verb in lab || verb in labServer,
      `${verb} is importable from @pwngh/economy-lab`,
    );
  }
});

// A trailing `// ` output comment is a claim you have run (the register's rule), and these two
// were not: both printed `Set(3) { … }` for a field declared `readonly string[]`. The claim is
// resolved against the real value — the README's example module, resolved by this package,
// rendered by util.inspect, container form included.
test('the README module.exports output comments show the inspected value', async () => {
  const { resolveEconomyModule } = await import('../src/module.js');
  const rendered = inspect(
    resolveEconomyModule({
      authenticate: false,
      policy: { velocityLimitMinor: 10_000_000n },
      worker: { intervalMs: 5_000 },
    }).exports,
  );
  const outputs = [...md.matchAll(/^(?:app\.)?module\.exports; \/\/ (.+)$/gm)];
  assert.equal(outputs.length, 2, `found ${outputs.length} output comments`);
  for (const m of outputs) {
    assert.equal(m[1], rendered, 'the comment shows the value node prints');
  }
});

// The altitude ladder is dead here: pieces compose flat, at one level.
test('the README describes flat composition, never a ladder', () => {
  for (const word of [
    /\brungs?\b/i,
    /\bpeels?\b/i,
    /\baltitude\b/i,
    /\bdescends?\b/i,
    /\bR[0-3]\b/,
  ]) {
    assert.equal(word.test(md), false, `the README still says ${String(word)}`);
  }
});
