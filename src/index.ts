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

import { createEconomy } from '#src/economy.ts';
import { loadConfig } from '#src/config.ts';
import { assertMoneyConformant, assertSchemaCurrent } from '#src/schema.ts';
import { installMysql, proveMysql } from '#src/db.vendored.ts';
import { vectors as moneyVectors } from '#src/money.vendored.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { createWorker } from '#src/worker/index.ts';
import { jsonlLogger } from '#src/runtime.ts';
import { sha256Digest } from '#src/digest.ts';
import { fault, ERROR_CODES } from '#src/errors.ts';

import type { Economy } from '#src/economy.ts';
import type { FeePolicy, WorkerCtx } from '#src/contract.ts';
import type { Worker } from '#src/worker/index.ts';
import type {
  Cache,
  Capabilities,
  Clock,
  Digest,
  Dispatcher,
  Ids,
  Logger,
  Meter,
  Processor,
  Rates,
  Signer,
  Store,
} from '#src/ports.ts';

// --- Public surface (re-exports only) ---------------------------------------------

export { createEconomy } from '#src/economy.ts';
// memoryStore: the in-memory backend, with no database.
export { memoryStore } from '#src/adapters/memory.ts';
// memoryCache: in-process read-through cache, the zero-infra counterpart to the Redis adapter.
export { memoryCache } from '#src/adapters/memory-cache.ts';

export { createWorker } from '#src/worker/index.ts';

// Account-naming helpers: spendable/earned/promo/currency build account ids, and SYSTEM holds the
// platform's own (a user account id looks like `usr_...:<kind>`).
export { spendable, earned, promo, currency, SYSTEM } from '#src/accounts.ts';

// Money and leg construction. Amount is branded, so these are the only doors: decodeAmount parses a
// decimal string exactly (a third decimal digit throws), encodeAmount is its inverse for display and
// wire use, and credit/debit build correctly-signed legs.
export { decodeAmount, encodeAmount } from '#src/money.ts';
export { credit, debit } from '#src/ledger.ts';
export type { Leg } from '#src/ports.ts';

export { loadConfig } from '#src/config.ts';

// Opt-in, host-level extensions: a netting session a host opens over the store (src/netting.ts) and
// the entitlement-bitset decorator a host wraps around it (src/adapters/entitlement-bitset.ts). The
// core submit pipeline never touches either.
export {
  createReservations,
  instanceSession,
  recoverSession,
} from '#src/netting.ts';
export type {
  MovementOutcome,
  MovementRequest,
  Reservations,
  SessionOptions,
  SettleReport,
} from '#src/netting.ts';
export { cachedEntitlements } from '#src/adapters/entitlement-bitset.ts';
export type { BitsetOptions } from '#src/adapters/entitlement-bitset.ts';

// The error surface: EconomyError for instanceof, the ERROR_CODES catalog to match on, and the
// code/reason unions to type its handling.
export { EconomyError, ERROR_CODES } from '#src/errors.ts';
export type { ErrorCode, RejectionCode } from '#src/errors.ts';

export type { Economy } from '#src/economy.ts';
export type { Worker } from '#src/worker/index.ts';
export type { WorkerCtx } from '#src/contract.ts';
export type { Config } from '#src/config.ts';
export type {
  Operation,
  Outcome,
  Transaction,
  Principal,
  Recipient,
  EntitlementAttrs,
  FeePolicy,
  ProveReport,
} from '#src/contract.ts';
export type { Amount, Currency } from '#src/money.ts';
export type { AccountRef } from '#src/accounts.ts';
export type { Capabilities, Options, Range, Statement } from '#src/ports.ts';

// --- Composition from env ---------------------------------------------------------
//
// src/engines/ are the systems of record that enforce ledger invariants natively (Postgres, MySQL),
// and src/adapters/ are everything pluggable that does not. See
// https://economy-lab-docs.pages.dev/economy/ports/storage/
// for how every adapter meets one contract and the SQL engines also enforce it in the database.

/**
 * External services with no built-in stand-in: `pricing` splits a sale's money (platform fee vs.
 * seller share), `processor` is the payout provider, `signer` holds the signing key, and `rates`
 * supplies CREDIT-to-USD rates.
 */
export type ExternalPorts = {
  signer: Signer;

  processor: Processor;

  rates: Rates;

  pricing: FeePolicy;
};

