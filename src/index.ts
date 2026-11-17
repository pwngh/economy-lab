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
 * The main entry point. It exports construction, operations, money, the ledger, outcomes, and
 * the principal types.
 *
 * @module economy-lab
 */

import { createEconomy } from '#src/economy.ts';
import {
  configIssues,
  defaultConfig,
  inspectConfig,
  loadSecrets,
  missingPolicyAnchors,
  missingSecretFields,
  retiredConfigKeys,
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
import { memoryStore } from '#src/adapters/memory.ts';
import {
  DEV_RATES,
  missingExternals,
  rateTableFault,
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
import { EconomyError, fault, ERROR_CODES } from '#src/errors.ts';

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

// Three ways to construct: boot, openPorts + create*, and memoryPorts or a hand-built structural
// Ports. createEconomy is sync over a finished bag. openPorts is the sole env-to-bag path, and it
// shares every decision with preflight and describeEnv (defined below).
export { createEconomy } from '#src/economy.ts';
export { createBalanceHolds } from '#src/balance-holds.ts';
export type {
  BalanceHolds,
  BalanceHoldResult,
  BalanceAvailability,
  PlaceBalanceHold,
  ReleaseBalanceHold,
} from '#src/balance-holds.ts';
export { createSubmitCoalescer } from '#src/batching.ts';
export type { CoalescerOptions, SubmitCoalescer } from '#src/batching.ts';
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

// These build and inspect the branded Amount. encode/decode are the wire pair. The value
// vocabulary ships too, because the brand blocks reassembling an Amount from raw minor units.
// A reader that sums legs or compares a balance to a price needs these.
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
  mulDiv,
  rateGte,
  SCALE,
} from '#src/money.ts';
export type { Rounding } from '#src/money.ts';
// The fee arithmetic every charge runs through. A host quoting a fee before it posts, or
// showing a seller what a split leaves, calls these rather than re-deriving the rounding.
export { feeForPrice, revenueForSplit } from '#src/pricing.ts';
export { credit, debit, postEntry } from '#src/ledger.ts';
export type { Leg } from '#src/ports.ts';

// The operation constructors give one typed builder per kind, so a caller writes topUp({ ... })
// instead of hand-assembling the tagged union. Each returns the exact Operation that submit() takes.
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

// The actor constructors build the `actor` every operation carries, e.g. userActor('usr_1').
export { userActor, systemActor, operatorActor } from '#src/actor.ts';

// Config is policy only and safe to log. Secrets is the credential bag. The key registries are
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
  // The one constructor for a coded fault. A backend the core classifies — retryable or not,
  // degrade or fail — has to speak this vocabulary rather than throw its driver's own error.
  fault,
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
// The env-map shape every construction entry point takes. The parsing rules live in src/env.ts.
export type { EnvMap } from '#src/env.ts';
/**
 * The one rule for reading an integer knob out of the environment, so a host's knobs and the
 * lab's are read the same way. Digits with an optional sign, parsed base 10, refused unless it
 * is a safe integer inside `bounds`. Anything else — a float, `0x1f`, `1e4`, a value past the
 * bounds — takes the fallback rather than becoming a number nobody meant. `readIntOrNull` is the
 * same rule for a knob where unset means off, and `withinIntBounds` is the same rule for a value
 * somebody already parsed.
 */
export { readInt, readIntOrNull, withinIntBounds } from '#src/env.ts';
export type { IntBounds } from '#src/env.ts';
export { CAPACITY_THRESHOLDS } from '#src/contract.ts';
export type {
  Operation,
  Outcome,
  BatchOutcome,
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
  CapacityReport,
} from '#src/contract.ts';
export type { Amount, Currency } from '#src/money.ts';
export type { AccountRef } from '#src/accounts.ts';
export type { BitsetOptions } from '#src/adapters/entitlement-bitset.ts';
// These are the read-side return types: the checkpoint read.checkpoint hands back, the chain link
// read.lineage streams, and the CREDIT-to-USD rate convertFloor/convertCeil take.
export type {
  CallOptions,
  Range,
  Statement,
  Checkpoint,
  StoredLink,
  Rate,
} from '#src/ports.ts';

// This is the thorough prover for CI and audits. read.health() is the light in-process snapshot.
export { allInvariantsHold, proveEconomy, findByHash } from '#src/integrity.ts';
export type { ProvePorts } from '#src/integrity.ts';
// The link a replay stopped at. Both reports carry one in `firstBreak`, so a caller narrows the
// field instead of casting it.
export type { ChainBreak } from '#src/chain.ts';
export { paginate } from '#src/paginate.ts';

// These verify a read.export file offline. They run the same provers with no store access.
export { parseExport, verifyExport } from '#src/verify-export.ts';
export type {
  BoundaryBreak,
  ParsedExport,
  VerifyReport,
} from '#src/verify-export.ts';
export { EXPORT_FORMAT } from '#src/economy.ts';

// These port types let a host name every port it supplies or receives. The remaining sub-store
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

// The read side hands back these domain records: a payout saga, a ledger posting, an outbound
// event, and the economy's maintenance status.
export { EVENT_TYPES, EVENT_VERSION } from '#src/ports.ts';
export type { Saga, Posting, EconomyEvent, EventType } from '#src/ports.ts';

// --- Construction from env ---------------------------------------------------------
//
// packages/postgres and packages/mysql are the systems of record: they enforce the ledger's
// invariants a second time, in the database. src/engines/ is the SQL kit those two share, and
// src/adapters/ is everything that does not; every adapter meets the one contract. See
// https://economy-lab-docs.pages.dev/economy/ports/storage/

/**
 * Overrides for {@link openPorts} — every field optional. A port field set to `false` is an
 * explicit decline. Production accepts a decline where a bare omission is an error (see the
 * absence policy on {@link preflight}). `rates` takes a live source or the exact integer knobs.
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

/** {@link boot} accepts the {@link PortsInit} overrides plus the worker switch. */
export type BootInit = PortsInit & {
  /** Default true. False boots the API-process shape with `worker: null`. */
  readonly worker?: boolean;
};

/**
 * One {@link preflight} finding. Severity 'error' is exactly what {@link openPorts} refuses.
 * 'warning' is advisory and blocks nothing.
 */
export type PreflightIssue = {
  /** Stable machine code, e.g. 'secret.missing' or 'port.absent'. */
  readonly code: string;
  /** The env name or port slot at fault, e.g. 'DATABASE_URL' or 'dispatcher'. */
  readonly path: string;
  /** A human-readable message that states the fix. */
  readonly message: string;
  readonly severity: 'error' | 'warning';
};

/** The runtime quartet a production host wires from one signing key via {@link systemRuntime}. */
export type Runtime = Pick<Ports, 'clock' | 'ids' | 'digest' | 'signer'>;

/**
 * {@link describeEnv} returns this shape. It names the adapter each slot resolves to — kind and
 * URL — before any driver loads. It also reports secret presence, never values. 'declined' versus
 * 'missing' mirrors the production absence policy on {@link preflight}.
 *
 * Two readings meet in every adapter row, and each field carries one of them: `kind` is what the
 * bag {@link openPorts} builds will hold, and `url` is the connection string the environment names
 * whether or not anything opens it. So a port the init supplies reads `supplied` beside the
 * `DATABASE_URL` it overrides, and neither reading is dropped for the other.
 */
export type EnvDescription = {
  readonly production: boolean;
  readonly store: {
    readonly kind: 'memory' | 'postgres' | 'mysql' | 'unsupported' | 'supplied';
    readonly url: string | null;
  };
  readonly cache: {
    readonly kind: 'none' | 'redis' | 'supplied' | 'declined';
    readonly url: string | null;
  };
  readonly dispatcher: {
    readonly kind: 'in-process' | 'http' | 'sqs' | 'declined' | 'missing';
    readonly url: string | null;
  };
  readonly processor: {
    readonly kind: 'memory' | 'http' | 'supplied';
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
 * {@link boot} returns the resolved ports, the economy assembled over them, and the worker
 * bound to that same economy. The worker is null when the init declined it with `worker: false`.
 */
export type Boot = {
  readonly ports: Ports;
  readonly economy: Economy;
  readonly worker: Worker | null;
};

// Names which concrete adapter each env knob picks, before any driver loads. This is the ONE
// reading of the selection. The selectors below consume it to do the wiring, and describeEnv
// reports it, so a displayed selection can never diverge from the wired one.
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
// anything else = 'unsupported', which selectStore rejects). REDIS_URL adds the cache.
// SQS_QUEUE_URL beats DISPATCHER_URL for delivery. All go through the shared resolver rules (env.ts).
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

// Lists the three optional ports production refuses to lose silently, with each one's decline flag.
const ABSENCE_SLOTS = [
  { slot: 'dispatcher', flag: 'DISPATCHER_DECLINED' },
  { slot: 'payees', flag: 'PAYEES_DECLINED' },
  { slot: 'anchor', flag: 'ANCHOR_DECLINED' },
] as const;

type AbsenceSlot = (typeof ABSENCE_SLOTS)[number]['slot'];

type SlotState = 'set' | 'declined' | 'missing';

// Resolves each slot to set/declined/missing. preflight, describeEnv, and openPorts share this
// one reading.
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
 * Validates `env` plus `init` without constructing anything. Every issue here with severity
 * 'error' is exactly what {@link openPorts} would throw on.
 *
 * Run it at deploy time — a bad config then fails on a health check, not on the first request.
 *
 * Outside production it checks the store scheme, the backends the environment names but nothing
 * supplies, the shape of every port the init supplies, every policy knob the init supplies or the
 * environment names, and any retired env name still set; the dev defaults fill everything else.
 * The named-backend, port-shape and policy-knob rows are checked in both postures because
 * `openPorts` refuses them in both, and the retired-name row in both because no posture reads the
 * name.
 */
export function preflight(
  env: EnvMap = {},
  init: PortsInit = {},
): readonly PreflightIssue[] {
  if (!isProduction(env)) {
    return [
      ...storeIssues(env, init),
      ...unsuppliedBackendIssues(env, init),
      ...portShapeIssues(env, init),
      ...policyKnobIssues(env, init),
      ...retiredConfigIssues(env),
    ];
  }
  return [
    ...storeIssues(env, init),
    ...unsuppliedBackendIssues(env, init),
    ...secretIssues(env, init),
    ...policyAnchorIssues(env, init),
    ...externalIssues(env, init),
    ...absenceIssues(env, init),
    ...portShapeIssues(env, init),
    ...policyKnobIssues(env, init),
    ...declineConflictIssues(env, init),
    ...retiredConfigIssues(env),
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

/**
 * The slots whose env knob names a backend the init supplied nothing for — exactly the branches
 * {@link openSelected} takes into a selector that cannot open one. The path is the knob because the
 * knob is what the operator edits; the message is the selector's own, so the deploy-time row and
 * the boot-time refusal are one sentence.
 */
function unsuppliedBackendIssues(
  env: EnvMap,
  init: PortsInit,
): PreflightIssue[] {
  const selection = envSelection(env);
  const named: UnsuppliedBackend[] = [];
  if (
    init.store === undefined &&
    (selection.store.kind === 'postgres' || selection.store.kind === 'mysql')
  ) {
    named.push(UNSUPPLIED_BACKENDS[selection.store.kind]);
  }
  if (init.cache === undefined && selection.cache.kind === 'redis') {
    named.push(UNSUPPLIED_BACKENDS.redis);
  }
  if (
    init.dispatcher === undefined &&
    selection.dispatcher.kind === 'sqs' &&
    slotStates(env, init).dispatcher === 'set'
  ) {
    named.push(UNSUPPLIED_BACKENDS.sqs);
  }
  return named.map((backend) =>
    issue('port.unsupplied', backend.variable, unsuppliedMessage(backend)),
  );
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

/**
 * Runs the wiring-time shape probe for every port the init supplies, plus the construction of the
 * env-derived rate table. A `false` is a decline, not a shape, and the type admits one only where
 * the slot is declinable.
 *
 * {@link openPorts} refuses through {@link assertPreflight}, so these rows are the boot's refusal
 * as well as the deploy-time report — one probe, not two readings that can drift.
 */
function portShapeIssues(env: EnvMap, init: PortsInit): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  for (const slot of Object.keys(PORT_SHAPES) as PortSlot[]) {
    const supplied = init[slot];
    if (supplied === undefined || supplied === false) {
      continue;
    }
    const found = portShapeFault(slot, supplied);
    if (found !== null) {
      issues.push(issue('port.malformed', slot, found));
    }
  }
  const rates = rateTableFault(env, init);
  return rates === null
    ? issues
    : [...issues, issue('port.malformed', 'rates', rates)];
}

/**
 * The policy bag's rows: a knob the init supplies outside the bounds the env resolver applies to
 * the same knob, an env knob the resolver would throw on, and an env knob it silently discards.
 *
 * This is {@link portShapeIssues}' argument one layer over. `config` and `secrets` are not ports
 * and are not in {@link PORT_SHAPES}, so the policy bag needs its own reading — and it had none:
 * an out-of-range fee supplied here was clean at every reading and mis-posted every sale.
 */
function policyKnobIssues(env: EnvMap, init: PortsInit): PreflightIssue[] {
  return configIssues(env, init.config ?? {}).map((found) =>
    issue(
      found.severity === 'error' ? 'config.invalid' : 'config.ignored',
      found.path,
      found.message,
      found.severity,
    ),
  );
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

// A renamed env name is the one config mistake nothing else can surface: no family reads it, so the
// value is ignored and the deploy runs on the default. A warning, in both postures, because the
// deployment is servable and openPorts does not throw on it.
function retiredConfigIssues(env: EnvMap): PreflightIssue[] {
  return retiredConfigKeys(env).map(([name, replacement]) =>
    issue(
      'config.retired',
      name,
      `${name} is retired and read by nothing; set ${replacement} instead.`,
      'warning',
    ),
  );
}

/**
 * Reports what a given env and init would wire. It reports presence only — no secret values,
 * no connections. `declined` versus `missing` mirrors the production absence policy.
 *
 * Every row resolves the init before the environment's selection, because the init is what
 * {@link openPorts} resolves first. `store`, `cache` and `processor` read the environment alone
 * and named the adapter a deployment had replaced: a module wiring its own payout rail was
 * reported `processor memory`, and a `cache: false` was reported as the redis `REDIS_URL` names.
 * The url stays the environment's in every branch, so the knob a supplied port overrides is still
 * on the report rather than traded away for the kind.
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
    store:
      init.store === undefined
        ? selection.store
        : { kind: 'supplied', url: selection.store.url },
    cache:
      init.cache === undefined
        ? selection.cache
        : {
            kind: init.cache === false ? 'declined' : 'supplied',
            url: selection.cache.url,
          },
    dispatcher:
      states.dispatcher === 'declined'
        ? { kind: 'declined', url: selection.dispatcher.url }
        : typeof init.dispatcher === 'function'
          ? { kind: 'in-process', url: selection.dispatcher.url }
          : selection.dispatcher,
    processor:
      init.processor !== undefined
        ? { kind: 'supplied', url: processorUrl }
        : processorUrl === null
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
 * The sole env-to-bag path. It returns the finished {@link Ports} bag that
 * {@link createEconomy} takes.
 *
 * It loads Config and Secrets — init wins per field, and both come back frozen.
 *
 * It builds the runtime and external ports with dev stand-ins outside production, and opens the
 * store the `DATABASE_URL` scheme names.
 *
 * It applies the production absence policy: each declinable port must be set or explicitly
 * declined (`false` in init, or its env decline flag). Everything {@link preflight} flags as an
 * error throws here as one CONFIG.INVALID.
 *
 * @example
 * const ports = await openPorts(process.env, {
 *   // Storage and delivery
 *   store: myStore, // optional: beats the DATABASE_URL selection
 *   cache: myCache, // optional: false declines it
 *   dispatcher: false, // optional: explicit decline; this deployment runs without outbox delivery
 *   scheduler: myScheduler, // optional: false declines it
 *   // Runtime services
 *   clock: myClock, // optional
 *   ids: myIds, // optional
 *   digest: myDigest, // optional
 *   logger: myLogger, // optional
 *   meter: myMeter, // optional
 *   // Externals
 *   signer: mySigner, // optional
 *   processor: myProcessor, // optional
 *   payees: myPayeeDirectory, // optional: false declines it
 *   anchor: myAnchor, // optional: false declines it
 *   rates: { // optional: a live Rates source or these exact integer knobs
 *     buyRate: 8_333n, buyScale: 6, // ~120 credits per dollar bought
 *     parRate: 5n, parScale: 3, // $0.005/credit backing peg
 *     payoutRate: 5n, payoutScale: 3, // $0.005/credit cash-out rate
 *   },
 *   pricing: myFeePolicy, // optional
 *   // Policy
 *   config: { platformFeeBps: 3000 }, // optional
 *   secrets: { signingSecret: mySigningSecret }, // optional: env supplies these otherwise
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
  const payees = wired(init.payees, states.payees);
  const anchor = wired(init.anchor, states.anchor);
  // The scheduler has no env decline flag, so `false` in the init is the whole of its decline.
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

/**
 * A declinable slot's port, or undefined when the slot did not resolve 'set'.
 *
 * The state is the reading {@link slotStates} already made, so `PAYEES_DECLINED=1` beats a
 * supplied directory here exactly as {@link declineConflictIssues}' warning and
 * {@link describeEnv}'s report both say it does. `dispatcher` reached the same reading through
 * {@link openSelected}; these two read the init alone, so an operator who declined payee
 * verification got it anyway while three readings reported it off.
 */
function wired<T>(
  supplied: T | false | undefined,
  state: SlotState,
): T | undefined {
  return state === 'set' && supplied !== false ? supplied : undefined;
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

// Opens the store the env selects (or the init supplies), the optional cache, and the dispatcher
// when the slot resolved 'set' — an init-supplied instance or the env-selected transport.
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
        connectTimeoutMs: config.dbConnectTimeoutMs,
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

// Emits the absence telemetry. It counts how each optional slot resolved, so a fleet dashboard
// can spot a deployment quietly running without its dispatcher.
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
 * The day-one door. It runs openPorts, createEconomy, and (unless `worker: false`) a worker
 * bound to that economy over the same bag.
 *
 * Anything a bad env would make {@link openPorts} throw, boot throws too; a misconfigured
 * deploy dies at startup.
 *
 * The init takes every {@link PortsInit} override (see the {@link openPorts} example for the
 * full wiring) plus the worker switch.
 *
 * @example
 * const { economy, worker } = await boot(process.env, {
 *   worker: true, // optional: false boots the API-process shape with worker: null
 * });
 * const stop = worker?.start(30_000); // payout, outbox, and checkpoint sweeps every 30s
 * const outcome = await economy.submit(
 *   topUp({
 *     idempotencyKey: idempotencyKey('purchase', 'evt_9001'),
 *     actor: systemActor('store'),
 *     userId: 'usr_1',
 *     amount: credits(1_200), // a 1,200-credit bundle (~$10 at the 120/$ buy rate)
 *     source: 'card',
 *   }),
 * );
 * const { transaction } = requireSuccess(outcome);
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
 * Builds a finished in-memory Ports bag for tests and quickstarts. It wires the memory store,
 * dev rates and fees, the in-memory processor, and a real Ed25519 signer seeded from
 * `signingKey`. It is sync and reads no env.
 *
 * @example
 * const ports = memoryPorts({
 *   signingKey: 'dev-signing-key',
 *   config: { platformFeeBps: 3000 }, // optional
 *   secrets: { webhookSecret: 'dev-webhook-secret' }, // optional
 *   store: myStore, // optional: defaults to a fresh in-memory store
 * });
 * const economy = createEconomy(ports);
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

/**
 * Every {@link PortsInit} field that carries a port. `config` and `secrets` are policy bags with
 * their own rows, so they are not here. {@link PORT_SHAPES} is keyed by this, so a sixteenth port
 * added to `PortsInit` leaves the table short a key and fails the typecheck.
 */
type PortSlot = Exclude<keyof PortsInit, 'config' | 'secrets'>;

/** The shape a supplied port must have, and the clause telling a caller what to pass instead. */
interface PortShape {
  /** Members the value must carry as functions. */
  readonly methods: readonly string[];
  /** Members it must carry as objects — a store's sub-stores. */
  readonly parts?: readonly string[];
  /** Set when the port IS the function; the clause names what to pass instead. */
  readonly whole?: string;
  /** Set when plain data is accepted too, told apart by `methods[0]` being absent. */
  readonly data?: PortDataShape;
}

/** The plain-data alternative a port accepts, named by the constructor that reads it. */
interface PortDataShape {
  /** The construction the boot performs. Its refusal is this row's refusal. */
  readonly build: (value: object) => unknown;
  readonly instead: string;
}

/**
 * Every port an init can supply, and the shape it must have. One row per slot, read twice:
 * {@link preflight} raises `port.malformed` off it, and {@link openPorts} refuses through
 * {@link assertPreflight} — so the deploy-time row and the boot-time refusal are one sentence and
 * neither can drift from the other. Its sibling {@link UNSUPPLIED_BACKENDS} does the same for the
 * backends the environment names.
 *
 * Every probe here is the one the wiring itself performs. `rates` accepts a live source or the
 * exact integer knobs, so its row names the constructor rather than a field list: a rate table in
 * an order that would drain the platform is refused for the constructor's own reason.
 */
const PORT_SHAPES: Readonly<Record<PortSlot, PortShape>> = {
  store: {
    methods: ['transaction', 'close'],
    parts: [
      'ledger',
      'idempotency',
      'sales',
      'outbox',
      'inbox',
      'sagas',
      'entitlements',
      'subscriptions',
      'promos',
      'trust',
      'accruals',
      'checkpoints',
      'replay',
      'movements',
    ],
  },
  clock: { methods: ['now'] },
  ids: { methods: ['next'] },
  digest: { methods: ['hash'] },
  signer: { methods: ['sign', 'verify'] },
  processor: { methods: ['submitPayout'] },
  rates: {
    methods: ['payout', 'par', 'buy'],
    data: {
      build: (value) => configuredRates(value as RatesConfig),
      instead:
        'pass a live Rates source with payout(), par() and buy(), or the exact integer knobs { buyRate, buyScale, parRate, parScale, payoutRate, payoutScale }.',
    },
  },
  pricing: {
    methods: [],
    whole: 'pass the fee policy function itself, not an object carrying one.',
  },
  logger: { methods: ['log'] },
  meter: { methods: ['count', 'observe'] },
  cache: { methods: ['get', 'set', 'invalidate'] },
  dispatcher: {
    methods: [],
    whole: 'pass the dispatch function itself, not an object carrying one.',
  },
  payees: { methods: ['status'] },
  anchor: { methods: ['publish'] },
  scheduler: { methods: ['every'] },
};

// The fault a supplied port's shape has, or null.
function portShapeFault(slot: PortSlot, value: object): string | null {
  const shape = PORT_SHAPES[slot];
  if (shape.whole !== undefined) {
    return typeof value === 'function'
      ? null
      : `${slot} is not a function; ${shape.whole}`;
  }
  if (shape.data !== undefined && !carriesFunction(value, shape.methods[0]!)) {
    return dataShapeFault(slot, value, shape.data);
  }
  const absent = (shape.parts ?? []).find(
    (part) => !carriesObject(value, part),
  );
  if (absent !== undefined) {
    return `${slot}.${absent} is missing; a supplied ${slot} must carry every member its port declares.`;
  }
  return faultOf(() => requireCallable(slot, value, shape.methods));
}

// A value that is not the live port is read as the plain data instead, by the boot's own
// constructor. Its CONFIG.INVALID is the refusal; anything else means the value is neither shape,
// and the raw TypeError of a knob read as a BigInt says nothing a caller can act on.
function dataShapeFault(
  slot: PortSlot,
  value: object,
  data: PortDataShape,
): string | null {
  try {
    data.build(value);
    return null;
  } catch (error) {
    return EconomyError.is(error)
      ? error.message
      : `${slot} is malformed: ${data.instead}`;
  }
}

function carriesFunction(value: object, member: string): boolean {
  return typeof (value as Record<string, unknown>)[member] === 'function';
}

function carriesObject(value: object, member: string): boolean {
  const part = (value as Record<string, unknown>)[member];
  return typeof part === 'object' && part !== null;
}

// The message a probe refused with, or null when it accepted.
function faultOf(probe: () => void): string | null {
  try {
    probe();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A backend an env knob names and this module does not open, with the line that supplies it. */
interface UnsuppliedBackend {
  /** How the message names it, e.g. 'a postgres:// database'. */
  readonly names: string;
  readonly pkg: string;
  /** The same factory through the @pwngh/economy umbrella, which a scaffolded module has. */
  readonly door: string;
  readonly factory: string;
  /** The factory call, written exactly as a caller types it. */
  readonly call: string;
  readonly variable: string;
  readonly slot: 'store' | 'cache' | 'dispatcher';
}

/**
 * Every backend the environment can name and this module cannot open. Each is its own package now,
 * so it arrives through `init`; what the lab owns is the refusal and the line that fixes it.
 *
 * One row per scheme, read twice: {@link preflight} raises it at deploy time and the selectors
 * below throw it at open time, off this table and this sentence. That is what keeps a `check` from
 * calling an environment clean that the boot then refuses.
 */
const UNSUPPLIED_BACKENDS: Readonly<
  Record<'postgres' | 'mysql' | 'redis' | 'sqs', UnsuppliedBackend>
> = {
  postgres: {
    names: 'a postgres:// database',
    pkg: '@pwngh/economy-postgres',
    door: '@pwngh/economy/postgres',
    factory: 'postgres',
    call: 'postgres(process.env.DATABASE_URL)',
    variable: 'DATABASE_URL',
    slot: 'store',
  },
  mysql: {
    names: 'a mysql:// database',
    pkg: '@pwngh/economy-mysql',
    door: '@pwngh/economy/mysql',
    factory: 'mysql',
    call: 'mysql(process.env.DATABASE_URL)',
    variable: 'DATABASE_URL',
    slot: 'store',
  },
  redis: {
    names: 'a redis:// instance',
    pkg: '@pwngh/economy-redis',
    door: '@pwngh/economy/redis',
    factory: 'redisCache',
    call: 'redisCache(process.env.REDIS_URL)',
    variable: 'REDIS_URL',
    slot: 'cache',
  },
  sqs: {
    names: 'an SQS queue',
    pkg: '@pwngh/economy-sqs',
    door: '@pwngh/economy/sqs',
    factory: 'sqs',
    call: 'sqs({ queueUrl: process.env.SQS_QUEUE_URL })',
    variable: 'SQS_QUEUE_URL',
    slot: 'dispatcher',
  },
};

// One message, two audiences: a module file already has the umbrella and cannot call
// openPorts, and a lab host has neither the umbrella nor the engine. Each reads its own form.
function unsuppliedMessage(named: UnsuppliedBackend): string {
  return (
    `${named.variable} names ${named.names}, but no ${named.slot} was supplied.\n` +
    `In a module file, export the ${named.slot} through the door the scaffold ships:\n\n` +
    `  import { ${named.factory} } from '${named.door}';\n\n` +
    `  export const ports = {\n` +
    `    ${named.slot}: await ${named.call},\n` +
    `  };\n\n` +
    `Install ${named.pkg} and pass it when calling the lab directly:\n\n` +
    `  import { ${named.factory} } from '${named.pkg}';\n\n` +
    `  const ports = await openPorts(process.env, {\n` +
    `    ${named.slot}: await ${named.call},\n` +
    `  });\n`
  );
}

/**
 * The error a named backend with no port supplied raises, carrying the code that fixes it.
 *
 * The environment still names the backend and {@link describeEnv} and {@link preflight} still
 * report it.
 */
function missingBackend(named: UnsuppliedBackend): EconomyError {
  return fault(ERROR_CODES.CONFIG_INVALID, unsuppliedMessage(named), {
    detail: { package: named.pkg, variable: named.variable },
    retryable: false,
  });
}

async function selectStore(
  selection: EnvSelection['store'],
  deps: {
    digest: Digest;
    clock: Clock;
    velocityWindowMs: number;
    poolMax?: number | null;
    connectTimeoutMs?: number | null;
    meter?: Meter;
    logger?: Logger;
  },
): Promise<Store> {
  if (selection.kind === 'memory') {
    return memoryStore(deps);
  }
  if (selection.kind === 'postgres' || selection.kind === 'mysql') {
    throw missingBackend(UNSUPPLIED_BACKENDS[selection.kind]);
  }
  throw fault(
    ERROR_CODES.CONFIG_INVALID,
    'DATABASE_URL must be a postgres:// or mysql:// DSN.',
    { detail: { scheme: selection.url.split(':')[0] } },
  );
}

async function selectCache(
  selection: EnvSelection['cache'],
): Promise<Cache | undefined> {
  if (selection.kind === 'none') {
    return undefined;
  }
  throw missingBackend(UNSUPPLIED_BACKENDS.redis);
}

async function selectDispatcher(
  selection: EnvSelection['dispatcher'],
): Promise<Dispatcher | undefined> {
  if (selection.kind === 'missing') {
    return undefined;
  }
  if (selection.kind === 'sqs') {
    throw missingBackend(UNSUPPLIED_BACKENDS.sqs);
  }
  const { httpDispatcher } = await import('#src/adapters/http-dispatcher.ts');
  return httpDispatcher({ url: selection.url });
}

// --- Default runtime services -----------------------------------------------------

// A malformed override is refused upstream by PORT_SHAPES, before any driver loads, so the
// fallbacks are the only values reaching here unexamined and they are this module's own.
function runtimeFrom(
  init: PortsInit,
): Pick<Ports, 'clock' | 'ids' | 'digest' | 'logger' | 'meter'> {
  return {
    clock: init.clock ?? systemClock(),
    ids: init.ids ?? randomIds(),
    digest: init.digest ?? sha256Digest(),
    logger: init.logger ?? jsonlLogger(),
    meter: init.meter ?? silentMeter(),
  };
}
