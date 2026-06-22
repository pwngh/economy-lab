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

// createEconomy is the main entry point that builds an economy from its services;
// memoryStore is the in-memory storage backend that lets you run one with no database.
export { createEconomy } from '#src/economy.ts';
export { memoryStore } from '#src/adapters/memory.ts';

// Helpers for naming accounts. spendable/earned/promo/currency build account ids, and
// SYSTEM holds the platform's own accounts. A host re-exports these so it can refer to an
// account without hand-writing the id string (a user account id looks like `usr_…:<kind>`).
export { spendable, earned, promo, currency, SYSTEM } from '#src/accounts.ts';

// loadConfig reads settings out of environment variables and validates them; Config is the
// resulting settings object the rest of the library is handed.
export { loadConfig } from '#src/config.ts';

export type { Economy } from '#src/economy.ts';
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

// --- The in-memory composition helper ---------------------------------------------

/**
 * The external services that have no honest in-memory stand-in, so the caller must supply
 * a real one. `pricing` decides how a sale's money is split (platform fee vs. seller share);
 * the rest are outside integrations an adapter owns: `processor` is the payout provider
 * (Tilia/Steam), `signer` holds the signing key, and `rates` supplies currency-exchange rates.
 */
export type InMemoryPorts = {
  signer: Signer;

  processor: Processor;

  rates: Rates;

  pricing: FeePolicy;
};

/**
 * The runtime services {@link composeInMemory} can fill in for you using web-standard
 * browser/runtime primitives. Pass any of these to override the default — for example, a
 * fixed clock and a counting id generator so a test produces the same output every run.
 */
export type InMemoryDefaults = {
  clock?: Clock;

  ids?: Ids;

  digest?: Digest;

  logger?: Logger;

  meter?: Meter;
};

/**
 * Wire up an {@link Economy} backed entirely by the in-memory store — the simplest setup
 * that still runs the real code, useful for tests and demos. It reads settings from `env`,
 * supplies default runtime services (current-time clock, random-id generator, SHA-256 hash,
 * do-nothing logger and metrics), and uses the external services you pass in `ports`.
 * If `env` is misconfigured, this throws at startup with a single combined `CONFIG.INVALID`
 * error rather than failing later inside a request.
 */
