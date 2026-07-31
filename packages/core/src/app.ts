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

import {
  createEconomy,
  createServer,
  createWorker,
  openPorts,
  readIntOrNull,
} from '@pwngh/economy-lab';
import type {
  Economy,
  EconomyEvent,
  EventType,
  Ports,
  PortsInit,
  FetchHandler,
  Worker,
} from '@pwngh/economy-lab';
import { openInstanceEconomies } from '@pwngh/economy-lab/netting';
import type { InstanceEconomies } from '@pwngh/economy-lab/netting';
import { handleWebhook } from '@pwngh/economy-lab/server';
import type { Supervisor } from '@pwngh/economy-lab/supervisor';

type SupervisorModule = typeof import('@pwngh/economy-lab/supervisor');
import { effectivePolicy, resolveEconomyModule } from './module.js';
import type { EconomyModule, ResolvedModule } from './module.js';
import {
  KNOB_BOUNDS,
  KNOB_DEFAULTS,
  knobRule,
  readKnobOrNull,
} from './knobs.js';
import type { KnobKey } from './knobs.js';
import { composeRoutes } from './routes.js';
import { EconomyModuleError, MODULE_ERROR_CODES } from './errors.js';
import {
  activeSweeps,
  capabilitiesReport,
  inspectReport,
  posture,
  type Capabilities,
  type InspectReport,
} from './inspect.js';

export { KNOB_DEFAULTS } from './knobs.js';
export type { KnobKey } from './knobs.js';

/** The `openPorts` init a module compiles to: its port overrides, plus its policy as config.
 *  The one copy of that bag — `createApp` opens the ports with it and `check` judges the same
 *  one, so a port the module wires is never demanded from the environment as well. */
export function portsInit(mod: EconomyModule): PortsInit {
  return { ...mod.ports, config: effectivePolicy(mod) };
}

export interface Knob {
  readonly key: KnobKey;
  readonly value: number;
  readonly source: 'definition' | 'flag' | 'env' | 'default';
}

const DEFINITION: Partial<Record<KnobKey, 'intervalMs' | 'batch'>> = {
  WORKER_INTERVAL_MS: 'intervalMs',
  WORKER_BATCH: 'batch',
};

export function resolveConfig(
  mod: ResolvedModule,
  env: Record<string, string | undefined>,
  flags: Partial<Record<KnobKey, number>> = {},
): Knob[] {
  return (Object.keys(KNOB_DEFAULTS) as KnobKey[]).map((key) => {
    const def = DEFINITION[key];
    const fromModule = def && mod.worker ? mod.worker[def] : undefined;
    if (fromModule !== undefined)
      return { key, value: fromModule, source: 'definition' };
    const flag = flags[key];
    if (flag !== undefined) {
      const read = readKnobOrNull(key, flag);
      if (read === null) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.SEAM_SHAPE,
          mod.file,
          '(flags)',
          `${key} takes ${knobRule(key)} — got ${JSON.stringify(flag)}`,
        );
      }
      return { key, value: read, source: 'flag' };
    }
    // The lab's rule, not a second one: `Number()` here read `0x1f` as 31, `8080.5` as a
    // fractional port, and `WORKER_BATCH=0` as a worker that sweeps nothing.
    const fromEnv = readIntOrNull(env[key], KNOB_BOUNDS[key]);
    if (fromEnv !== null) {
      return { key, value: fromEnv, source: 'env' };
    }
    return { key, value: KNOB_DEFAULTS[key], source: 'default' };
  });
}

export interface CreateAppOptions {
  readonly file?: string;
  readonly env?: Record<string, string | undefined>;
  readonly flags?: Partial<Record<KnobKey, number>>;
  /** A finished bag that wins wholesale: `openPorts` never runs, the module's `ports`
   *  overrides and `policy` are not applied — the caller owns the bag, config included.
   *  The harness door; the test harness compiles policy into its own bag.
   *  Ownership follows creation, so `close()` never touches a bag supplied here: you built
   *  it, you release it. `createEconomy(bag).close()` does that in one call. */
  readonly portsBag?: Ports;
  /** Per-process role, mirroring the lab's BootInit: default true; `false` builds the
   *  API-process shape — `worker: null`, no supervisor, and `listen()` starts no
   *  background work. The module's `worker: false` disables construction for every
   *  process instead. */
  readonly worker?: boolean;
}

