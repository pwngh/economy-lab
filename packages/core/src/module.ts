/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { EVENT_TYPES } from '@pwngh/economy-lab';
import type {
  Config,
  Operation,
  PortsInit,
  Principal,
  EconomyEvent,
  EventType,
} from '@pwngh/economy-lab';
import type { FIELDS } from '@pwngh/economy-lab/contract';
import type { InstanceEconomiesOptions } from '@pwngh/economy-lab/netting';
import type { CatalogOffer, WebhookEvent } from '@pwngh/economy-lab/server';
import { SWEEP_NAMES } from '@pwngh/economy-lab/worker';
import { EconomyModuleError, MODULE_ERROR_CODES } from './errors.js';
import { KNOB_BOUNDS, knobRule, readKnobOrNull } from './knobs.js';
import type { KnobKey } from './knobs.js';

// `@pwngh/economy-core/module` is the tooling contract subpath: what the bin needs to load a
// module, resolve it, and say what it is. Application code imports the root instead.
export { EconomyModuleError, MODULE_ERROR_CODES } from './errors.js';
export type { ModuleErrorCode } from './errors.js';
export { withDev } from './dev.js';
export { compileEconomy, compilePostures } from './truth.js';
export type { BootPosture, EconomyTruth, PolicyRow, Lint } from './truth.js';
export { knobRule, readKnobOrNull } from './knobs.js';

/** The env spelling behind each worker knob, so the module seam and the environment admit the
 *  same values. */
const WORKER_KNOBS = {
  intervalMs: 'WORKER_INTERVAL_MS',
  batch: 'WORKER_BATCH',
} as const satisfies Record<string, KnobKey>;

/** Every named export the module file may carry. Anything else refuses to boot.
 *  The seam-count tripwire pins this list at ten — a new seam is a deliberate event. */
export const KNOWN_EXPORTS = [
  'policy',
  'catalog',
  'authenticate',
  'providers',
  'worker',
  'ports',
  'instances',
  'flags',
  'after',
  'routes',
] as const;

export type RouteKey = `${'GET' | 'POST' | 'PUT' | 'DELETE'} /${string}`;

/** Which draft field names a user actor's own subject, per operation kind. The one copy of
 *  the inference table — route submission and the test personas both consume it. */
export const OWN_SUBJECT: Partial<
  Record<Operation['kind'], 'userId' | 'buyerId'>
> = {
  topUp: 'userId',
  requestPayout: 'userId',
  clawback: 'userId',
  grantPromo: 'userId',
  grantEntitlement: 'userId',
  revokeEntitlement: 'userId',
  subscribe: 'userId',
  reversePayout: 'userId',
  spend: 'buyerId',
};

/** The read resources a storefront can watch; each is one `/v1` client read. */
export type OutcomeReadKey =
  | 'wallet'
  | 'entitlements'
  | 'subscriptions'
  | 'payouts';

/** Which reads a committed operation can change, per kind. The one copy of the
 *  invalidation map — the storefront hooks refetch exactly these and nothing else.
 *  The Record is total: a new operation kind refuses to compile until it is mapped. */
export const OUTCOME_READS: Readonly<
  Record<Operation['kind'], readonly OutcomeReadKey[]>
> = {
  topUp: ['wallet'],
  spend: ['wallet', 'entitlements'],
  refund: ['wallet', 'entitlements'],
  clawback: ['wallet'],
  requestPayout: ['wallet', 'payouts'],
  settlePayout: ['payouts'],
  reversePayout: ['wallet', 'payouts'],
  // Subscribe grants the sku's entitlement in the same transaction as the charge.
  subscribe: ['wallet', 'entitlements', 'subscriptions'],
  cancelSubscription: ['subscriptions'],
  grantEntitlement: ['entitlements'],
  revokeEntitlement: ['entitlements'],
  grantPromo: ['wallet'],
  adjust: ['wallet'],
  // Reverse flips a posting's ledger legs and touches nothing else, so only wallet can move.
  reverse: ['wallet'],
};

/** One kind's server-set fields: on the operation, absent from the lab's wire table. Derived, so
 *  a second server-set field leaves the draft grammar the day the lab declares one. */
type ServerSet<O extends Operation> = Exclude<
  keyof O,
  'kind' | 'idempotencyKey' | 'actor' | keyof (typeof FIELDS)[O['kind']]
>;

