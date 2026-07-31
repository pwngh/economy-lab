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

import { postgresStore } from './postgres.js';

import type { Store } from '@pwngh/economy-lab/ports';
import type { PgPool, PostgresStoreOptions } from './postgres.js';

/** Everything {@link postgres} accepts beyond the connection URL. */
export type PostgresOptions = Omit<PostgresStoreOptions, 'url'>;

/**
 * Opens a Postgres-backed {@link Store}. The pool, the schema gate, and the money-routine install
 * and proof all happen inside, so a returned store already matches this build's schema and
 * arithmetic. `close()` ends the pool it opened.
 *
 * Pass `{ pool }` in place of the URL when the caller owns the wire. That pool stays the
 * caller's: `close()` leaves it open for them to end.
 *
 * @example
 * let store = await postgres('postgres://econ:secret@127.0.0.1:5432/economy', {
 *   poolMax: 32,
 * });
 * await store.ledger.balance('usr_ada:spendable'); // CREDIT:480.00
 * await store.close();
 */
export function postgres(
  url: string,
  options?: PostgresOptions,
): Promise<Store>;
export function postgres(
  options: PostgresOptions & { pool: PgPool },
): Promise<Store>;
export function postgres(
  source: string | (PostgresOptions & { pool: PgPool }),
  options: PostgresOptions = {},
): Promise<Store> {
  return typeof source === 'string'
    ? postgresStore({ ...options, url: source })
    : postgresStore({ ...source, url: '' });
}

/**
 * The escape hatch: the same Store, built over a pool the caller opened. Everything
 * {@link postgres} does inside still happens, so the schema gate and money proof are not skipped.
 */
export { postgresStore } from './postgres.js';

export type {
  EngineOpenOptions,
  PgPool,
  PostgresStoreOptions,
} from './postgres.js';
