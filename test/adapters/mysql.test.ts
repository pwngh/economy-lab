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
} from '#src/adapters/mysql.ts';

let url = process.env.MYSQL_TEST_URL;

// The shared Store conformance suite checks that this adapter behaves like every other
// adapter. It can only be proven against a real database, so it runs only when
// MYSQL_TEST_URL points at a live MySQL. With no URL the suite registers nothing and the
// run is empty, rather than reporting a pass it never actually checked.
//
// The factory builds a fresh store for the suite: open a connection pool, create the
// tables, then wrap the pool in the MySQL-backed store.
if (url) {
  runStoreConformance('mysql', async () => {
    let pool = await createMysqlPool(url);
    await applyMysqlSchema(pool);
    return mysqlStore({ pool });
  });
}
