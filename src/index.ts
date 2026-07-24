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
import {
  defaultConfig,
  inspectConfig,
  loadSecrets,
  missingPolicyAnchors,
  missingSecretFields,
} from '#src/config.ts';
import {
  isMysqlUrl,
  isPostgresUrl,
  isProduction,
  readFlag,
  readIntOrNull,
  readUrl,
  serviceUrls,
} from '#src/env.ts';
import { assertMoneyConformant, assertSchemaCurrent } from '#src/schema.ts';
import { installMoneyRetrying } from '#src/engines/sql-shared.ts';
import { installMysql, proveMysql } from '#src/db.vendored.ts';
import { vectors as moneyVectors } from '#src/money.vendored.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  DEV_RATES,
  missingExternals,
  requireCallable,
  resolveExternals,
  signerFromSecrets,
} from '#src/from-env.ts';
import { createWorker } from '#src/worker/index.ts';
import {
  jsonlLogger,
  randomIds,
  silentMeter,
  systemClock,
} from '#src/runtime.ts';
import { sha256Digest } from '#src/digest.ts';
import { fault, ERROR_CODES } from '#src/errors.ts';
import { configuredRates } from '#src/adapters/rates.ts';
import { flatFee } from '#src/pricing.ts';
import { memoryProcessor } from '#src/adapters/processor.ts';

import type { EnvMap } from '#src/env.ts';
import type { Config, Secrets } from '#src/config.ts';
import type { RatesConfig } from '#src/from-env.ts';
import type { Economy } from '#src/economy.ts';
import type { FeePolicy } from '#src/contract.ts';
import type { Worker } from '#src/worker/index.ts';
import type {
  Anchor,
  Cache,
  Clock,
  Digest,
  Dispatcher,
  Ids,
  Logger,
  Meter,
  PayeeDirectory,
  Ports,
  Processor,
  Rates,
  Scheduler,
  Signer,
  Store,
} from '#src/ports.ts';

// --- Public surface (re-exports only) ---------------------------------------------

// Construction: the three altitudes are boot, openPorts + create*, and memoryPorts or a
// hand-built structural Ports. createEconomy is sync over a finished bag; openPorts is the sole
// env-to-bag path, sharing every decision with preflight and describeEnv (defined below).
export { createEconomy } from '#src/economy.ts';
export { createWorker, DEFAULT_SWEEP_LIMIT } from '#src/worker/index.ts';
export type {
  Worker,
  SweepRequest,
  WorkerDefaults,
} from '#src/worker/index.ts';
export { createServer } from '#src/server.ts';
export type { FetchHandler, ServerOptions, ServerPorts } from '#src/server.ts';
export { systemRuntime } from '#src/runtime.ts';
export type { Ports } from '#src/ports.ts';
export { DEV_RATES } from '#src/from-env.ts';
export type { RatesConfig } from '#src/from-env.ts';

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
  usd,
  decodeAmount,
  encodeAmount,
  decodeAmountWire,
  add,
  negate,
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
  idempotencyKey,
} from '#src/operation.ts';

// Actor constructors: build the `actor` every operation carries, e.g. userActor('usr_1').
export { userActor, systemActor, operatorActor } from '#src/actor.ts';

// Config is policy only and safe to log; Secrets is the credential bag. The key registries are
// the enumerable env surface: policy, secrets, and the production decline flags.
export {
  defaultConfig,
  loadConfig,
  mergeConfig,
  inspectConfig,
  maintenanceWindow,
  CONFIG_KEYS,
  SECRET_KEYS,
  DECLINE_KEYS,
} from '#src/config.ts';
export type { Config, Secrets } from '#src/config.ts';

export {
  EconomyError,
  ERROR_CODES,
  normalizeError,
  statusForError,
  REJECTION_CODES,
  REJECTION_SPEC,
  isSuccess,
  isRejection,
  requireSuccess,
} from '#src/errors.ts';
export type { ErrorCode, RejectionCode } from '#src/errors.ts';

