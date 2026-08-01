/**
 * @pwngh/economy-adapters
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { runMatrix } from './lib/matrix.js';

const { grid, failed } = runMatrix();
process.stdout.write(`${grid}\n`);
if (failed) process.exit(1);