type Draft<O> = O extends Operation
  ? Omit<O, 'actor' | 'idempotencyKey' | 'userId' | 'buyerId' | ServerSet<O>> &
      Partial<
        Pick<
          O,
          Extract<keyof O, 'actor' | 'idempotencyKey' | 'userId' | 'buyerId'>
        >
      >
  : never;

/** The one submit grammar: an Operation minus what the framework supplies — the actor, the
 *  key, (for a user actor) its own subject per {@link OWN_SUBJECT}, and the fields only the
 *  server sets. Route handlers return one to mean "submit this"; personas accept the same
 *  shape. A fully built Operation is a valid draft. */
export type OperationDraft = Draft<Operation>;

export type RouteHandler = (ctx: {
  readonly request: Request;
  readonly principal: Principal | null;
}) => OperationDraft | Response | Promise<OperationDraft | Response>;

// The lab handler owns these path families; a module route that collides with one refuses at boot.
const FRAMEWORK_PATHS: readonly RegExp[] = [
  /^\/v1(\/|$)/,
  /^\/healthz$/,
  /^\/readyz$/,
  /^\/webhooks(\/|$)/,
  /^\/instances(\/|$)/,
  /^\/submit$/,
];
const ROUTE_KEY = /^(GET|POST|PUT|DELETE) \/\S*$/;

export interface WorkerExport {
  /** Sweep cadence; the WORKER_INTERVAL_MS env spelling is honored too. */
  readonly intervalMs?: number;
  /** Per-job batch cap; the WORKER_BATCH env spelling is honored too. */
  readonly batch?: number;
  /** Narrow the run to these sweeps; omitted runs all sixteen. */
  readonly sweeps?: readonly string[];
}

export interface CatalogExport {
  /** The credit-pack projection; compiles to `topUpBundlesMinor`. */
  readonly bundles?: readonly (number | bigint)[];
  /** The listings lookup; compiles to the lab's catalog port, so a spend that disagrees
   *  with the offer answers CATALOG_MISMATCH on every door, routes included. */
  readonly lookup?: (
    sku: string,
  ) => CatalogOffer | null | Promise<CatalogOffer | null>;
}

/** Partial port overrides, slot name → implementation (`false` declines a declinable
 *  slot). Compiled onto `openPorts(env, overrides)`; `config` and `secrets` are not
 *  slots — policy owns one, the environment owns the other. */
export type PortsOverrides = Omit<PortsInit, 'config' | 'secrets'>;

// The real Ports slot roster; the seam refuses anything outside it. Keyed as a Record so the
// roster is checked both ways against the lab's own type: a name that is not a slot and a slot
// nobody listed are each a compile error here, rather than a legitimate override refused at
// runtime with SEAM_SHAPE.
const PORT_SLOT_SET = {
  store: true,
  clock: true,
  ids: true,
  digest: true,
  signer: true,
  processor: true,
  rates: true,
  pricing: true,
  logger: true,
  meter: true,
  cache: true,
  dispatcher: true,
  payees: true,
  anchor: true,
  scheduler: true,
} as const satisfies Record<keyof PortsOverrides, true>;

const PORT_SLOTS = Object.keys(
  PORT_SLOT_SET,
) as readonly (keyof PortsOverrides)[];

/** The policy the app runs: `catalog.bundles` compiles in as `topUpBundlesMinor`. The one
 *  copy of that merge — createApp, the desugar print, and the test harness all call it. */
export function effectivePolicy(
  mod: EconomyModule,
): Partial<Config> | undefined {
  return mod.catalog?.bundles
    ? {
        ...mod.policy,
        topUpBundlesMinor: mod.catalog.bundles.map((b) => BigInt(b)),
      }
    : mod.policy;
}

/**
 * The contract: one `economy.app.ts` with named exports, all optional except that a
 * network host must state its `authenticate` posture (a function, or `false` to trust
 * in-process callers).
 */