export type { Economy } from '#src/economy.ts';
// The env-map shape every construction entry point takes; parsing rules live in src/env.ts.
export type { EnvMap } from '#src/env.ts';
export type {
  Operation,
  Outcome,
  Success,
  Rejection,
  RejectionDetail,
  Transaction,
  Principal,
  Recipient,
  EntitlementAttributes,
  FeePolicy,
  ProveReport,
  HealthReport,
  EconomyStatus,
} from '#src/contract.ts';
export type { Amount, Currency } from '#src/money.ts';
export type { AccountRef } from '#src/accounts.ts';
export type { BitsetOptions } from '#src/adapters/entitlement-bitset.ts';
// Read-side return types: the checkpoint read.checkpoint hands back, the chain link read.lineage
// streams, and the CREDIT-to-USD rate convertFloor/convertCeil take.
export type {
  CallOptions,
  Range,
  Statement,
  Checkpoint,
  StoredLink,
  Rate,
} from '#src/ports.ts';

// The thorough prover for CI and audits; read.health() is the light in-process snapshot.
export { allInvariantsHold, proveEconomy, findByHash } from '#src/integrity.ts';
export type { ProvePorts } from '#src/integrity.ts';
export { paginate } from '#src/paginate.ts';

// Offline verification of a read.export file: the same provers, no store access.
export { parseExport, verifyExport } from '#src/verify-export.ts';
export type { ParsedExport, VerifyReport } from '#src/verify-export.ts';
export { EXPORT_FORMAT } from '#src/economy.ts';

// Port types, so a host can name every port it supplies or receives. The remaining sub-store
// contracts are at the '/ports' subpath and the built-in adapters at '/adapters'.
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
// the economy's maintenance status.
export type { Saga, Posting, EconomyEvent } from '#src/ports.ts';

// --- Construction from env ---------------------------------------------------------
//
// src/engines/ are the systems of record that enforce ledger invariants natively (Postgres, MySQL),
// and src/adapters/ are everything pluggable that does not. See
// https://economy-lab-docs.pages.dev/economy/ports/storage/
// for how every adapter meets one contract and the SQL engines also enforce it in the database.

/**
 * Overrides for {@link openPorts} — every field optional. A port field set to `false` is an
 * explicit decline, which production accepts where a bare omission is an error (see the absence
 * policy on {@link preflight}). `rates` takes a live source or the exact integer knobs.
 */
export type PortsInit = {
  readonly store?: Store;
  readonly clock?: Clock;
  readonly ids?: Ids;
  readonly digest?: Digest;
  readonly signer?: Signer;
  readonly processor?: Processor;
  readonly rates?: Rates | RatesConfig;
  readonly pricing?: FeePolicy;
  readonly logger?: Logger;
  readonly meter?: Meter;
  readonly config?: Partial<Config>;
  readonly secrets?: Partial<Secrets>;
  readonly cache?: Cache | false;
  readonly dispatcher?: Dispatcher | false;
  readonly payees?: PayeeDirectory | false;
  readonly anchor?: Anchor | false;
  readonly scheduler?: Scheduler | false;
};

/** Everything {@link boot} accepts: the {@link PortsInit} overrides plus the worker switch. */
export type BootInit = PortsInit & {
  /** Default true; false boots the API-process shape with `worker: null`. */
  readonly worker?: boolean;
};

/**
 * One {@link preflight} finding. Severity 'error' is exactly what {@link openPorts} refuses;
 * 'warning' is advisory and blocks nothing.
 */
export type PreflightIssue = {
  /** Stable machine code, e.g. 'secret.missing' or 'port.absent'. */
  readonly code: string;
  /** The env name or port slot at fault, e.g. 'DATABASE_URL' or 'dispatcher'. */
  readonly path: string;
  /** Human-readable, states the fix. */
  readonly message: string;
  readonly severity: 'error' | 'warning';
};

/** The runtime quartet a production host wires from one signing key via {@link systemRuntime}. */
export type Runtime = Pick<Ports, 'clock' | 'ids' | 'digest' | 'signer'>;

/**
 * What {@link describeEnv} returns: the concrete adapter each env knob selects — kind and URL —
 * before any driver loads, plus secret presence (never values). 'declined' versus 'missing'
 * mirrors the production absence policy on {@link preflight}.
 */
export type EnvDescription = {
  readonly production: boolean;
  readonly store: {
    readonly kind: 'memory' | 'postgres' | 'mysql' | 'unsupported';
    readonly url: string | null;
  };
  readonly cache: {
    readonly kind: 'none' | 'redis';
    readonly url: string | null;
  };
  readonly dispatcher: {
    readonly kind: 'in-process' | 'http' | 'sqs' | 'declined' | 'missing';
    readonly url: string | null;
  };
  readonly processor: {
    readonly kind: 'memory' | 'http';
    readonly url: string | null;
  };
  readonly payees: 'set' | 'declined' | 'missing';
  readonly anchor: 'set' | 'declined' | 'missing';
  readonly secrets: {
    readonly webhook: 'missing' | 'set';
    readonly signing: 'missing' | 'set';
    readonly signingPriors: number;
  };
  readonly velocityWindowMs: number | null;
};