export interface App {
  readonly module: ResolvedModule;
  readonly config: readonly Knob[];
  readonly ports: Ports;
  readonly economy: Economy;
  readonly worker: Worker | null;
  /** The fast-lane manager when the module exports `instances`; its sweep rides startWorker(). */
  readonly instances: InstanceEconomies | null;
  /** The supervisor when the module flags `supervisor: true`; its tick rides startWorker(). */
  readonly supervisor: Supervisor | null;
  /** WinterCG handler from lab's createServer; host it anywhere. Reading it without an
   *  `authenticate` posture throws AUTH_POSTURE — in-process `economy` use needs none. */
  readonly handler: FetchHandler;
  /** Node host: binds, then starts the background half (worker timer, lanes, supervisor tick) —
   *  nothing ticks before listen. Registers the server into close(). A process built with
   *  the `worker: false` option binds only. */
  listen(port?: number, host?: string): Promise<{ port: number }>;
  /** Starts the background half without binding: the worker-role process, and hosts that
   *  mount `handler` on their own framework instead of calling listen(). Idempotent —
   *  listen() calls it too. */
  startWorker(): void;
  /** Ordered, idempotent: http → timers → in-flight sweep → lanes → economy, drain-bounded by
   *  SHUTDOWN_TIMEOUT_MS. The http step gives an answer already in flight that long to finish
   *  and cuts what is left, so this resolves with the listener down rather than with a request
   *  nobody will ever answer still holding it. The economy step releases the ports only when
   *  this app opened them; a `portsBag` you supplied stays yours to close. */
  close(): Promise<void>;
  inspect(): InspectReport;
  /** What this app actually mounts and runs; `economy routes` prints it. */
  capabilities(): Capabilities;
}