export function composeInMemory(
  env: Record<string, string | undefined>,
  ports: InMemoryPorts,
  defaults: InMemoryDefaults = {},
): Economy {
  let config = loadConfig(env);
  let clock = defaults.clock ?? wallClock();
  let digest = defaults.digest ?? subtleDigest();
  let capabilities: Capabilities = {
    store: memoryStore({
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
    logger: defaults.logger ?? noopLogger(),
    meter: defaults.meter ?? noopMeter(),
    pricing: ports.pricing,
    config,
  };
  return createEconomy(capabilities);
}

// --- Default runtime services -----------------------------------------------------

// A clock that reports the current wall-clock time in epoch milliseconds. Pass your own
// clock instead when you need timing to be reproducible (for example, in a test).
function wallClock(): Clock {
  return { now: () => Date.now() };
}

// Generates ids of the form `${prefix}_${uuid}` using the built-in crypto.randomUUID, so
// each id is unique without pulling in any Node-specific module.
function uuidIds(): Ids {
  return { next: (prefix) => `${prefix}_${crypto.randomUUID()}` };
}

// Hashes bytes with SHA-256 using the built-in crypto.subtle. This is the same hash the
// in-memory store uses by default, and it produces the same result on every runtime.
function subtleDigest(): Digest {
  return {
    hash: async (bytes) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  };
}

// A logger that discards everything, so the code can always call the logger even when the
// host hasn't supplied one. Tests pass this explicitly to keep their output clean; the
// production `compose`/`composeWorker` default to the concrete `jsonlLogger` instead, so
// background diagnostics aren't silently dropped.
function noopLogger(): Logger {
  return { log: () => {} };
}

// A metrics sink that discards everything, so the code can always record metrics even when
// the host hasn't supplied one.
function noopMeter(): Meter {
  return { count: () => {}, observe: () => {} };
}

// --- The production composition (selects adapters from env) ------------------------

/**
 * Wire an {@link Economy} whose Store — and optional Redis cache / SQS dispatcher — are chosen
 * from `env`, falling back to the in-memory store when `DATABASE_URL` is unset. Each driver is
 * imported DYNAMICALLY (loaded on demand, only if selected), so a deployment installs only the
 * one it uses: selecting Postgres never pulls in `mysql2` or `@aws-sdk`. Config is read once and
 * fails fast on a bad env, exactly like {@link composeInMemory}.
 */
export async function compose(
  env: Record<string, string | undefined>,
  ports: InMemoryPorts,
  defaults: InMemoryDefaults = {},
): Promise<Economy> {
  let config = loadConfig(env);
  let clock = defaults.clock ?? wallClock();
  let digest = defaults.digest ?? subtleDigest();
  let cache = await selectCache(env);
  let dispatcher = await selectDispatcher(env);
  let capabilities: Capabilities = {
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
  return createEconomy(capabilities);
}

/**
 * Wire a background {@link Worker}: the loop that periodically does the deferred, time-driven
 * work — releasing payouts, renewing subscriptions, expiring promo grants, delivering queued
 * events, writing periodic integrity checkpoints, and so on. It runs over the SAME
 * env-selected store and dispatcher as {@link compose}. Returns the worker plus the store and
 * dispatcher, so a host entry point can call `worker.runOnce(input)` on a timer and pass the
 * dispatcher into each run's input.
 *
 * The worker is given a narrower set of services than a full economy: no pricing rule, because
 * each background pass writes its own debit/credit lines that already balance and so never needs
 * to split a price.
 */
export async function composeWorker(
  env: Record<string, string | undefined>,
  ports: InMemoryPorts,
  defaults: InMemoryDefaults = {},
): Promise<{
  worker: Worker;
  store: Store;
  dispatcher: Dispatcher | undefined;
}> {
  let config = loadConfig(env);
  let clock = defaults.clock ?? wallClock();
  let digest = defaults.digest ?? subtleDigest();
  let store = await selectStore(env, {
    digest,
    clock,
    velocityWindowMs: config.velocityWindowMs,
  });
  let dispatcher = await selectDispatcher(env);
  let ctx: WorkerCtx = {
    clock,
    ids: defaults.ids ?? uuidIds(),
    digest,
    signer: ports.signer,
    processor: ports.processor,
    rates: ports.rates,
    logger: defaults.logger ?? jsonlLogger(),
    meter: defaults.meter ?? noopMeter(),
    config,
  };
  return { worker: createWorker(store, ctx), store, dispatcher };
}

// `DATABASE_URL` picks the storage backend: a connection string starting with `postgres://` or
// `mysql://` selects that database adapter (and only then loads its driver); unset uses the
// in-memory store. Any other scheme throws right here instead of failing later.
async function selectStore(
  env: Record<string, string | undefined>,
  deps: { digest: Digest; clock: Clock; velocityWindowMs: number },
): Promise<Store> {
  let url = env.DATABASE_URL;
  if (url === undefined || url === '') {
    return memoryStore(deps);
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    let { postgresStore } = await import('#src/adapters/postgres.ts');
    return postgresStore({
      url,
      digest: deps.digest,
      clock: deps.clock,
      velocityWindowMs: deps.velocityWindowMs,
    });
  }
  if (url.startsWith('mysql://')) {
    let { createMysqlPool, mysqlStore } =
      await import('#src/adapters/mysql.ts');
    // Build the pool through the adapter's helper, which sets supportBigNumbers + bigNumberStrings
    // so a BIGINT money column comes back as a string (then a bigint), not a lossy JS number. The
    // raw `mysql2` `createPool` leaves those off, so wiring it directly here would silently round
    // any amount above what a JS number can represent exactly (about 9 quadrillion, 2 to the 53rd
    // power). This is the same pool `migrate.ts` and the adapter's tests use.
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

// `REDIS_URL` adds a Redis-backed cache (via the ioredis client) that the store consults before
// hitting the database and fills on a miss. Unset means no cache: every cache read does nothing.
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

// Picks how outgoing events get delivered, based on env. Events are first written to the
// database alongside the money move; the dispatcher this returns is what actually ships them
// out. `SQS_QUEUE_URL` sends them through an Amazon SQS queue; otherwise `DISPATCHER_URL` posts
// them over HTTP; with neither set, this returns nothing and events are delivered in-process.
// SQS wins if both are set. Each driver is loaded on demand, only when chosen. The worker's
// delivery loop is what reads from whichever dispatcher this returns.
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