/**
 * What {@link boot} returns: the resolved ports, the economy assembled over them, and the worker
 * bound to that same economy — null when the init declined it with `worker: false`.
 */
export type Boot = {
  readonly ports: Ports;
  readonly economy: Economy;
  readonly worker: Worker | null;
};

// Which concrete adapter each env knob picks, before any driver loads. This is the ONE reading of
// the selection: the selectors below consume it to do the wiring, and describeEnv reports it, so
// a displayed selection can never diverge from the wired one.
type EnvSelection = {
  store:
    | { kind: 'memory'; url: null }
    | { kind: 'postgres' | 'mysql' | 'unsupported'; url: string };
  cache: { kind: 'none'; url: null } | { kind: 'redis'; url: string };
  dispatcher:
    | { kind: 'missing'; url: null }
    | { kind: 'sqs' | 'http'; url: string };
};

// DATABASE_URL picks the store by scheme (unset = in-memory, postgres://|mysql:// = that engine,
// anything else = 'unsupported', which selectStore rejects); REDIS_URL adds the cache;
// SQS_QUEUE_URL beats DISPATCHER_URL for delivery. All through the shared resolver rules (env.ts).
function envSelection(env: EnvMap): EnvSelection {
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
          : { kind: 'missing', url: null },
  };
}

// The three optional ports production refuses to lose silently, with each one's decline flag.
const ABSENCE_SLOTS = [
  { slot: 'dispatcher', flag: 'DISPATCHER_DECLINED' },
  { slot: 'payees', flag: 'PAYEES_DECLINED' },
  { slot: 'anchor', flag: 'ANCHOR_DECLINED' },
] as const;

type AbsenceSlot = (typeof ABSENCE_SLOTS)[number]['slot'];

type SlotState = 'set' | 'declined' | 'missing';

// One reading of set/declined/missing per slot, shared by preflight, describeEnv, and openPorts.
function slotStates(
  env: EnvMap,
  init: PortsInit,
): Record<AbsenceSlot, SlotState> {
  const state = (
    value: object | ((...args: never[]) => unknown) | false | undefined,
    flag: string,
    envSet: boolean,
  ): SlotState =>
    value === false || readFlag(env[flag])
      ? 'declined'
      : value !== undefined || envSet
        ? 'set'
        : 'missing';
  const selection = envSelection(env);
  return {
    dispatcher: state(
      init.dispatcher,
      'DISPATCHER_DECLINED',
      selection.dispatcher.kind !== 'missing',
    ),
    payees: state(init.payees, 'PAYEES_DECLINED', false),
    anchor: state(init.anchor, 'ANCHOR_DECLINED', false),
  };
}

/**
 * Validates `env` plus `init` without constructing anything: every issue here with severity
 * 'error' is exactly what {@link openPorts} would throw on. Run it at deploy time so a bad
 * config fails on a health check, not on the first request. Outside production only the store
 * scheme and the shape of init-supplied ports are checked, since the dev defaults fill
 * everything else.
 */
export function preflight(
  env: EnvMap = {},
  init: PortsInit = {},
): readonly PreflightIssue[] {
  if (!isProduction(env)) {
    return [...storeIssues(env, init), ...declinablePortIssues(init)];
  }
  return [
    ...storeIssues(env, init),
    ...secretIssues(env, init),
    ...policyAnchorIssues(env, init),
    ...externalIssues(env, init),
    ...absenceIssues(env, init),
    ...declinablePortIssues(init),
    ...declineConflictIssues(env, init),
  ];
}

function issue(
  code: string,
  path: string,
  message: string,
  severity: PreflightIssue['severity'] = 'error',
): PreflightIssue {
  return { code, path, message, severity };
}

function storeIssues(env: EnvMap, init: PortsInit): PreflightIssue[] {
  if (init.store !== undefined) {
    return [];
  }
  if (envSelection(env).store.kind !== 'unsupported') {
    return [];
  }
  return [
    issue(
      'store.unsupported-url',
      'DATABASE_URL',
      'DATABASE_URL is not a postgres:// or mysql:// connection string.',
    ),
  ];
}

