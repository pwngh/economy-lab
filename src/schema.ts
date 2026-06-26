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
 * Schema version stamp — the one guard against a database that has silently drifted from this code.
 *
 * Both SQL schema files (db/postgresql-schema.sql, db/mysql-schema.sql) seed a single `schema_meta`
 * row with this exact value. On startup each SQL engine reads it back and refuses to run if it does
 * not match (see {@link assertSchemaCurrent}). That turns a silent drift — the engine reading
 * `platform:` accounts out of a database still on the old `vrchat:` schema, and showing $0.00
 * instead of erroring — into a loud, actionable startup error.
 *
 * Bump this AND the matching `insert into schema_meta` in BOTH schema files in the same change,
 * whenever the schema changes: a new column, a renamed account id, an added index. Any edit that a
 * running database would need re-migrated to pick up should bump the version.
 */
export const SCHEMA_VERSION = '5';

/**
 * Throw unless the database's stamped schema version matches this build's {@link SCHEMA_VERSION}.
 *
 * `found` is the value read from the database's `schema_meta` row, or `null` when that table is
 * absent — an un-migrated database, or one created before versioning existed. `backend` names the
 * engine ('Postgres' / 'MySQL') for the error message.
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
