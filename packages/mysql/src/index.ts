/**
 * @pwngh/economy-mysql
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/**
 * Opens a MySQL-backed `Store`. The pool, the schema gate, and the money-routine install and
 * proof all happen inside, so a returned store already matches this build's schema and
 * arithmetic. `close()` ends the pool it opened.
 */
export { mysql } from './mysql.js';

/**
 * The escape hatch: the same Store, built over a pool the caller opened — the `mysql2` pool
 * {@link createMysqlPool} builds, or the pipelining `mariadb` pool from the `/mariadb` subpath.
 * That pool stays the caller's: `close()` leaves it open for them to end. The escape hatch is the
 * wire, not the trust: this factory is synchronous, so the money install and proof run once before
 * the first operation instead of at open.
 */
export { mysqlStore } from './mysql.js';

/** Opens the `mysql2` pool the store rides, for a caller that wants to hold it. */
export { createMysqlPool } from './mysql.js';

/**
 * Applies `db/mysql-schema.sql` wholesale. It drops and recreates the tables, so it is a setup
 * and CI verb, never something an app runs at startup.
 */
export { applyMysqlSchema } from './mysql.js';

/** Reads the database's `schema_meta` stamp, or null when the table is absent. */
export { readSchemaVersion } from './mysql.js';

export type {
  EngineOpenOptions,
  MysqlConnection,
  MysqlOptions,
  MysqlPool,
} from './mysql.js';