function secretIssues(env: EnvMap, init: PortsInit): PreflightIssue[] {
  const secrets: Secrets = {
    webhookSecret: init.secrets?.webhookSecret ?? env.WEBHOOK_SECRET ?? '',
    signingSecret: init.secrets?.signingSecret ?? env.SIGNING_SECRET ?? '',
  };
  return missingSecretFields(secrets).map((key) =>
    issue(
      'secret.missing',
      key,
      `${key} is required in production but missing.`,
    ),
  );
}

function policyAnchorIssues(env: EnvMap, init: PortsInit): PreflightIssue[] {
  return missingPolicyAnchors(env, init.config ?? {}).map((key) =>
    issue(
      'config.missing',
      key,
      `${key} is required in production but missing.`,
    ),
  );
}

function externalIssues(env: EnvMap, init: PortsInit): PreflightIssue[] {
  return missingExternals(env, init).map((key) =>
    issue(
      'external.missing',
      key,
      `${key} is required in production but missing or malformed.`,
    ),
  );
}

function absenceIssues(env: EnvMap, init: PortsInit): PreflightIssue[] {
  const states = slotStates(env, init);
  return ABSENCE_SLOTS.filter(({ slot }) => states[slot] === 'missing').map(
    ({ slot, flag }) =>
      issue(
        'port.absent',
        slot,
        `Production requires ${slot} to be set or explicitly declined (init ${slot}: false, or env ${flag}=1).`,
      ),
  );
}

