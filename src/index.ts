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
import { memoryStore } from '#src/adapters/memory.ts';
import { createWorker } from '#src/worker/index.ts';
import { jsonlLogger } from '#src/runtime.ts';
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

// createEconomy: builds an economy from its services. memoryStore: in-memory backend, runs with no database.
export { createEconomy } from '#src/economy.ts';
export { memoryStore } from '#src/adapters/memory.ts';

// createWorker builds the background sweep loop from a store + worker context.
export { createWorker } from '#src/worker/index.ts';

// Account-naming helpers. spendable/earned/promo/currency build account ids; SYSTEM holds the
// platform's own accounts. Lets a host refer to an account without hand-writing the id string
// (a user account id looks like `usr_…:<kind>`).
export { spendable, earned, promo, currency, SYSTEM } from '#src/accounts.ts';

// loadConfig reads and validates settings from env vars; Config is the resulting settings object.
export { loadConfig } from '#src/config.ts';

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
// The layers this composes from, since the directory split only half-expresses them:
//   - src/engines/  — the systems of record that enforce the ledger invariants natively (Postgres,
//                     MySQL). The database is not an adapter; it is the source of truth.
//   - src/adapters/ — everything pluggable that does not enforce invariants: the in-memory and HTTP
//                     stores (records too, but the zero-infra / in-process transports), plus the
//                     genuine capabilities you don't own — Redis cache, SQS or HTTP dispatcher, payout
//                     processor, FX rates.

/**
 * External services with no built-in stand-in; the caller supplies a real one. `pricing` splits
 * a sale's money (platform fee vs. seller share). The rest are outside integrations: `processor`
 * is the payout provider (Tilia/Steam), `signer` holds the signing key, `rates` supplies
 * currency-exchange rates.
 */
export type ExternalPorts = {
  signer: Signer;

  processor: Processor;

  rates: Rates;

  pricing: FeePolicy;
};

/**
 * Runtime services {@link capabilitiesFromEnv} fills in from web-standard primitives. Pass any to
 * override the default, e.g. a fixed clock and counting id generator for reproducible test output.
 */
export type RuntimeDefaults = {
  clock?: Clock;

  ids?: Ids;

  digest?: Digest;

  logger?: Logger;

  meter?: Meter;
};

/**
 * Assemble the full {@link Capabilities} bundle from `env`: the Store (Postgres/MySQL/in-memory,
 * chosen by `DATABASE_URL`), an optional Redis cache and SQS/HTTP dispatcher, the external `ports`,
 * and default runtime services (wall clock, uuid ids, SHA-256, jsonl logger, no-op metrics) unless
 * overridden in `defaults`. Each driver is imported dynamically (only if selected), so a deployment
 * installs only what it uses. Config is read once and fails fast on a bad env with one combined
 * `CONFIG.INVALID`.
 *
 * This is the one place env becomes capabilities. {@link compose} builds an economy from it;
 * {@link composeWorker} builds a worker. A single-process host that wants both over one store calls
 * it once and passes the result to `createEconomy` and `createWorker(caps.store, workerCtxFrom(caps))`.
 */
