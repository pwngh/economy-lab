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

// The one typed doorway to the untyped `pg` driver: `pg` ships no type declarations and the repo
// disables auto-loaded @types, so consumers import these structural types instead of re-declaring
// their own. The driver loads on demand, so depending on these types never pulls `pg` into a
// process that didn't select it.

/** The pool surface the lab uses: parameterized query, the error listener, and teardown. */
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
  connectionTimeoutMillis?: number;
  /** Startup parameter string (e.g. `-c search_path=...`), applied to every connection. */
  options?: string;
}

interface PgModule {
  Pool: new (config: PgPoolConfig) => PgPoolLike;
  Client: new (config: { connectionString: string }) => PgClientLike;
}

export async function loadPg(): Promise<PgModule> {
  // @ts-expect-error -- `pg` ships no type declarations; typed here, once, for the whole repo.
  return (await import('pg')).default as PgModule;
}

/**
 * Opens a pool with the error listener every consumer must attach — a dropped idle connection
 * emits 'error' on the pool, and an unlistened 'error' event would crash the process.
 */
export async function openPgPool(config: PgPoolConfig): Promise<PgPoolLike> {
  const pg = await loadPg();
  const pool = new pg.Pool(config);
  pool.on('error', () => undefined);
  return pool;
}