export interface EconomyModule {
  readonly policy?: Partial<Config>;
  readonly catalog?: CatalogExport;
  readonly authenticate?:
    | ((request: Request) => Promise<Principal | null>)
    | false;
  /** URL-addressed handlers, `'POST /checkout'` form. A returned Response passes through
   *  untouched; a returned draft ({@link OperationDraft} — the same grammar personas
   *  accept) is stamped, subject-inferred, and submitted through the one write door,
   *  answering in the exact `/v1/submit` envelope. A handler may spread a request body into
   *  its draft, so the seam screens one the same way the lab's door screens a body: a draft
   *  carrying the authenticated actor, a wire-string amount, or a server-set field is refused
   *  with a 400 that names it. */
  readonly routes?: Readonly<Record<RouteKey, RouteHandler>>;
  /** Provider name → decoder from its raw payload to a lab WebhookEvent. Presence mounts
   *  `POST /webhooks/:provider`; verified events land in the inbox for the next sweep. */
  readonly providers?: Record<
    string,
    (raw: unknown) => WebhookEvent | Promise<WebhookEvent>
  >;
  readonly worker?: WorkerExport | false;
  /** Partial port overrides compiled onto `openPorts(env, overrides)`; one line swaps one
   *  slot. A finished bag rides `createApp`'s `portsBag` option instead. */
  readonly ports?: PortsOverrides;
  /** Fast-lane options; presence opens the lanes and mounts `/instances/:scope/purchase`. */
  readonly instances?: InstanceEconomiesOptions;
  /** Post-commit handlers by event type, delivered at-least-once through the outbox relay
   *  after the money committed — never load-bearing for the money itself. */
  readonly after?: Readonly<
    Partial<Record<EventType, (event: EconomyEvent) => void | Promise<void>>>
  >;
  /** The one toggle namespace. Each flag states only its non-default form: `payouts: false`
   *  is the closed economy, `supervisor: true` composes the supervisor around the worker
   *  (it observes, it never mutates), `reads: false` unmounts the `/v1` read routes. */
  readonly flags?: {
    readonly payouts?: false;
    readonly supervisor?: true;
    readonly reads?: false;
  };
}

export interface ResolvedModule extends EconomyModule {
  readonly file: string;
  readonly exports: readonly string[];
}

// CJS-compiled modules arrive with an `__esModule` marker and a `default` that mirrors the
// named exports. Strip the marker; drop the default only when it is that mirror — an authored
// `export default` still lands in the DEFAULT_EXPORT refusal. Reads are defensive: exports
// are own string keys only (Symbol and prototype-chain properties are not exports), and a
// getter that throws refuses by name instead of escaping as a raw TypeError.
export function stripInterop(
  raw: Record<string, unknown>,
  file = 'economy.app.ts',
): Record<string, unknown> {
  const read: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    try {
      read[key] = raw[key];
    } catch (e) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        key,
        `reading the export threw (${e instanceof Error ? e.message : String(e)}) — ` +
          'an export must answer as a plain value at load time',
      );
    }
  }
  const { __esModule, default: dflt, ...named } = read;
  void __esModule;
  const names = Object.keys(named).filter((k) => named[k] !== undefined);
  if (
    dflt !== undefined &&
    typeof dflt === 'object' &&
    dflt !== null &&
    names.length
  ) {
    const inner = Object.keys(dflt);
    if (names.every((k) => inner.includes(k))) return named;
  }
  return dflt === undefined ? named : { ...named, default: dflt };
}

