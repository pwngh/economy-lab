/**
 * @pwngh/economy-postgres
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

export { loadPg, openPgPool } from './pg-driver.js';

export type { PgClientLike, PgPoolConfig, PgPoolLike } from './pg-driver.js';
