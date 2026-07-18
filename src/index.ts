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

import { economyFromCapabilities } from '#src/economy.ts';
import { loadConfig, mergeConfig } from '#src/config.ts';
import {
  isMysqlUrl,
  isPostgresUrl,
  isProduction,
  missingSecrets,
  readUrl,
  serviceUrls,
} from '#src/env.ts';

import type { EnvMap } from '#src/env.ts';
import type { Config } from '#src/config.ts';
import { assertMoneyConformant, assertSchemaCurrent } from '#src/schema.ts';
import { installMoneyRetrying } from '#src/engines/sql-shared.ts';
import { installMysql, proveMysql } from '#src/db.vendored.ts';
import { vectors as moneyVectors } from '#src/money.vendored.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { externalsFromEnv, missingExternals } from '#src/from-env.ts';
import { createWorker } from '#src/worker/index.ts';
import { jsonlLogger, noopMeter } from '#src/runtime.ts';
import { sha256Digest } from '#src/digest.ts';
import { fault, ERROR_CODES } from '#src/errors.ts';
import { requireCallable } from '#src/from-env.ts';

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
  PayeeDirectory,
  Processor,
  Rates,
  Scheduler,
  Signer,
  Store,
} from '#src/ports.ts';

// --- Public surface (re-exports only) ---------------------------------------------

// The low-level assembler: an Economy from a fully-built Capabilities bundle. createEconomy (below)
// is the one a host reaches for; this is the escape hatch for a host that already holds a Capabilities
// (e.g. to share one store between an economy and a worker).
export { economyFromCapabilities } from '#src/economy.ts';
// Resolve the four external ports from env (the same rules createEconomy applies): the piece a host
// building a Capabilities bundle by hand pairs with capabilitiesFromEnv.
export { externalsFromEnv } from '#src/from-env.ts';
export type { Externals } from '#src/from-env.ts';
export { memoryStore } from '#src/adapters/memory.ts';
export { memoryCache } from '#src/adapters/memory-cache.ts';
export { memoryRateLimiter } from '#src/adapters/memory-rate-limit.ts';

export { createWorker } from '#src/worker/index.ts';

export {
  spendable,
  earned,
  promo,
  currency,
  SYSTEM,
  ownerOf,
  isWalletAccount,
} from '#src/accounts.ts';

// Money: build and inspect the branded Amount. encode/decode are the wire pair; the value vocabulary
// ships too, since the brand blocks reassembling an Amount from raw minor units, so a reader that
// sums legs or compares a balance to a price needs these.
export {
  toAmount,
  credits,
  decodeAmount,
  encodeAmount,
  decodeAmountWire,
  add,
  neg,
  zero,
  compare,
  isZero,
  isNegative,
  isAmount,
  convertFloor,
  convertCeil,
  SCALE,
} from '#src/money.ts';
export { credit, debit } from '#src/ledger.ts';

// The store implementer's toolkit; also its own entry point, `@pwngh/economy-lab/store-kit`.
export {
  chainHash,
  balanceDelta,
  GENESIS,
  GENESIS_HEX,
  baseOf,
  shardRef,
  shardsOf,
  walletKindOf,
  byCodeUnit,
  fromHex,
  toHex,
  metaString,
  metaNumber,
  encodeAmounts,
  decodeAmounts,
  VELOCITY_CURRENCY,
} from '#src/store-kit.ts';
export type { AccountKind } from '#src/store-kit.ts';
export type { Leg } from '#src/ports.ts';

// Operation constructors: one typed builder per kind, so a caller writes topUp({ ... }) instead of
// hand-assembling the tagged union. Each returns the exact Operation that submit() takes.
export {
  topUp,
  spend,
  refund,
  clawback,
  requestPayout,
  subscribe,
  cancelSubscription,
  grantEntitlement,
  revokeEntitlement,
  grantPromo,
  adjust,
  reverse,
  reversePayout,
  settlePayout,
} from '#src/operation.ts';

