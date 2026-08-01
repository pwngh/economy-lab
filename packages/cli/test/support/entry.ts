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

import { runEconomy } from '../../src/index.js';

// What `economy` runs. The shipped bin is a generated file in @pwngh/economy; this suite
// spawns the same two lines so it tests the CLI, not another package's build state.
try {
  process.exit(await runEconomy(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