// The wiring-time shape probes for the declinable ports, so a malformed init fails preflight
// exactly as it fails openPorts.
function declinablePortIssues(init: PortsInit): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const malformed = (slot: AbsenceSlot, probe: () => void): void => {
    try {
      probe();
    } catch (error) {
      issues.push(
        issue(
          'port.malformed',
          slot,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  };
  if (
    init.dispatcher !== undefined &&
    init.dispatcher !== false &&
    typeof init.dispatcher !== 'function'
  ) {
    issues.push(
      issue(
        'port.malformed',
        'dispatcher',
        'dispatcher is not a function; pass the dispatch function itself, not an object carrying one.',
      ),
    );
  }
  if (init.payees !== undefined && init.payees !== false) {
    malformed('payees', () =>
      requireCallable('payees', init.payees, ['status']),
    );
  }
  if (init.anchor !== undefined && init.anchor !== false) {
    malformed('anchor', () =>
      requireCallable('anchor', init.anchor, ['publish']),
    );
  }
  return issues;
}

// An explicit decline beats a configured source, so the shadowed source surfaces as a warning.
function declineConflictIssues(env: EnvMap, init: PortsInit): PreflightIssue[] {
  const states = slotStates(env, init);
  const configured: Record<AbsenceSlot, boolean> = {
    dispatcher:
      (init.dispatcher !== undefined && init.dispatcher !== false) ||
      envSelection(env).dispatcher.kind !== 'missing',
    payees: init.payees !== undefined && init.payees !== false,
    anchor: init.anchor !== undefined && init.anchor !== false,
  };
  return ABSENCE_SLOTS.filter(
    ({ slot }) => states[slot] === 'declined' && configured[slot],
  ).map(({ slot }) =>
    issue(
      'port.decline-conflict',
      slot,
      `${slot} is declined but also configured; the decline wins and the configured ${slot} is ignored.`,
      'warning',
    ),
  );
}

/**
 * Reports what a given env and init would wire, presence only — no secret values, no
 * connections. `declined` versus `missing` mirrors the production absence policy.
 */
export function describeEnv(
  env: EnvMap = {},
  init: PortsInit = {},
): EnvDescription {
  const selection = envSelection(env);
  const states = slotStates(env, init);
  const processorUrl = serviceUrls(env).processor;
  return {
    production: isProduction(env),
    store: selection.store,
    cache: selection.cache,
    dispatcher:
      states.dispatcher === 'declined'
        ? { kind: 'declined', url: null }
        : typeof init.dispatcher === 'function'
          ? { kind: 'in-process', url: null }
          : selection.dispatcher,
    processor:
      processorUrl === null
        ? { kind: 'memory', url: null }
        : { kind: 'http', url: processorUrl },
    payees: states.payees,
    anchor: states.anchor,
    secrets: describeSecrets(env, init),
    velocityWindowMs:
      init.config?.velocityWindowMs ??
      readIntOrNull(env.VELOCITY_WINDOW_MS) ??
      null,
  };
}

function describeSecrets(
  env: EnvMap,
  init: PortsInit,
): EnvDescription['secrets'] {
  const webhookSet =
    (init.secrets?.webhookSecret ?? env.WEBHOOK_SECRET ?? '') !== '';
  const signingSet =
    (init.secrets?.signingSecret ?? env.SIGNING_SECRET ?? '') !== '';
  const priors =
    init.secrets?.signingSecretsPrior ??
    (env.SIGNING_SECRETS_PRIOR ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  return {
    webhook: webhookSet ? 'set' : 'missing',
    signing: signingSet ? 'set' : 'missing',
    signingPriors: priors.length,
  };
}

/**
 * The sole env-to-bag path: loads Config and Secrets (init wins per field, both frozen), builds
 * the runtime and external ports with dev stand-ins outside production, opens the store the
 * `DATABASE_URL` scheme names, and applies the production absence policy. Everything
 * {@link preflight} flags as an error throws here as one CONFIG.INVALID.
 *
 * @example
 * const ports = await openPorts(process.env, {
 *   config: { platformFeeBps: 3000 },
 *   dispatcher: false, // this deployment runs without outbox delivery, on purpose
 * });
 * const economy = createEconomy(ports);
 */
export async function openPorts(
  env: EnvMap = {},
  init: PortsInit = {},
): Promise<Ports> {
  assertPreflight(env, init);

  const config = inspectConfig(env, init.config ?? {});
  const secrets = loadSecrets(env, init.secrets);
  const runtime = runtimeFrom(init);
  const externals = resolveExternals(env, init, secrets);

  const states = slotStates(env, init);
  const [store, cache, dispatcher] = await openSelected(env, init, states, {
    ...runtime,
    config,
  });
  const payees = init.payees === false ? undefined : init.payees;
  const anchor = init.anchor === false ? undefined : init.anchor;
  const scheduler = init.scheduler === false ? undefined : init.scheduler;
  countAbsence(runtime.meter, states);

  Object.freeze(config);
  Object.freeze(config.maturityHorizonMs);
  Object.freeze(config.payoutSla);
  Object.freeze(secrets);

  return {
    ...runtime,
    ...externals,
    config,
    secrets,
    store,
    ...(cache && { cache }),
    ...(dispatcher && { dispatcher }),
    ...(payees && { payees }),
    ...(anchor && { anchor }),
    ...(scheduler && { scheduler }),
  };
}

function assertPreflight(env: EnvMap, init: PortsInit): void {
  const problems = preflight(env, init).filter(
    (found) => found.severity === 'error',
  );
  if (problems.length === 0) {
    return;
  }
  throw fault(
    ERROR_CODES.CONFIG_INVALID,
    `Preflight failed: ${problems.map((found) => found.message).join(' ')}`,
    {
      retryable: false,
      detail: { issues: problems.map(({ code, path }) => ({ code, path })) },
    },
  );
}

// The store the env selects (or the init supplies), the optional cache, and the dispatcher when
// the slot resolved 'set' — an init-supplied instance or the env-selected transport.
function openSelected(
  env: EnvMap,
  init: PortsInit,
  states: Record<AbsenceSlot, SlotState>,
  deps: Pick<Ports, 'clock' | 'digest' | 'meter' | 'logger'> & {
    config: Config;
  },
): Promise<[Store, Cache | undefined, Dispatcher | undefined]> {
  const selection = envSelection(env);
  const config = deps.config;
  return Promise.all([
    init.store ??
      selectStore(selection.store, {
        digest: deps.digest,
        clock: deps.clock,
        velocityWindowMs: config.velocityWindowMs,
        poolMax: config.dbPoolMax,
        meter: deps.meter,
        logger: deps.logger,
      }),
    init.cache === false
      ? undefined
      : (init.cache ?? selectCache(selection.cache)),
    states.dispatcher !== 'set'
      ? undefined
      : typeof init.dispatcher === 'function'
        ? init.dispatcher
        : selectDispatcher(selection.dispatcher),
  ]);
}

// The absence telemetry: how each optional slot resolved, so a fleet dashboard can spot a
// deployment quietly running without its dispatcher.
function countAbsence(
  meter: Meter,
  states: Record<AbsenceSlot, SlotState>,
): void {
  try {
    for (const { slot } of ABSENCE_SLOTS) {
      meter.count('economy.preflight.absence', 1, {
        slot,
        state: states[slot],
      });
    }
  } catch {
    // Telemetry only.
  }
}

/**
 * The day-one door: openPorts, createEconomy, and (unless `worker: false`) a worker bound to
 * that economy over the same bag. Anything a bad env would make {@link openPorts} throw, boot
 * throws too, so a misconfigured deploy dies at startup.
 *
 * @example
 * const { economy, worker } = await boot(process.env);
 * const stop = worker?.start(30_000); // payout, outbox, and checkpoint sweeps every 30s
 * const outcome = await economy.submit(
 *   topUp({ idempotencyKey: 'idem_1', actor: systemActor('store'), userId: 'usr_1',
 *           amount: credits(1_200), source: 'card' }),
 * );
 */
export async function boot(
  env: EnvMap = {},
  init: BootInit = {},
): Promise<Boot> {
  const { worker: withWorker = true, ...portsInit } = init;
  const ports = await openPorts(env, portsInit);
  const economy = createEconomy(ports);
  const worker = withWorker ? createWorker(ports, economy) : null;
  return { ports, economy, worker };
}

/**
 * A finished in-memory Ports bag for tests and quickstarts: memory store, dev rates and fees,
 * in-memory processor, and a real Ed25519 signer seeded from `signingKey`. Sync, no env.
 */
export function memoryPorts(options: {
  readonly signingKey: string;
  readonly config?: Partial<Config>;
  readonly secrets?: Partial<Secrets>;
  readonly store?: Store;
}): Ports {
  const config = defaultConfig(options.config ?? {});
  const secrets: Secrets = {
    webhookSecret: options.secrets?.webhookSecret ?? '',
    signingSecret: options.secrets?.signingSecret ?? options.signingKey,
    ...(options.secrets?.signingSecretsPrior !== undefined
      ? { signingSecretsPrior: options.secrets.signingSecretsPrior }
      : {}),
  };
  const digest = sha256Digest();
  const clock = systemClock();
  Object.freeze(config);
  Object.freeze(config.maturityHorizonMs);
  Object.freeze(config.payoutSla);
  Object.freeze(secrets);
  return {
    clock,
    ids: randomIds(),
    digest,
    signer: signerFromSecrets(secrets),
    processor: memoryProcessor(),
    rates: configuredRates(DEV_RATES),
    pricing: flatFee(),
    logger: jsonlLogger(),
    meter: silentMeter(),
    config,
    secrets,
    store:
      options.store ??
      memoryStore({
        digest,
        clock,
        velocityWindowMs: config.velocityWindowMs,
      }),
  };
}

// --- The wiring (drivers import here, only when selected) ---------------------------

async function selectStore(
  selection: EnvSelection['store'],
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
  selection: EnvSelection['cache'],
): Promise<Cache | undefined> {
  if (selection.kind === 'none') {
    return undefined;
  }
  const url = selection.url;
  const { redisCache } = await import('#src/adapters/redis.ts');
  // ioredis' default export is the client constructor at runtime; the cast pins it to the
  // adapter's minimal RedisClient surface (its module types don't expose the construct signature).
  const Redis = (await loadPeer('ioredis', () => import('ioredis')))
    .default as unknown as {
    new (connection: string): Parameters<typeof redisCache>[0];
  };
  return redisCache(new Redis(url));
}

async function selectDispatcher(
  selection: EnvSelection['dispatcher'],
): Promise<Dispatcher | undefined> {
  if (selection.kind === 'missing') {
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
  init: PortsInit,
): Pick<Ports, 'clock' | 'ids' | 'digest' | 'logger' | 'meter'> {
  const runtime = {
    clock: init.clock ?? systemClock(),
    ids: init.ids ?? randomIds(),
    digest: init.digest ?? sha256Digest(),
    logger: init.logger ?? jsonlLogger(),
    meter: init.meter ?? silentMeter(),
  };
  // A malformed override fails here, at wiring, not deep inside a request or sweep.
  requireCallable('clock', runtime.clock, ['now']);
  requireCallable('ids', runtime.ids, ['next']);
  requireCallable('digest', runtime.digest, ['hash']);
  requireCallable('logger', runtime.logger, ['log']);
  requireCallable('meter', runtime.meter, ['count', 'observe']);
  return runtime;
}
