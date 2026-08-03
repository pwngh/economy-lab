/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { writeSync } from 'node:fs';
import process from 'node:process';

import { runEconomy } from '../../src/index.js';

/** A sink that keeps what a verb wrote, standing in for a process stream. */
function sink(): { write(text: string): boolean; text(): string } {
  let held = '';
  return {
    write: (text) => {
      held += text;
      return true;
    },
    text: () => held,
  };
}

// LEAK names the write the caller wants made to a real stream, so the guard that holds these
// two streams empty can be seen to fire. Unset, nothing here touches either one.
const leak = process.env.LEAK ?? '';
if (leak === 'stdout') process.stdout.write('leaked to the real stdout\n');
if (leak === 'stderr') process.stderr.write('leaked to the real stderr\n');

const out = sink();
const err = sink();
const code = await runEconomy(process.argv.slice(2), {
  stdout: out,
  stderr: err,
});

// fd 3, because stdout and stderr are the two things under test: a run that reported on either
// of them would be indistinguishable from the leak it is here to rule out.
writeSync(3, JSON.stringify({ code, out: out.text(), err: err.text() }));
process.exit(0);
