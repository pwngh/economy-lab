/// <reference types="node" />
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

// Wire-trial driver shim: postgres.js mounted behind the PgPool seam in place of pg. Installed
// with `npm install --no-save postgres`; the dynamic specifier import keeps it out of type
// resolution, so the repo builds without the package and only a process that selects the trial
// driver loads it.

import type { PgPool } from '#src/engines/postgres.ts';

// Only the slice of postgres.js the shim calls. `unsafe` runs parameterized text ($n
// placeholders) and, without parameters, whole multi-statement scripts; `reserve` checks out one
// connection for a transaction's lifetime.
type PgJsResult = Array<Record<string, unknown>> & { count: number };
interface PgJsReserved {
  unsafe(text: string, params?: unknown[]): Promise<PgJsResult>;
  release(): void;
}
interface PgJsSql {
  unsafe(text: string, params?: unknown[]): Promise<PgJsResult>;
  reserve(): Promise<PgJsReserved>;
  end(options?: { timeout?: number }): Promise<void>;
}

/**
 * A {@link PgPool} whose wire protocol is postgres.js instead of pg. Mirrors the engine's pg
 * configuration: int8 and numeric columns as exact BigInt, search_path pinned per connection
 * when a schema name is given, undefined parameters as NULL (pg's behavior; postgres.js refuses
 * them raw).
 */
export async function postgresJsPool(options: {
  url: string;
  schemaName?: string;
  max?: number;
  connectionTimeoutMillis?: number;
}): Promise<PgPool> {
  const specifier = 'postgres';
  const { default: postgres } = (await import(
    /* @vite-ignore */ specifier
  )) as unknown as {
    default: (url: string, opts: Record<string, unknown>) => PgJsSql;
  };
  const asBigInt = {
    to: 20,
    from: [20],
    serialize: (value: unknown) => String(value),
    parse: (value: string) => BigInt(value),
  };
  const sql = postgres(options.url, {
    max: options.max ?? 10,
    ...(options.connectionTimeoutMillis
      ? { connect_timeout: Math.ceil(options.connectionTimeoutMillis / 1000) }
      : {}),
    ...(options.schemaName
      ? { connection: { search_path: options.schemaName } }
      : {}),
    onnotice: () => {},
    types: {
      bigint: asBigInt,
      numeric: { ...asBigInt, to: 1700, from: [1700] },
      // pg sends a string bound to a json/jsonb parameter as raw text the server parses;
      // postgres.js's default serializer would JSON-encode it into a scalar string. Match pg
      // on both directions (json columns parse to objects there too).
      json: {
        to: 114,
        from: [114, 3802],
        serialize: (value: unknown) =>
          typeof value === 'string' ? value : JSON.stringify(value),
        parse: (value: string) => JSON.parse(value) as unknown,
      },
    },
  });
  const params = (values?: readonly unknown[]): unknown[] | undefined =>
    values === undefined
      ? undefined
      : values.map((value) => (value === undefined ? null : value));
  const result = (r: PgJsResult) => ({
    rows: r as Array<Record<string, unknown>>,
    rowCount: r.count,
  });
  return {
    query: async (text, values) =>
      result(await sql.unsafe(text, params(values))),
    connect: async () => {
      const reserved = await sql.reserve();
      return {
        query: async (text, values) =>
          result(await reserved.unsafe(text, params(values))),
        release: () => {
          reserved.release();
        },
      };
    },
    end: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
