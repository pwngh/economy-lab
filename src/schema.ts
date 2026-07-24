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
 * The stamped schema version. Both SQL schema files seed a `schema_meta` row with this value;
 * startup reads it back and fails fast on a mismatch (see {@link assertSchemaCurrent}).
 *
 * Bump this AND the matching `insert into schema_meta` in BOTH schema files
 * (db/postgresql-schema.sql, db/mysql-schema.sql) in the same change, whenever a running database
 * would need re-migrating to pick up the edit.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/configuration/ Configuration}
 *   for schema versioning and drift guard.
 */
export const SCHEMA_VERSION = '17';

/**
 * Throws unless `found` (the database's `schema_meta` value) matches this build's
 * {@link SCHEMA_VERSION}. `found` is null when the table is absent: an un-migrated or
 * pre-versioning database.
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
 * Throws unless the live database passed the money conformance vectors at boot. `failures` is
 * the output of the vendored db carrier's provePostgres/proveMysql, run right after its
 * idempotent install — so a non-empty list means the engine's own arithmetic disagrees with
 * src/money.vendored.ts, and no posting is safe to trust to it.
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