/**
 * Runtime services {@link capabilitiesFromEnv} fills in; pass any to override, e.g. a fixed clock
 * for reproducible tests.
 */
export type RuntimeDefaults = {
  clock?: Clock;

  ids?: Ids;

  digest?: Digest;

  logger?: Logger;

  meter?: Meter;
};

/**
 * Assembles the full {@link Capabilities} bundle from `env`: the Store (chosen by `DATABASE_URL`),
 * an optional cache and dispatcher, the external `ports`, and default runtime services unless
 * overridden. Drivers import only when selected; config is read once and fails fast with one
 * combined `CONFIG.INVALID`.
 *
 * {@link compose} and {@link composeWorker} both build from it. A single-process host that wants
 * both over one store calls it once.
 */
export async function capabilitiesFromEnv(
  env: Record<string, string | undefined>,
  ports: ExternalPorts,
  defaults: RuntimeDefaults = {},
): Promise<Capabilities> {
  const config = loadConfig(env);
  const clock = defaults.clock ?? wallClock();
  const digest = defaults.digest ?? sha256Digest();
  const cache = await selectCache(env);
  const dispatcher = await selectDispatcher(env);
  return {
    store: await selectStore(env, {
      digest,
      clock,
      velocityWindowMs: config.velocityWindowMs,
    }),
    clock,
    ids: defaults.ids ?? uuidIds(),
    digest,
    signer: ports.signer,
    processor: ports.processor,
    rates: ports.rates,
    logger: defaults.logger ?? jsonlLogger(),
    meter: defaults.meter ?? noopMeter(),
    pricing: ports.pricing,
    config,
    ...(cache === undefined ? {} : { cache }),
    ...(dispatcher === undefined ? {} : { dispatcher }),
  };
}

/**
 * Derives a worker context from a capability bundle: the runtime services a background pass needs,
 * minus the request-path-only pieces (pricing, cache, dispatcher).
 */
export function workerCtxFrom(caps: Capabilities): WorkerCtx {
  return {
    clock: caps.clock,
    ids: caps.ids,
    digest: caps.digest,
    signer: caps.signer,
    processor: caps.processor,
    rates: caps.rates,
    logger: caps.logger,
    meter: caps.meter,
    config: caps.config,
  };
}

/**
 * Wires an {@link Economy} whose store, cache, and dispatcher come from `env`, falling back to the
 * in-memory store when `DATABASE_URL` is unset. Thin over {@link capabilitiesFromEnv}.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for
 *   composing an economy from env.
 */
export async function compose(
  env: Record<string, string | undefined>,
  ports: ExternalPorts,
  defaults: RuntimeDefaults = {},
): Promise<Economy> {
  return createEconomy(await capabilitiesFromEnv(env, ports, defaults));
}

/**
 * Wires a background {@link Worker} for the deferred, time-driven work over the same env-selected
 * store and dispatcher as {@link compose}. Two processes each call this with their own store handle;
 * a single process that shares one store calls {@link capabilitiesFromEnv} once instead — required
 * for the in-memory backend, where two stores are two separate maps.
 */
export async function composeWorker(
  env: Record<string, string | undefined>,
  ports: ExternalPorts,
  defaults: RuntimeDefaults = {},
): Promise<{
  worker: Worker;
  store: Store;
  dispatcher: Dispatcher | undefined;
}> {
  const caps = await capabilitiesFromEnv(env, ports, defaults);
  return {
    worker: createWorker(caps.store, workerCtxFrom(caps)),
    store: caps.store,
    dispatcher: caps.dispatcher,
  };
}

// --- Default runtime services -----------------------------------------------------

// Wall-clock time in epoch milliseconds; pass your own clock for reproducible timing.
function wallClock(): Clock {
  return { now: () => Date.now() };
}

// Ids of the form `${prefix}_${uuid}` via crypto.randomUUID.
function uuidIds(): Ids {
  return { next: (prefix) => `${prefix}_${crypto.randomUUID()}` };
}

// Discards every metric, so code can always record with no host-supplied meter.
function noopMeter(): Meter {
  return { count: () => {}, observe: () => {} };
}

