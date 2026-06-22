/// <reference types="node" />
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

import { runStoreConformance } from '#test/conformance/store.ts';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysqlStore,
} from '#src/engines/mysql.ts';

let url = process.env.MYSQL_TEST_URL;

// Shared Store conformance suite, run against this adapter. Requires a real database, so it
// only runs when MYSQL_TEST_URL points at a live MySQL; with no URL it registers nothing
// (an empty run, not a false pass).
//
// Factory builds a fresh store per run: open a pool, create the tables, wrap the pool.
if (url) {
  runStoreConformance('mysql', async () => {
    let pool = await createMysqlPool(url);
    await applyMysqlSchema(pool);
    return mysqlStore({ pool });
  });
}
