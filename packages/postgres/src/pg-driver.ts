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

import { DEFAULT_CONNECT_TIMEOUT_MS } from '@pwngh/economy-lab/sql-kit';

// The one typed doorway to the untyped `pg` driver. `pg` ships no type declarations and the repo
// disables auto-loaded @types, so consumers import these structural types instead of re-declaring
// their own. The driver loads on demand, so depending on these types never pulls `pg` into a
// process that didn't select it.

/** The pool surface the lab uses. It covers parameterized query, the error listener, and teardown. */
export interface PgPoolLike {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}

/** The single-connection surface, for one-shot administrative work. */
export interface PgClientLike {
  connect(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export interface PgPoolConfig {
  connectionString: string;
  max?: number;
  /**
   * Max wait (ms) for a connection. Unset takes the engine default rather than `pg`'s own "wait
   * forever", so a routable-but-stalled host cannot hang the open. Pass 0 to keep it unbounded.
   */
  connectionTimeoutMillis?: number;
  /** Startup parameter string (e.g. `-c search_path=...`), applied to every connection. */
  options?: string;
}

interface PgModule {
  Pool: new (config: PgPoolConfig) => PgPoolLike;
  Client: new (config: { connectionString: string }) => PgClientLike;
}

export async function loadPg(): Promise<PgModule> {
  // @ts-expect-error -- `pg` ships no type declarations. This cast types it here, once, for the whole repo.
  return (await import('pg')).default as PgModule;
}

/**
 * Opens a pool with the error listener every consumer must attach. A dropped idle connection
 * emits 'error' on the pool, and an unlistened 'error' event would crash the process. `onError`
 * receives that error; without one it goes out as a process warning, never nowhere. The connect
 * wait takes the engine default when the config names none, matching the store's own pool.
 */
export async function openPgPool(
  config: PgPoolConfig,
  onError?: (error: unknown) => void,
): Promise<PgPoolLike> {
  const pg = await loadPg();
  const pool = new pg.Pool({
    ...config,
    connectionTimeoutMillis:
      config.connectionTimeoutMillis ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });
  pool.on('error', onError ?? warnPoolError);
  return pool;
}

// Reports a pool error no caller named a handler for. A warning reaches stderr and
// `process.on('warning')`, and unlike the unlistened event it does not end the process.
function warnPoolError(error: unknown): void {
  process.emitWarning(
    error instanceof Error ? error : new Error(String(error)),
  );
}
