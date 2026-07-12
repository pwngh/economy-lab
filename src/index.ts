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
import { isMysqlUrl, isPostgresUrl, readUrl, serviceUrls } from '#src/env.ts';

import type { EnvMap } from '#src/env.ts';
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
export { memoryStore } from '#src/adapters/memory.ts';
export { memoryCache } from '#src/adapters/memory-cache.ts';

export { createWorker } from '#src/worker/index.ts';

export { spendable, earned, promo, currency, SYSTEM } from '#src/accounts.ts';

export { decodeAmount, encodeAmount } from '#src/money.ts';
export { credit, debit } from '#src/ledger.ts';
export type { Leg } from '#src/ports.ts';

export { loadConfig } from '#src/config.ts';

// Opt-in, host-level extensions; the core submit pipeline never touches either.
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

export { EconomyError, ERROR_CODES } from '#src/errors.ts';
export type { ErrorCode, RejectionCode } from '#src/errors.ts';

export type { Economy } from '#src/economy.ts';
export type { Worker } from '#src/worker/index.ts';
export type { WorkerCtx } from '#src/contract.ts';
export type { Config } from '#src/config.ts';
// The env-map shape every composition entry point takes; parsing rules live in src/env.ts.
export type { EnvMap } from '#src/env.ts';
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
 * Which concrete adapter each env knob picks, before any driver loads. This is the ONE reading of
 * the selection: the selectors below consume it to do the wiring, and hosts print it (the startup
 * `config.resolved` line, the compose demo's labels), so a displayed selection can never diverge
 * from the wired one. `url` is the raw connection string — mask it before printing.
 */
export interface Selection {
  store:
    | { kind: 'memory'; url: null }
    | { kind: 'postgres' | 'mysql' | 'unsupported'; url: string };
  cache: { kind: 'none'; url: null } | { kind: 'redis'; url: string };
  dispatcher:
    | { kind: 'in-process'; url: null }
    | { kind: 'sqs' | 'http'; url: string };
}

/**
 * Reads the selection from env: `DATABASE_URL` picks the store by scheme (unset = in-memory,
 * `postgres://`/`mysql://` = that engine, anything else = 'unsupported', which selectStore
 * rejects); `REDIS_URL` adds the cache; `SQS_QUEUE_URL` beats `DISPATCHER_URL` for delivery,
 * neither = in-process. All through the shared resolver rules (src/env.ts).
 */
export function describeSelection(env: EnvMap): Selection {
  const db = readUrl(env.DATABASE_URL);
  const services = serviceUrls(env);
  return {
    store:
      db === null
        ? { kind: 'memory', url: null }
        : {
            kind: isPostgresUrl(db)
              ? 'postgres'
              : isMysqlUrl(db)
                ? 'mysql'
                : 'unsupported',
            url: db,
          },
    cache:
      services.redis === null
        ? { kind: 'none', url: null }
        : { kind: 'redis', url: services.redis },
    dispatcher:
      services.sqs !== null
        ? { kind: 'sqs', url: services.sqs }
        : services.dispatcher !== null
          ? { kind: 'http', url: services.dispatcher }
          : { kind: 'in-process', url: null },
  };
}

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
  env: EnvMap,
  ports: ExternalPorts,
  defaults: RuntimeDefaults = {},
): Promise<Capabilities> {
  const config = loadConfig(env);
  const runtime = runtimeFrom(defaults);
  const selection = describeSelection(env);
  const [store, cache, dispatcher] = await Promise.all([
    selectStore(selection.store, {
      digest: runtime.digest,
      clock: runtime.clock,
      velocityWindowMs: config.velocityWindowMs,
    }),
    selectCache(selection.cache),
    selectDispatcher(selection.dispatcher),
  ]);
  return {
    ...runtime,
    ...ports,
    config,
    store,
    ...(cache && { cache }),
    ...(dispatcher && { dispatcher }),
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
  env: EnvMap,
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
  env: EnvMap,
  ports: ExternalPorts,
  defaults: RuntimeDefaults = {},
): Promise<ComposedWorker> {
  const caps = await capabilitiesFromEnv(env, ports, defaults);
  return {
    worker: createWorker(caps.store, workerCtxFrom(caps)),
    store: caps.store,
    dispatcher: caps.dispatcher,
  };
}

/** What {@link composeWorker} returns: the worker plus the handles its host must manage — the
 * store to close on shutdown and the env-selected dispatcher the relay delivers through. */
export type ComposedWorker = {
  worker: Worker;
  store: Store;
  dispatcher: Dispatcher | undefined;
};

// --- The wiring (drivers import here, only when selected) ---------------------------

async function selectStore(
  selection: Selection['store'],
  deps: { digest: Digest; clock: Clock; velocityWindowMs: number },
): Promise<Store> {
  if (selection.kind === 'memory') {
    return memoryStore(deps);
  }
  if (selection.kind === 'postgres') {
    const { postgresStore } = await import('#src/engines/postgres.ts');
    return postgresStore({
      url: selection.url,
      digest: deps.digest,
      clock: deps.clock,
      velocityWindowMs: deps.velocityWindowMs,
    });
  }
  if (selection.kind === 'mysql') {
    return provenMysqlStore(selection.url, deps);
  }
  throw fault(
    ERROR_CODES.CONFIG_INVALID,
    'DATABASE_URL must be a postgres:// or mysql:// DSN.',
    { detail: { scheme: selection.url.split(':')[0] } },
  );
}

// MySQL startup: pool, schema-version gate, then install-and-prove the vendored money functions
// before any posting trusts the engine's arithmetic.
async function provenMysqlStore(
  url: string,
  deps: { digest: Digest; clock: Clock; velocityWindowMs: number },
): Promise<Store> {
  const { createMysqlPool, mysqlStore, readSchemaVersion } =
    await import('#src/engines/mysql.ts');
  const pool = await createMysqlPool(url);
  assertSchemaCurrent(await readSchemaVersion(pool), 'MySQL');
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

async function selectCache(
  selection: Selection['cache'],
): Promise<Cache | undefined> {
  if (selection.kind === 'none') {
    return undefined;
  }
  const url = selection.url;
  const { redisCacheFrom } = await import('#src/adapters/redis.ts');
  // ioredis' default export is the client constructor at runtime; the cast pins it to the
  // adapter's minimal RedisClient surface (its module types don't expose the construct signature).
  const Redis = (await import('ioredis')).default as unknown as {
    new (connection: string): Parameters<typeof redisCacheFrom>[0];
  };
  return redisCacheFrom(new Redis(url));
}

async function selectDispatcher(
  selection: Selection['dispatcher'],
): Promise<Dispatcher | undefined> {
  if (selection.kind === 'in-process') {
    return undefined;
  }
  if (selection.kind === 'sqs') {
    const queueUrl = selection.url;
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
  const { httpDispatcher } = await import('#src/adapters/http-dispatcher.ts');
  return httpDispatcher({ url: selection.url });
}

// --- Default runtime services -----------------------------------------------------

function runtimeFrom(
  defaults: RuntimeDefaults,
): Pick<Capabilities, 'clock' | 'ids' | 'digest' | 'logger' | 'meter'> {
  return {
    clock: defaults.clock ?? wallClock(),
    ids: defaults.ids ?? uuidIds(),
    digest: defaults.digest ?? sha256Digest(),
    logger: defaults.logger ?? jsonlLogger(),
    meter: defaults.meter ?? noopMeter(),
  };
}

function wallClock(): Clock {
  return { now: () => Date.now() };
}

function uuidIds(): Ids {
  return { next: (prefix) => `${prefix}_${crypto.randomUUID()}` };
}

function noopMeter(): Meter {
  return { count: () => {}, observe: () => {} };
}