// Actor constructors: build the `actor` every operation carries, e.g. userActor('usr_1').
export { userActor, systemActor, operatorActor } from '#src/actor.ts';

export { defaultConfig, loadConfig } from '#src/config.ts';

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

export {
  EconomyError,
  ERROR_CODES,
  normalizeError,
  statusForError,
} from '#src/errors.ts';
export type { ErrorCode, RejectionCode } from '#src/errors.ts';

export type { Economy } from '#src/economy.ts';
// The worker and the input/result types of its one public method, Worker.runOnce.
export type {
  Worker,
  SweepName,
  SweepInput,
  SweepBatch,
  SweepRun,
  SweepResult,
} from '#src/worker/index.ts';
export type { WorkerCtx } from '#src/contract.ts';
export type { Config } from '#src/config.ts';
// The env-map shape every composition entry point takes; parsing rules live in src/env.ts.
export type { EnvMap } from '#src/env.ts';
export type {
  Operation,
  Outcome,
  RejectionDetail,
  Transaction,
  Principal,
  Recipient,
  EntitlementAttrs,
  FeePolicy,
  ProveReport,
} from '#src/contract.ts';
export type { Amount, Currency } from '#src/money.ts';
export type { AccountRef } from '#src/accounts.ts';
// Read-side return types: the checkpoint read.checkpoint hands back, the chain link read.lineage
// streams, and the CREDIT-to-USD rate convertFloor/convertCeil take.
export type {
  Capabilities,
  Options,
  Range,
  Statement,
  Checkpoint,
  StoredLink,
  Rate,
} from '#src/ports.ts';

// --- Advanced: building blocks a host wires by hand -------------------------------
//
// The bundled entry points above cover the common path. Below is what a host that runs the economy
// itself reaches for: the pieces to build past createEconomy, and the types to name every port and
// record the exported contract already hands back. The full port contract is at the '/ports'
// subpath and the built-in adapters at '/adapters'; these re-export the common ones.

// Run the economy directly: the thorough prover, the HTTP service, webhook intake, and the two
// worker steps a background process drives.
export { proveEconomy } from '#src/integrity.ts';
export { createServer } from '#src/server.ts';
export {
  decodeWebhookEvent,
  handlePurchaseWebhook,
  handleWebhook,
  toOperation,
} from '#src/webhooks.ts';
export type {
  DisputeEvent,
  PayoutFailedEvent,
  PayoutSettledEvent,
  PurchaseEvent,
  WebhookAck,
  WebhookEvent,
} from '#src/webhooks.ts';
export { drainInbox } from '#src/worker/inbox.ts';
export { relayOutbox } from '#src/worker/relay.ts';

// Runtime capability constructors a host swaps in: a structured logger, the shared hasher, the
// Ed25519 signer, and the public key to publish for an external auditor.
export {
  jsonlLogger,
  systemDigest,
  systemSigner,
  signingPublicKeyHex,
} from '#src/runtime.ts';
// The silent defaults a host plugs into RuntimeDefaults to discard log output or metrics.
export { noopLogger, noopMeter } from '#src/runtime.ts';

// A built-in constructor for every required external port, so ExternalPorts is satisfiable from this
// entry alone: CREDIT-to-USD rates, the fee split, and an in-memory payout processor (the signer is
// systemSigner above). httpProcessor, the real payout provider, is at the '/adapters' subpath.
export { configuredRates } from '#src/adapters/rates.ts';
export { flatFee } from '#src/pricing.ts';
export { memoryProcessor } from '#src/adapters/processor.ts';

// Port types: the members of ExternalPorts, RuntimeDefaults, Capabilities, and ComposedWorker, so a
// host can name every port it supplies or receives. The remaining sub-store contracts are at the
// '/ports' subpath.
export type {
  Signer,
  Processor,
  Rates,
  Clock,
  Ids,
  Digest,
  Store,
  Dispatcher,
  Logger,
  Meter,
  Anchor,
  Cache,
  RateLimiter,
  RateVerdict,
  Scheduler,
} from '#src/ports.ts';

