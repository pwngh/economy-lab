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
 * The stamped schema version. Both SQL schema files seed a `schema_meta` row with this value.
 * Startup reads it back and fails fast on a mismatch (see {@link assertSchemaCurrent}).
 *
 * Bump this AND the matching `insert into schema_meta` in BOTH schema files
 * (packages/postgres/db/postgresql-schema.sql, packages/mysql/db/mysql-schema.sql) in the same
 * change, whenever a running database would need re-migrating to pick up the edit.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/configuration/ Configuration}
 *   for schema versioning and drift guard.
 */
export const SCHEMA_VERSION = '19';

/**
 * Throws unless `found` (the database's `schema_meta` value) matches this build's
 * {@link SCHEMA_VERSION}. `found` is null when the table is absent, which means an un-migrated
 * or pre-versioning database.
 */
export function assertSchemaCurrent(
  found: string | null,
  backend: string,
): void {
  if (found === SCHEMA_VERSION) return;
  const state =
    found === null
      ? 'has no schema_meta row (an un-migrated or pre-versioning database)'
      : `is at schema version ${found}`;
  throw new Error(
    `economy-lab: the ${backend} database ${state}, but this build expects schema version ` +
      `${SCHEMA_VERSION}. Re-apply the schema with \`make db-migrate\` so the database matches ` +
      'this code.',
  );
}

/**
 * The error a failed `schema_meta` read raises when the failure is not a missing table. Only a
 * missing table means un-migrated, so every other failure must say so plainly: re-applying a
 * schema against a database that cannot be reached is advice that can cost data.
 */
export function unreachableDatabase(backend: string, cause: unknown): Error {
  return new Error(
    `economy-lab: could not read the ${backend} database's schema_meta stamp. The database is ` +
      'unreachable, or it refused the read. This is not an un-migrated schema, so re-applying ' +
      'the schema fixes nothing. Restore the connection first.',
    { cause },
  );
}

/**
 * Throws unless the live database passed the money conformance vectors at boot. `failures` is
 * the output of provePostgres/proveMysql, run right after their
 * idempotent install. A non-empty list therefore means the engine's own arithmetic disagrees
 * with src/money-arithmetic.ts. No posting is safe to trust to such an engine.
 */
export function assertMoneyConformant(
  failures: readonly string[],
  backend: string,
): void {
  if (failures.length === 0) return;
  throw new Error(
    `economy-lab: the ${backend} database failed ${failures.length} money conformance ` +
      `vector(s); first: ${failures[0]}. The money functions were just installed, so the ` +
      'engine computes different arithmetic than this build. Refusing to run against it.',
  );
}