// complexity 30: the composition root, one optional port at a time. Restructuring it is a
// deliberate piece of work, not a lint-quieting edit.
// eslint-disable-next-line complexity
export async function createApp(
  module: EconomyModule | ResolvedModule | Record<string, unknown>,
  options: CreateAppOptions = {},
): Promise<App> {
  const mod =
    'file' in module && 'exports' in module
      ? (module as ResolvedModule)
      : resolveEconomyModule(module as Record<string, unknown>, options.file);
  const env = options.env ?? process.env;
  const config = resolveConfig(mod, env, options.flags);
  const knob = (key: KnobKey) => config.find((k) => k.key === key)!.value;

  const authenticate = mod.authenticate;

  // Provenance, carried to close(): only a bag this call opened is this call's to release.
  const ownsPorts = options.portsBag === undefined;
  // One assembly path. The dev posture is not an option here: `withDev(definition)`
  // decorates the definition, and this path treats its injections like any authored seam.
  let ports: Ports = options.portsBag ?? (await openPorts(env, portsInit(mod)));
  // The catalog rides in the bag, not in the server options: `createEconomy` is the one thing
  // every door has in common, so wiring it here is what puts the price check on all of them.
  const lookup = mod.catalog?.lookup;
  if (lookup) {
    ports = { ...ports, catalog: { lookup: async (sku) => lookup(sku) } };
  }
  if (mod.after) {
    if (ports.dispatcher) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.ROLE_CONFLICT,
        mod.file,
        'after',
        'the ports bag already carries a dispatcher — one owner per seam: ' +
          'drop the `after` export, or the dispatcher',
      );
    }
    ports = { ...ports, dispatcher: afterDispatcher(mod.after) };
  }
  if (mod.flags?.payouts === false) {
    // Closed economy: the rail takes the request, hands back a reference, and then reports the
    // transfer failed — which is how a real provider declines. Throwing instead would say
    // nothing: the sweep reads a throw as a hand-off whose answer was lost and holds the
    // seller's reserve for the whole settlement window. An answered FAILED releases it on the
    // next sweep, through the evidence path.
    ports = {
      ...ports,
      processor: {
        submitPayout: async ({ key }) => ({
          providerRef: `payouts_off_${key}`,
        }),
        payoutStatus: async () => ({ state: 'FAILED' as const }),
      },
    };
  }
  let supervisorMod: SupervisorModule | null = null;
  let supervisorRuntime: ReturnType<
    SupervisorModule['createSupervisorRuntime']
  > | null = null;
  if (mod.flags?.supervisor && options.worker !== false) {
    supervisorMod = await import('@pwngh/economy-lab/supervisor');
    supervisorRuntime = supervisorMod.createSupervisorRuntime({
      meter: ports.meter,
      logger: ports.logger,
      clock: ports.clock,
    });
    // Economy and worker emit through the wrapped meter and logger; that feed is the detector's input.
    ports = {
      ...ports,
      logger: supervisorRuntime.logger,
      meter: supervisorRuntime.meter,
    };
  }
  const economy = createEconomy(ports);
  // options.worker is the per-process role; the module's `worker: false` is the posture.
  const worker =
    mod.worker === false || options.worker === false
      ? null
      : createWorker(ports, economy, {
          limit: knob('WORKER_BATCH'),
          only: activeSweeps(mod),
        });
  const supervisor =
    supervisorMod && supervisorRuntime && worker
      ? supervisorMod.createSupervisor({
          clock: ports.clock,
          signals: supervisorRuntime.signals,
          sagas: ports.store.sagas,
          runSweep: (now: number) =>
            worker.sweep({ now, limit: knob('WORKER_BATCH') }),
          audit: supervisorMod.jsonlAuditSink((line: string) =>
            ports.logger.log('info', 'supervisor.audit', { line }),
          ),
        })
      : null;
  const instances = mod.instances
    ? openInstanceEconomies(ports, mod.instances)
    : null;
  const providers = mod.providers;
  const webhook =
    providers && Object.keys(providers).length
      ? async (provider: string, request: Request): Promise<Response> => {
          const decode = providers[provider];
          if (!decode) return new Response('unknown provider', { status: 404 });
          const receipt = await handleWebhook(
            ports.store,
            { ids: ports.ids, clock: ports.clock, meter: ports.meter },
            await decode(await request.json()),
          );
          return new Response(
            JSON.stringify({ status: receipt.status, id: receipt.entry.id }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      : undefined;
  // The network face needs the posture; the in-process economy never does.
  const labHandler =
    authenticate === undefined
      ? null
      : createServer({
          economy,
          ports,
          authenticate,
          instances: instances ?? undefined,
          webhook,
          ...(mod.flags?.reads === false ? { reads: false as const } : {}),
        });
  const handler =
    labHandler !== null && mod.routes && Object.keys(mod.routes).length
      ? composeRoutes(mod, { economy, authenticate: authenticate! }, labHandler)
      : labHandler;
  const requireHandler = (): FetchHandler => {
    if (!handler) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.AUTH_POSTURE,
        mod.file,
        'authenticate',
        'a network host states its posture — export a function (request => Principal | null), ' +
          'or `export const authenticate = false` to trust in-process callers only',
      );
    }
    return handler;
  };

  let stopWorker: (() => void) | null = null;
  let sweepInFlight: Promise<unknown> | null = null;
  let stopLanes: (() => void) | null = null;
  let stopSupervisor: (() => void) | null = null;
  let httpClose: ((drainMs?: number) => Promise<void>) | null = null;
  let httpOpening: Promise<{ port: number }> | null = null;
  let httpPort: number | null = null;
  let closing: Promise<void> | null = null;

  // The background half — worker timer, lanes, supervisor tick. Idempotent; a `worker: false`
  // process (API shape) has nothing to start and stays inert.
  const startBackground = (): void => {
    if (options.worker === false) return;
    if (worker && !stopWorker) {
      // Own timer instead of worker.start(): ticks never overlap, and close() can await
      // the in-flight sweep before the store goes away.
      const timer = setInterval(() => {
        sweepInFlight ??= worker
          .sweep({ limit: knob('WORKER_BATCH') })
          .finally(() => {
            sweepInFlight = null;
          });
      }, knob('WORKER_INTERVAL_MS'));
      timer.unref?.();
      stopWorker = () => clearInterval(timer);
    }
    if (instances && !stopLanes)
      stopLanes = instances.start(knob('WORKER_INTERVAL_MS'));
    if (supervisor && !stopSupervisor) {
      stopSupervisor =
        supervisor.start?.(knob('WORKER_INTERVAL_MS')) ??
        (() => {
          const timer = setInterval(
            () => void supervisor.tick(),
            knob('WORKER_INTERVAL_MS'),
          );
          timer.unref?.();
          return () => clearInterval(timer);
        })();
    }
  };

  return {
    module: mod,
    config,
    ports,
    economy,
    worker,
    instances,
    supervisor,
    get handler() {
      return requireHandler();
    },
    async listen(port = knob('PORT'), host?: string) {
      if (closing) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.LISTEN_AFTER_CLOSE,
          mod.file,
          '(lifecycle)',
          'this app is closed — create a new one',
        );
      }
      // The latch is taken in the synchronous prefix, so an overlapping listen() cannot bind twice.
      if (httpClose || httpOpening) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.ALREADY_LISTENING,
          mod.file,
          '(lifecycle)',
          httpPort === null
            ? 'a listen() is already in flight — close() first'
            : `already listening on :${httpPort} — close() first`,
        );
      }
      httpOpening = (async () => {
        try {
          // Imported here rather than at the top so this module stays loadable where there is
          // no node:http; only listen() needs Node.
          const { serveNode } = await import('@pwngh/economy-lab/adapters');
          const served = await serveNode(requireHandler(), { port, host });
          httpClose = served.close;
          httpPort = served.port;
          // The bind held; nothing ticked before this line.
          startBackground();
          return { port: served.port };
        } finally {
          httpOpening = null;
        }
      })();
      return httpOpening;
    },
    startWorker() {
      if (closing) {
        throw new EconomyModuleError(
          MODULE_ERROR_CODES.LISTEN_AFTER_CLOSE,
          mod.file,
          '(lifecycle)',
          'this app is closed — create a new one',
        );
      }
      startBackground();
    },
    close() {
      return (closing ??= (async () => {
        const bound = sleep(knob('SHUTDOWN_TIMEOUT_MS'));
        // Awaited rather than raced: the listener drains for the shutdown budget and cuts past
        // it, so it is already bounded, and a race would let close() return with the socket
        // still up — which is the hang this ends, arriving through a quieter door.
        if (httpClose) await httpClose(knob('SHUTDOWN_TIMEOUT_MS'));
        stopWorker?.();
        stopLanes?.();
        stopSupervisor?.();
        if (sweepInFlight) await Promise.race([sweepInFlight, bound]);
        if (instances) await Promise.race([instances.settleAll(), bound]);
        // A caller-supplied portsBag stays open: it was never ours to end.
        if (ownsPorts) await Promise.race([economy.close(), bound]);
      })());
    },
    capabilities: () => capabilitiesReport(mod, handler !== null),
    inspect: () =>
      inspectReport(mod, config, {
        posture:
          authenticate === false
            ? 'trusted (in-process only)'
            : typeof authenticate === 'function'
              ? 'function'
              : posture(mod),
        ports: options.portsBag
          ? 'portsBag (caller-supplied)'
          : mod.ports
            ? `openPorts(env) + overrides: ${Object.keys(mod.ports).join(', ')}`
            : 'openPorts(env)',
        port: httpPort,
      }),
  };
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** Per-handler delivery timeout; past it the attempt counts as a throw and the relay retries. */
const AFTER_TIMEOUT_MS = 5_000;

// The after seam compiled to the outbox relay's transport: at-least-once, retried to
// maxOutboxAttempts, never load-bearing for the money already committed.
function afterDispatcher(
  after: NonNullable<EconomyModule['after']>,
): (event: EconomyEvent) => Promise<void> {
  return async (event) => {
    const handler = after[event.type as EventType];
    if (!handler) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `after["${event.type}"] timed out at ${AFTER_TIMEOUT_MS} ms`,
            ),
          ),
        AFTER_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.resolve(handler(event)), bound]);
    } finally {
      clearTimeout(timer);
    }
  };
}