// Domain records the read side hands back: a payout saga, a ledger posting, an outbound event, and
// the economy's health-and-pause status.
export type { Saga, Posting, EconomyEvent } from '#src/ports.ts';
export type { EconomyStatus } from '#src/contract.ts';

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
 * Validates `env` without constructing anything: returns every problem a deployment would hit at
 * startup (an unsupported `DATABASE_URL`, missing production secrets or policy anchors, missing or
 * malformed external knobs), or an empty array when the environment is complete. Run it at deploy time so a bad config
 * fails on a health check, not on the first request. Outside production only the store scheme is
 * checked, since the dev defaults fill everything else.
 */
export function checkEnv(env: EnvMap): string[] {
  const problems = new Set<string>();
  if (describeSelection(env).store.kind === 'unsupported') {
    problems.add(
      'DATABASE_URL: not a postgres:// or mysql:// connection string',
    );
  }
  if (isProduction(env)) {
    for (const secret of missingSecrets(env)) {
      problems.add(`${secret}: required in production but missing`);
    }
    for (const key of ['MATURITY_HORIZON_CARD_MS', 'VELOCITY_LIMIT_MINOR']) {
      if ((env[key] ?? '') === '') {
        problems.add(`${key}: required in production but missing`);
      }
    }
  }
  for (const key of missingExternals(env)) {
    // SIGNING_SECRET is already reported through missingSecrets above.
    if (key !== 'SIGNING_SECRET') {
      problems.add(`${key}: required in production but missing or malformed`);
    }
  }
  return [...problems];
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
  // Ports may arrive directly rather than through externalsFromEnv, so re-check them here.
  requireCallable('signer', ports.signer, ['sign', 'verify']);
  requireCallable('rates', ports.rates, ['payout']);
  requireCallable('processor', ports.processor, ['submitPayout']);
  requireCallable('ports', ports, ['pricing']);
  const selection = describeSelection(env);
  const [store, cache, dispatcher] = await Promise.all([
    selectStore(selection.store, {
      digest: runtime.digest,
      clock: runtime.clock,
      velocityWindowMs: config.velocityWindowMs,
      poolMax: config.dbPoolMax,
      meter: runtime.meter,
      logger: runtime.logger,
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
  return economyFromCapabilities(
    await capabilitiesFromEnv(env, ports, defaults),
  );
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

// --- createEconomy: the one call --------------------------------------------------

/**
 * Everything {@link createEconomy} accepts, all optional. With none, it builds a batteries-included
 * in-memory economy. With `env`, it resolves the store (from `DATABASE_URL`), the four external
 * ports, and config from the environment. Any field passed explicitly wins over the env-derived one.
 */
export type EconomyOptions = {
  env?: EnvMap;
  store?: Store;
  cache?: Cache;
  dispatcher?: Dispatcher;
  scheduler?: Scheduler;
  payees?: PayeeDirectory;
  signer?: Signer;
  processor?: Processor;
  rates?: Rates;
  pricing?: FeePolicy;
  clock?: Clock;
  ids?: Ids;
  digest?: Digest;
  logger?: Logger;
  meter?: Meter;
  config?: Partial<Config>;
};

/**
 * The one call to stand up an {@link Economy}. `createEconomy()` needs nothing: an in-memory store, a
 * dev signer, a dev rate table, a flat fee, and an in-memory processor, all wired.
 * `createEconomy({ env })` resolves everything from the environment instead — the store from
 * `DATABASE_URL`, the external ports and config from their own keys — dev-defaulting outside
 * production and failing fast in production with one message. Pass any field to override just that
 * one. When a host already holds a full {@link Capabilities} bundle (e.g. to share one store with a
 * worker), use {@link economyFromCapabilities} instead.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy}.
 */
export async function createEconomy(
  options: EconomyOptions = {},
): Promise<Economy> {
  const env = options.env ?? {};
  const config = mergeConfig(loadConfig(env), options.config ?? {});
  const runtime = runtimeFrom(options);
  const externals = externalsFromEnv(env, {
    signer: options.signer,
    processor: options.processor,
    rates: options.rates,
    pricing: options.pricing,
  });
  const selection = describeSelection(env);
  const [store, cache, dispatcher] = await Promise.all([
    options.store ??
      selectStore(selection.store, {
        digest: runtime.digest,
        clock: runtime.clock,
        velocityWindowMs: config.velocityWindowMs,
        poolMax: config.dbPoolMax,
        meter: runtime.meter,
        logger: runtime.logger,
      }),
    options.cache ?? selectCache(selection.cache),
    options.dispatcher ?? selectDispatcher(selection.dispatcher),
  ]);
  return economyFromCapabilities({
    ...runtime,
    ...externals,
    config,
    store,
    ...(cache && { cache }),
    ...(dispatcher && { dispatcher }),
    ...(options.scheduler && { scheduler: options.scheduler }),
    ...(options.payees && { payees: options.payees }),
  });
}

// --- The wiring (drivers import here, only when selected) ---------------------------

async function selectStore(
  selection: Selection['store'],
  deps: {
    digest: Digest;
    clock: Clock;
    velocityWindowMs: number;
    poolMax?: number | null;
    meter?: Meter;
    logger?: Logger;
  },
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
      ...(deps.poolMax ? { poolMax: deps.poolMax } : {}),
      meter: deps.meter,
      logger: deps.logger,
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
  deps: {
    digest: Digest;
    clock: Clock;
    velocityWindowMs: number;
    poolMax?: number | null;
    meter?: Meter;
    logger?: Logger;
  },
): Promise<Store> {
  const { createMysqlPool, mysqlStore, readSchemaVersion } =
    await import('#src/engines/mysql.ts');
  const pool = await createMysqlPool(
    url,
    deps.poolMax ? { connectionLimit: deps.poolMax } : {},
  );
  assertSchemaCurrent(await readSchemaVersion(pool), 'MySQL');
  const runner = {
    run: (sql: string, params?: readonly unknown[]) =>
      pool
        .query(sql, params ? [...params] : undefined)
        .then(([rows]) => rows as Record<string, unknown>[]),
  };
  // Retried: concurrent boots race the shared money functions (see installMoneyRetrying).
  await installMoneyRetrying(() => installMysql(runner));
  assertMoneyConformant(await proveMysql(runner, moneyVectors), 'MySQL');
  return mysqlStore({
    pool,
    digest: deps.digest,
    clock: deps.clock,
    velocityWindowMs: deps.velocityWindowMs,
    meter: deps.meter,
    logger: deps.logger,
  });
}

// Turns a missing optional peer dependency into a clear config error naming the package to install,
// rather than a raw module-resolution failure surfacing from deep in the wiring.
async function loadPeer<T>(pkg: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      `Could not load the "${pkg}" driver. Install the optional peer dependency: npm install ${pkg}`,
      { cause, retryable: false },
    );
  }
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
  const Redis = (await loadPeer('ioredis', () => import('ioredis')))
    .default as unknown as {
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
    const { SQSClient, SendMessageCommand } = await loadPeer(
      '@aws-sdk/client-sqs',
      () => import('@aws-sdk/client-sqs'),
    );
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
  const runtime = {
    clock: defaults.clock ?? wallClock(),
    ids: defaults.ids ?? uuidIds(),
    digest: defaults.digest ?? sha256Digest(),
    logger: defaults.logger ?? jsonlLogger(),
    meter: defaults.meter ?? noopMeter(),
  };
  // A malformed override fails here, at wiring, not deep inside a request or sweep.
  requireCallable('clock', runtime.clock, ['now']);
  requireCallable('ids', runtime.ids, ['next']);
  requireCallable('digest', runtime.digest, ['hash']);
  requireCallable('logger', runtime.logger, ['log']);
  requireCallable('meter', runtime.meter, ['count', 'observe']);
  return runtime;
}

function wallClock(): Clock {
  return { now: () => Date.now() };
}

function uuidIds(): Ids {
  return { next: (prefix) => `${prefix}_${crypto.randomUUID()}` };
}
