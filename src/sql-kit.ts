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
 * The SQL store implementer's toolkit: everything a relational backend needs on top of
 * {@link store-kit!} — the schema stamp, the money routines the database must install and prove,
 * the transient-conflict retry, and the row decoders both shipped engines share.
 *
 * @module sql-kit
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the Store
 *   port every implementation answers to.
 */

// --- The schema stamp -------------------------------------------------------------

/**
 * The schema version this build expects. A SQL backend seeds it into `schema_meta` and asserts
 * it back at open, so a database that drifted from the code is refused rather than served.
 */
export { SCHEMA_VERSION } from '#src/schema.ts';

/** Throws unless the database's `schema_meta` value matches {@link SCHEMA_VERSION}. */
export { assertSchemaCurrent } from '#src/schema.ts';

/** Throws unless the live database passed the money conformance vectors at boot. */
export { assertMoneyConformant } from '#src/schema.ts';

/**
 * The error a failed `schema_meta` read raises when the cause is not a missing table. Only a
 * missing table means un-migrated, and telling an operator to re-apply a schema against a
 * database that cannot be reached is advice that can cost data.
 */
export { unreachableDatabase } from '#src/schema.ts';

// --- The money routines the database itself runs ----------------------------------

/**
 * The version of the money routines this build installs, stamped into the database's own meta
 * table. {@link installMysql} writes it last, so a database carrying it has the routines it names;
 * {@link provePostgres} and {@link proveMysql} refuse a database carrying any other value.
 */
export { DB_VERSION } from '#src/money-sql.ts';

/**
 * Installs the money functions into a Postgres database. Idempotent, so a redeploy or a
 * second process re-running it changes nothing.
 */
export { installPostgres } from '#src/money-sql.ts';

/**
 * The MySQL counterpart to {@link installPostgres}. MySQL has no CREATE OR REPLACE for a stored
 * function, so an upgrade drops before it creates; against a database already stamped at
 * {@link DB_VERSION} nothing is dropped, and a caller of the routines sees no window where they
 * are missing.
 */
export { installMysql } from '#src/money-sql.ts';

/**
 * Runs the conformance vectors against a Postgres database's installed money functions and
 * returns the failures. An empty list is the only result a store may open on.
 */
export { provePostgres } from '#src/money-sql.ts';

/** The MySQL counterpart to {@link provePostgres}. */
export { proveMysql } from '#src/money-sql.ts';

/** The pinned vectors {@link provePostgres} and {@link proveMysql} check the database against. */
export { vectors } from '#src/money-arithmetic.ts';

/** The one-statement runner the install and prove functions call. */
export type { SqlRunner } from '#src/money-sql.ts';

// --- Contention, retry, and telemetry ---------------------------------------------

export {
  CHAIN_CONTINUITY_MARKER,
  CHAIN_FORK_INDEX,
  DEFAULT_CONNECT_TIMEOUT_MS,
  ENGINE_METRICS,
  installMoneyRetrying,
  poolErrorReporter,
  retryTelemetry,
  setRetryObserver,
  withTransientRetry,
} from '#src/engines/sql-shared.ts';

export type {
  EncodedLeg,
  EngineOpenShape,
  IsTransientConflict,
  Link,
  RetryEvent,
  RetryObserver,
} from '#src/engines/sql-shared.ts';

/**
 * Spells an Operation for the inbox `operation` column, the write half of what {@link rowToInbox}
 * reads back. It lives beside the field table on {@link contract!} and is offered here too
 * because both shipped engines reach it through this toolkit.
 */
export { encodeOperation } from '#src/wire-contract.ts';

/** What {@link encodeOperation} produces: an Operation as a JSON column holds it. */
export type { EncodedOperation } from '#src/wire-contract.ts';

// --- Chain, account, and row helpers ----------------------------------------------

export {
  KnownAccounts,
  StagedAccounts,
  TxHeads,
  advanceCapturedHeads,
  chainLinksFor,
  decodeLegs,
  defaultDigest,
  distinctAccounts,
  encodeLegs,
  endOwnedPool,
  isSeededSystemAccount,
  naturalDelta,
  parseJson,
  readMinor,
  rowToAccrual,
  rowToCheckpoint,
  rowToInbox,
  rowToOutbox,
  rowToPromoGrant,
  rowToSaga,
  rowToSale,
  rowToSubscription,
  sortByAccountId,
} from '#src/engines/sql-shared.ts';

// --- The shared stored-routine calling convention ---------------------------------

export {
  callFunction,
  callProcedure,
  postEntryArgs,
  safeSqlIdentifier,
} from '#src/engines/sql-routines.ts';

export type {
  PostEntryArgs,
  SqlDialect,
  SqlQuery,
} from '#src/engines/sql-routines.ts';
