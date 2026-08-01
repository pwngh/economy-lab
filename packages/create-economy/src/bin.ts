#!/usr/bin/env node
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

import { runCreateEconomy } from './lib/cli.js';

try {
  process.exit(await runCreateEconomy(process.argv.slice(2)));
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
}
