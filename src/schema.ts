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

/**
 * Stamps the schema version. This is the one guard against a database that has silently drifted from
 * this code.
 *
 * Both SQL schema files seed a `schema_meta` row with this value. Startup reads it back and fails fast
 * on a mismatch (see {@link assertSchemaCurrent}), so a drift is reported as an error instead of going undetected.
 *
 * Bump this AND the matching `insert into schema_meta` in BOTH schema files
 * (db/postgresql-schema.sql, db/mysql-schema.sql) in the same change, whenever a running database
 * would need re-migrating to pick up the edit: a new column, a renamed account id, an added index.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/configuration/ Configuration} for schema versioning and drift guard.
 */
export const SCHEMA_VERSION = '8';

/**
 * Throws unless the database's stamped schema version matches this build's {@link SCHEMA_VERSION}.
 *
 * `found` is the value read from the database's `schema_meta` row. It is `null` when that table is
 * absent, which means an un-migrated database or one created before versioning existed. `backend`
 * names the engine ('Postgres' or 'MySQL') for the error message.
 */
export function assertSchemaCurrent(
  found: string | null,
  backend: string,
): void {
  if (found === SCHEMA_VERSION) return;
  let state =
    found === null
      ? 'has no schema_meta row (an un-migrated or pre-versioning database)'
      : `is at schema version ${found}`;
  throw new Error(
    `economy-lab: the ${backend} database ${state}, but this build expects schema version ` +
      `${SCHEMA_VERSION}. Re-apply the schema with \`make db:migrate\` so the database matches ` +
      'this code.',
  );
}