export async function capabilitiesFromEnv(
  env: Record<string, string | undefined>,
  ports: ExternalPorts,
  defaults: RuntimeDefaults = {},
): Promise<Capabilities> {
  let config = loadConfig(env);
  let clock = defaults.clock ?? wallClock();
  let digest = defaults.digest ?? subtleDigest();
  let cache = await selectCache(env);
  let dispatcher = await selectDispatcher(env);
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
 * Derive a worker context from a capability bundle: the runtime services a background pass needs,
 * minus the request-path-only pieces (no pricing rule — each sweep writes its own balanced legs —
 * and no cache/dispatcher, which the worker takes separately). Lets one process build an economy
 * and a worker over the exact same store and clock.
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
 * Wire an {@link Economy} whose Store (and optional Redis cache / SQS dispatcher) are chosen from
 * `env`, falling back to the in-memory store when `DATABASE_URL` is unset. Thin over
 * {@link capabilitiesFromEnv}.
 */
export async function compose(
  env: Record<string, string | undefined>,
  ports: ExternalPorts,
  defaults: RuntimeDefaults = {},
): Promise<Economy> {
  return createEconomy(await capabilitiesFromEnv(env, ports, defaults));
}

/**
 * Wire a background {@link Worker}: the loop that periodically does deferred, time-driven work
 * (releasing payouts, renewing subscriptions, expiring promo grants, delivering queued events,
 * writing integrity checkpoints, etc.) over the same env-selected store and dispatcher as
 * {@link compose}. Returns the worker plus store and dispatcher, so a host can call
 * `worker.runOnce(input)` on a timer and pass the dispatcher into each run's input.
 *
 * Two processes on the same database each call this (and {@link compose}) with their own store
 * handle. For a single process sharing one store — required for the in-memory backend, where two
 * stores are two separate maps — call {@link capabilitiesFromEnv} once instead (see its note).
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
  let caps = await capabilitiesFromEnv(env, ports, defaults);
  return {
    worker: createWorker(caps.store, workerCtxFrom(caps)),
    store: caps.store,
    dispatcher: caps.dispatcher,
  };
}

// --- Default runtime services -----------------------------------------------------

// Wall-clock time in epoch milliseconds. Pass your own clock for reproducible timing (e.g. tests).
function wallClock(): Clock {
  return { now: () => Date.now() };
}

// Ids of the form `${prefix}_${uuid}` via crypto.randomUUID, no Node-specific module.
function uuidIds(): Ids {
  return { next: (prefix) => `${prefix}_${crypto.randomUUID()}` };
}

// SHA-256 via crypto.subtle. Same hash the in-memory store defaults to; identical result on every runtime.
function subtleDigest(): Digest {
  return {
    hash: async (bytes) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  };
}

// Metrics sink that discards everything, so code can always record metrics with no host-supplied one.
function noopMeter(): Meter {
  return { count: () => {}, observe: () => {} };
}

// `DATABASE_URL` picks the storage backend: a `postgres://` or `mysql://` DSN selects that engine
// (and only then loads its driver); unset uses the in-memory store. Any other scheme throws here.
async function selectStore(
  env: Record<string, string | undefined>,
  deps: { digest: Digest; clock: Clock; velocityWindowMs: number },
): Promise<Store> {
  let url = env.DATABASE_URL;
  if (url === undefined || url === '') {
    return memoryStore(deps);
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    let { postgresStore } = await import('#src/engines/postgres.ts');
    return postgresStore({
      url,
      digest: deps.digest,
      clock: deps.clock,
      velocityWindowMs: deps.velocityWindowMs,
    });
  }
  if (url.startsWith('mysql://')) {
    let { createMysqlPool, mysqlStore } = await import('#src/engines/mysql.ts');
    // Build the pool via the engine's helper, which sets supportBigNumbers + bigNumberStrings so a
    // BIGINT money column comes back as a string (then a bigint), not a lossy JS number. Raw `mysql2`
    // `createPool` leaves those off, so wiring it directly would silently round any amount above
    // 2^53 (~9 quadrillion) — the same createMysqlPool the engine's conformance and adversarial tests use.
    let pool = await createMysqlPool(url);
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
  let url = env.REDIS_URL;
  if (url === undefined || url === '') {
    return undefined;
  }
  let { redisCacheFrom } = await import('#src/adapters/redis.ts');
  // ioredis' default export is the client constructor at runtime; the cast pins it to the
  // adapter's minimal RedisClient surface (its module types don't expose the construct signature).
  let Redis = (await import('ioredis')).default as unknown as {
    new (connection: string): Parameters<typeof redisCacheFrom>[0];
  };
  return redisCacheFrom(new Redis(url));
}

// Picks how outgoing events get delivered, from env. Events are first written to the database
// alongside the money move; the returned dispatcher ships them out. `SQS_QUEUE_URL` sends via an
// Amazon SQS queue; else `DISPATCHER_URL` posts over HTTP; with neither, returns nothing and events
// are delivered in-process. SQS wins if both are set. Each driver loads on demand. The worker's
// delivery loop reads from whichever dispatcher this returns.
async function selectDispatcher(
  env: Record<string, string | undefined>,
): Promise<Dispatcher | undefined> {
  let queueUrl = env.SQS_QUEUE_URL;
  if (queueUrl !== undefined && queueUrl !== '') {
    let { SQSClient } = await import('@aws-sdk/client-sqs');
    let { sqsDispatcher } = await import('#src/adapters/sqs.ts');
    return sqsDispatcher({ queueUrl, client: new SQSClient({}) });
  }
  let dispatcherUrl = env.DISPATCHER_URL;
  if (dispatcherUrl !== undefined && dispatcherUrl !== '') {
    let { httpDispatcher } = await import('#src/adapters/http-dispatcher.ts');
    return httpDispatcher({ url: dispatcherUrl });
  }
  return undefined;
}