// `DATABASE_URL` picks the backend: a `postgres://` or `mysql://` connection string selects that
// engine and only then loads its driver; unset uses the in-memory store, and any other scheme throws.
async function selectStore(
  env: Record<string, string | undefined>,
  deps: { digest: Digest; clock: Clock; velocityWindowMs: number },
): Promise<Store> {
  const url = env.DATABASE_URL;
  if (url === undefined || url === '') {
    return memoryStore(deps);
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { postgresStore } = await import('#src/engines/postgres.ts');
    return postgresStore({
      url,
      digest: deps.digest,
      clock: deps.clock,
      velocityWindowMs: deps.velocityWindowMs,
    });
  }
  if (url.startsWith('mysql://')) {
    const { createMysqlPool, mysqlStore, readSchemaVersion } =
      await import('#src/engines/mysql.ts');
    // Build the pool via the engine's helper, which sets supportBigNumbers and bigNumberStrings — raw
    // `mysql2` leaves those off and would silently round any amount above 2^53.
    const pool = await createMysqlPool(url);
    // Fail fast if the schema has drifted from this code (postgresStore does the same in its branch).
    assertSchemaCurrent(await readSchemaVersion(pool), 'MySQL');
    // Install the vendored money functions (idempotent) and prove this engine computes the pinned
    // arithmetic before any posting trusts it.
    const runner = {
      run: (sql: string, params?: readonly unknown[]) =>
        pool
          .query(sql, params ? [...params] : undefined)
          .then(([rows]) => rows as Record<string, unknown>[]),
    };
    await installMysql(runner);
    assertMoneyConformant(await proveMysql(runner, moneyVectors), 'MySQL');
    return mysqlStore({
      pool,
      digest: deps.digest,
      clock: deps.clock,
      velocityWindowMs: deps.velocityWindowMs,
    });
  }
  throw fault(
    ERROR_CODES.CONFIG_INVALID,
    'DATABASE_URL must be a postgres:// or mysql:// DSN.',
    { detail: { scheme: url.split(':')[0] } },
  );
}

// `REDIS_URL` adds a Redis-backed cache (ioredis) the store consults before the database, filling
// on a miss. Unset means no cache: every cache read does nothing.
async function selectCache(
  env: Record<string, string | undefined>,
): Promise<Cache | undefined> {
  const url = env.REDIS_URL;
  if (url === undefined || url === '') {
    return undefined;
  }
  const { redisCacheFrom } = await import('#src/adapters/redis.ts');
  // ioredis' default export is the client constructor at runtime; the cast pins it to the
  // adapter's minimal RedisClient surface (its module types don't expose the construct signature).
  const Redis = (await import('ioredis')).default as unknown as {
    new (connection: string): Parameters<typeof redisCacheFrom>[0];
  };
  return redisCacheFrom(new Redis(url));
}

// Picks how outgoing events get delivered, from env. Events are first written to the database
// alongside the money move; the returned dispatcher ships them out. `SQS_QUEUE_URL` sends via an
// Amazon SQS queue; otherwise `DISPATCHER_URL` posts over HTTP; with neither set, returns nothing
// and events are delivered in-process. SQS wins if both are set. Each driver loads on demand.
async function selectDispatcher(
  env: Record<string, string | undefined>,
): Promise<Dispatcher | undefined> {
  const queueUrl = env.SQS_QUEUE_URL;
  if (queueUrl !== undefined && queueUrl !== '') {
    const { SQSClient, SendMessageCommand } =
      await import('@aws-sdk/client-sqs');
    const { sqsDispatcher } = await import('#src/adapters/sqs.ts');
    const raw = new SQSClient({});
    // The adapter speaks an SDK-free `{ input }` command so it stays testable without
    // @aws-sdk/client-sqs; translate it into a real `SendMessageCommand` here, the one place that
    // imports the SDK.
    return sqsDispatcher({
      queueUrl,
      client: {
        send: async (command, options) => {
          await raw.send(
            new SendMessageCommand(
              command.input as unknown as ConstructorParameters<
                typeof SendMessageCommand
              >[0],
            ),
            options,
          );
          return {};
        },
      },
    });
  }
  const dispatcherUrl = env.DISPATCHER_URL;
  if (dispatcherUrl !== undefined && dispatcherUrl !== '') {
    const { httpDispatcher } = await import('#src/adapters/http-dispatcher.ts');
    return httpDispatcher({ url: dispatcherUrl });
  }
  return undefined;
}
