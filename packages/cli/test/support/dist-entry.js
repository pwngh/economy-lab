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

import { runEconomy } from '../../dist/index.js';

// The sibling entry.ts needs tsx to run, and tsx's loader keeps a .ts module out of node's
// watch graph. Nothing here needs a loader, so `--watch` sees what the process imports.
try {
  process.exit(await runEconomy(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