/** Pure and sync: validates the raw exports, constructs nothing, starts nothing. */
// complexity 87: the seam validator is one flat sequence, a named refusal per malformed
// export. Restructuring it is a deliberate piece of work, not a lint-quieting edit.
// eslint-disable-next-line complexity
export function resolveEconomyModule(
  rawExports: Record<string, unknown>,
  file = 'economy.app.ts',
): ResolvedModule {
  const raw = stripInterop(rawExports, file);
  if ('default' in raw && raw.default !== undefined) {
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.DEFAULT_EXPORT,
      file,
      'default',
      `the module file uses named exports only — rename \`export default\` to one of: ${KNOWN_EXPORTS.join(', ')}`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) continue;
    if (key === 'http') {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.NOT_YET,
        file,
        'http',
        'the name is reserved and takes no options — `reads: false` lives in `flags`',
      );
    }
    if (key === 'ops') {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.UNKNOWN_EXPORT,
        file,
        'ops',
        'the supervisor toggle moved into the flags namespace — `export const flags = { supervisor: true }`',
      );
    }
    if (!(KNOWN_EXPORTS as readonly string[]).includes(key)) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.UNKNOWN_EXPORT,
        file,
        key,
        `not part of the EconomyModule contract — did you mean one of: ${KNOWN_EXPORTS.join(', ')}?`,
      );
    }
  }
  const policyExport = raw.policy;
  if (policyExport !== undefined) {
    if (typeof policyExport === 'function') {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'policy',
        'a factory is not a policy — export the resolved object, or hand a built config to createApp through portsBag',
      );
    }
    if (
      typeof policyExport !== 'object' ||
      policyExport === null ||
      Array.isArray(policyExport)
    ) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'policy',
        `must be a config object (knob → value), got ${
          policyExport === null
            ? 'null'
            : Array.isArray(policyExport)
              ? 'array'
              : typeof policyExport
        }`,
      );
    }
  }
  const portsExport = raw.ports;
  if (portsExport !== undefined) {
    if (typeof portsExport === 'function') {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'ports',
        'the seam takes partial overrides (slot name → implementation) — ' +
          "a full-bag factory rides createApp's portsBag option instead",
      );
    }
    if (
      typeof portsExport !== 'object' ||
      portsExport === null ||
      Array.isArray(portsExport)
    ) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'ports',
        `must be a partial overrides object (slot name → implementation), got ${
          Array.isArray(portsExport) ? 'array' : typeof portsExport
        }`,
      );
    }
    for (const k of Object.keys(portsExport)) {
      if (k === 'config') {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'ports',
          'config is not a slot — the `policy` export owns it',
        );
      }
      if (k === 'secrets') {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'ports',
          'secrets are not a slot — they ride the environment (WEBHOOK_SECRET, SIGNING_SECRET), never the module file',
        );
      }
      if (!(PORT_SLOTS as readonly string[]).includes(k)) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'ports',
          `"${k}" is not a Ports slot — the fifteen slots: ${PORT_SLOTS.join(', ')}`,
        );
      }
    }
  }
  const inst = raw.instances;
  if (
    inst !== undefined &&
    (typeof inst !== 'object' || inst === null || Array.isArray(inst))
  ) {
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.SEAM_SHAPE,
      file,
      'instances',
      `must be an InstanceEconomiesOptions object, got ${Array.isArray(inst) ? 'array' : typeof inst}`,
    );
  }
  const prov = raw.providers;
  if (prov !== undefined) {
    if (typeof prov !== 'object' || prov === null || Array.isArray(prov)) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'providers',
        'must be an object of decoders',
      );
    }
    for (const [k, v] of Object.entries(prov)) {
      if (typeof v !== 'function') {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'providers',
          `providers.${k} must be a function (raw) => WebhookEvent, got ${typeof v}`,
        );
      }
    }
  }
  const cat = raw.catalog as CatalogExport | undefined;
  if (cat !== undefined) {
    if (typeof cat !== 'object' || cat === null || Array.isArray(cat)) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'catalog',
        'must be `{ bundles?, lookup? }`',
      );
    }
    for (const k of Object.keys(cat)) {
      if (k !== 'bundles' && k !== 'lookup') {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'catalog',
          `catalog.${k} is not part of the seam — the two halves are bundles and lookup`,
        );
      }
    }
    if (
      cat.bundles !== undefined &&
      (!Array.isArray(cat.bundles) ||
        cat.bundles.some((b) => typeof b !== 'number' && typeof b !== 'bigint'))
    ) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'catalog',
        'catalog.bundles must be a list of minor-unit amounts (number or bigint)',
      );
    }
    if (cat.lookup !== undefined && typeof cat.lookup !== 'function') {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.NOT_A_FUNCTION,
        file,
        'catalog',
        `catalog.lookup must be a function (sku) => { price, recipients } | null, got ${typeof cat.lookup}`,
      );
    }
    if (
      cat.bundles !== undefined &&
      (raw.policy as Partial<Config> | undefined)?.topUpBundlesMinor !==
        undefined
    ) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.ROLE_CONFLICT,
        file,
        'catalog',
        'both catalog.bundles and policy.topUpBundlesMinor are set — one owner: keep one',
      );
    }
  }
  const routes = raw.routes;
  if (routes !== undefined) {
    if (
      typeof routes !== 'object' ||
      routes === null ||
      Array.isArray(routes)
    ) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'routes',
        'must be an object of handlers keyed like `"POST /checkout"`',
      );
    }
    for (const [k, v] of Object.entries(routes)) {
      if (!ROUTE_KEY.test(k)) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'routes',
          `"${k}" is not a route key — the form is "METHOD /path" with GET, POST, PUT, or DELETE`,
        );
      }
      const path = k.slice(k.indexOf(' ') + 1);
      if (FRAMEWORK_PATHS.some((p) => p.test(path))) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.ROLE_CONFLICT,
          file,
          'routes',
          `"${k}" collides with the framework's own routes ` +
            '(/submit, /v1/*, /healthz, /readyz, /webhooks/*, /instances/*) — pick another path',
        );
      }
      if (typeof v !== 'function') {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'routes',
          `routes["${k}"] must be a handler function, got ${typeof v}`,
        );
      }
    }
  }
  const after = raw.after;
  if (after !== undefined) {
    if (typeof after !== 'object' || after === null || Array.isArray(after)) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'after',
        'must be an object of event handlers, keyed by event type',
      );
    }
    for (const [k, v] of Object.entries(after)) {
      if (!(EVENT_TYPES as readonly string[]).includes(k)) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.UNKNOWN_EVENT,
          file,
          'after',
          `unknown event "${k}" — the fourteen events: ${EVENT_TYPES.join(', ')}`,
        );
      }
      if (typeof v !== 'function') {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'after',
          `after["${k}"] must be a function (event) => void, got ${typeof v}`,
        );
      }
    }
  }
  const flags = raw.flags;
  if (flags !== undefined) {
    if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'flags',
        'must be an object',
      );
    }
    // Each shipped flag states only its non-default form; the default is stated by absence.
    const FLAG_FORMS: Record<string, { legal: boolean; means: string }> = {
      payouts: {
        legal: false,
        means: '`payouts: false` is the closed economy',
      },
      supervisor: {
        legal: true,
        means: '`supervisor: true` composes the supervisor around the worker',
      },
      reads: {
        legal: false,
        means: '`reads: false` unmounts the /v1 read routes',
      },
    };
    for (const [k, v] of Object.entries(flags)) {
      // `flags.ops` was the spelling through 0.7.0 and became `flags.supervisor` with the
      // `./ops` → `./supervisor` move. Without this it falls to the reserved-name refusal
      // below, which tells a migrating host its own flag is a name nobody has claimed yet.
      if (k === 'ops') {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.UNKNOWN_EXPORT,
          file,
          'flags',
          'the flag was renamed with the entry point — `flags: { supervisor: true }`, and the module moved from `@pwngh/economy-lab/ops` to `@pwngh/economy-lab/supervisor`',
        );
      }
      const form = FLAG_FORMS[k];
      if (!form) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.NOT_YET,
          file,
          'flags',
          `\`${k}\` is a new first use and stays reserved — the shipped flags: payouts: false, supervisor: true, reads: false`,
        );
      }
      if (v !== form.legal) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          file,
          'flags',
          `flags.${k} takes only \`${String(form.legal)}\` — ${form.means}; the default is stated by leaving it out`,
        );
      }
    }
    if (
      (flags as { supervisor?: true }).supervisor === true &&
      raw.worker === false
    ) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.SEAM_SHAPE,
        file,
        'flags',
        'the supervisor observes the worker — drop `worker: false` or the supervisor flag',
      );
    }
  }
  const auth = raw.authenticate;
  if (auth !== undefined && auth !== false && typeof auth !== 'function') {
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.NOT_A_FUNCTION,
      file,
      'authenticate',
      `must be a function (request => Principal | null) or the literal \`false\`, got ${typeof auth}`,
    );
  }
  const worker = raw.worker as WorkerExport | false | undefined;
  if (
    worker !== undefined &&
    worker !== false &&
    (typeof worker !== 'object' || worker === null)
  ) {
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.BAD_WORKER,
      file,
      'worker',
      'must be `false` or `{ intervalMs?, batch?, sweeps? }`',
    );
  }
  if (worker) {
    for (const field of ['intervalMs', 'batch'] as const) {
      const v = worker[field];
      const key = WORKER_KNOBS[field];
      if (
        v !== undefined &&
        (typeof v !== 'number' || readKnobOrNull(key, v, KNOB_BOUNDS) === null)
      ) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.BAD_WORKER,
          file,
          'worker',
          `${field} takes ${knobRule(key, KNOB_BOUNDS)}, got ${
            typeof v === 'number' ? String(v) : typeof v
          }`,
        );
      }
    }
    if (worker.sweeps !== undefined && !Array.isArray(worker.sweeps)) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.BAD_WORKER,
        file,
        'worker',
        `sweeps must be an array of sweep names, got ${typeof worker.sweeps}`,
      );
    }
  }
  if (worker && worker.sweeps) {
    for (const s of worker.sweeps) {
      if (!(SWEEP_NAMES as readonly string[]).includes(s)) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.UNKNOWN_SWEEP,
          file,
          'worker',
          `unknown sweep "${s}" — the sixteen sweeps: ${SWEEP_NAMES.join(', ')}`,
        );
      }
    }
  }
  return Object.freeze({
    ...(raw as EconomyModule),
    file,
    exports: Object.keys(raw).filter((k) => raw[k] !== undefined),
  });
}
