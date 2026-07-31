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

import { describeEnv, inspectConfig, preflight } from '@pwngh/economy-lab';
import { SWEEP_NAMES } from '@pwngh/economy-lab/worker';
import {
  KNOWN_EXPORTS,
  effectivePolicy,
  resolveEconomyModule,
} from './module.js';
import type { EconomyModule, ResolvedModule } from './module.js';
import { portsInit, resolveConfig } from './app.js';
import type { Knob, KnobKey } from './app.js';
import { withDev } from './dev.js';
import { activeSweeps, capabilitiesReport, posture } from './inspect.js';
import type { Capabilities } from './inspect.js';

type Env = Record<string, string | undefined>;
type PreflightIssue = ReturnType<typeof preflight>[number];

export interface PolicyRow {
  readonly key: string;
  readonly value: string;
  readonly source: 'module' | 'env' | 'default';
}

export interface Lint {
  readonly name: string;
  readonly message: string;
}

/** What the module and its environment actually resolve to. `check` and `routes` are
 *  projections of one of these; there is no plan file and no hashes. */
export interface EconomyTruth {
  readonly module: {
    readonly file: string;
    readonly exports: readonly string[];
  };
  readonly seams: readonly { name: string; present: boolean }[];
  readonly posture: string;
  readonly policy: readonly PolicyRow[];
  readonly knobs: readonly Knob[];
  /** describeEnv's shape — adapter kinds and presence, never a secret value. */
  readonly adapters: Record<string, unknown>;
  readonly routes: readonly {
    method: string;
    path: string;
    source: 'product' | 'module';
  }[];
  readonly capabilities: Capabilities;
  readonly preflight: readonly PreflightIssue[];
  readonly lints: readonly Lint[];
  readonly desugar: string;
}

/** One posture the CLI can boot, and the verdict the boot will reach in it. `deployed` is what
 *  `serve` and `worker` run; `dev` is what `economy dev` runs, which decorates the definition
 *  with the memory posture and loads `.env` before `createApp` opens anything. */
export interface BootPosture {
  readonly name: 'deployed' | 'dev';
  readonly preflight: readonly PreflightIssue[];
}

/**
 * Every posture `economy check` has to answer for, each judged on the bag {@link createApp} will
 * actually open for it. The two verbs resolve different definitions — `dev` decorates the module
 * with the memory posture, the deployed verbs do not — so one verdict cannot describe both, and
 * a `check` that printed only one was a promise the other boot did not keep.
 *
 * A production environment answers with the deployed posture alone: `economy dev` refuses to run
 * at all under `NODE_ENV=production`, so there is no dev boot to describe.
 */
export function compilePostures(
  mod: ResolvedModule,
  env: Env,
): readonly BootPosture[] {
  const deployed = {
    name: 'deployed' as const,
    preflight: preflight(env, portsInit(mod)),
  };
  if (describeEnv(env).production) return [deployed];
  return [
    deployed,
    { name: 'dev', preflight: preflight(env, portsInit(withDev(mod, env))) },
  ];
}

const show = (v: unknown): string =>
  typeof v === 'bigint'
    ? v.toString()
    : Array.isArray(v)
      ? v.map(show).join(',')
      : typeof v === 'object' && v !== null
        ? JSON.stringify(v, (_k, x: unknown) =>
            typeof x === 'bigint' ? x.toString() : x,
          )
        : String(v);

interface PolicyTables {
  /** One row per key, the value in force, provenance-tagged. */
  readonly rows: PolicyRow[];
  readonly moduleRows: PolicyRow[];
  /** Keys whose resolved value differs from the env-free rendering. */
  readonly envRows: PolicyRow[];
}

// inspectConfig throws on missing production anchors; the table then degrades to the module's own
// rows and the preflight rows carry the failure.
function policyTables(mod: ResolvedModule, env: Env): PolicyTables {
  const overrides = mod.policy;
  const moduleKeys = new Set(Object.keys(overrides ?? {}));
  const envFree = inspectConfig({}, overrides) as unknown as Record<
    string,
    unknown
  >;
  const moduleRows = [...moduleKeys].sort().map((key) => ({
    key,
    value: show(envFree[key]),
    source: 'module' as const,
  }));
  try {
    const resolved = inspectConfig(env, overrides) as unknown as Record<
      string,
      unknown
    >;
    const fromEnv = inspectConfig(env) as unknown as Record<string, unknown>;
    const defaults = inspectConfig({}) as unknown as Record<string, unknown>;
    const rows = Object.keys(resolved).map((key) => ({
      key,
      value: show(resolved[key]),
      source: moduleKeys.has(key)
        ? ('module' as const)
        : show(fromEnv[key]) !== show(defaults[key])
          ? ('env' as const)
          : ('default' as const),
    }));
    const envRows = rows
      .filter((r) => show(resolved[r.key]) !== show(envFree[r.key]))
      .map((r) => ({ key: r.key, value: r.value, source: 'env' as const }));
    return { rows, moduleRows, envRows };
  } catch {
    return { rows: moduleRows, moduleRows, envRows: [] };
  }
}

/** The advisory half of `economy check`; a lint never blocks `createApp`. */
export function lintModule(mod: ResolvedModule, env: Env): Lint[] {
  const out: Lint[] = [];
  const p = (mod.policy ?? {}) as Record<string, unknown>;
  const bundles = p.topUpBundlesMinor as
    | readonly (number | bigint)[]
    | undefined;
  if (bundles && bundles.length && bundles.every((b) => Number(b) < 10_000)) {
    out.push({
      name: 'bundle-unit-suspect',
      message:
        'every topUpBundlesMinor entry is under 10000 — whole credits written as minor units?',
    });
  }
  // Fires on the key's presence, null included — module config beats env and is frozen,
  // so a pinned pause key removes the runtime pause lever.
  if ('pauseStartMs' in p || 'pauseEndMs' in p) {
    out.push({
      name: 'pause-pinned',
      message:
        'the module pins the pause keys; the emergency lane is ECONOMY_PAUSE_START_MS / ECONOMY_PAUSE_END_MS in env',
    });
  }
  if (mod.exports.includes('providers') && !env.WEBHOOK_SECRET) {
    out.push({
      name: 'providers-without-secret',
      message:
        'providers exported but WEBHOOK_SECRET is unset in this environment',
    });
  }
  const w = mod.worker;
  if (w && w.sweeps && w.sweeps.length) {
    out.push({
      name: 'worker-only-steady',
      message: `worker.sweeps narrows the cycle to ${w.sweeps.length} of ${SWEEP_NAMES.length} sweeps — an incident tool as steady state`,
    });
  }
  return out;
}

/** The module's expansion to the lab floor, values inlined — every step is a public call. */
// complexity 18: one rendering pass, a branch per optional piece of the module.
// eslint-disable-next-line complexity
export function renderDesugar(
  mod: ResolvedModule,
  knobs: readonly Knob[],
): string {
  const knob = (key: string) => knobs.find((k) => k.key === key)!.value;
  const literal = (v: unknown): string =>
    typeof v === 'bigint'
      ? `${v}n`
      : Array.isArray(v)
        ? `[${v.map(literal).join(', ')}]`
        : typeof v === 'string'
          ? JSON.stringify(v)
          : typeof v === 'object' && v !== null
            ? `{ ${Object.entries(v)
                .map(([k, x]) => `${k}: ${literal(x)}`)
                .join(', ')} }`
            : String(v);
  const effective = effectivePolicy(mod);
  const policy = effective ? literal(effective) : 'undefined';
  const auth =
    mod.authenticate === false
      ? 'false'
      : typeof mod.authenticate === 'function'
        ? 'module.authenticate'
        : 'devAuthenticate(devTokens())';
  const w = mod.worker;
  // The bag is rebound for every seam that decorates it, so it can only be `const` when none do.
  // The supervisor is one of them: it swaps in a wrapped logger and meter before the economy
  // is built, which is the only reason its signal feed sees anything.
  const bind =
    mod.after || mod.catalog?.lookup || mod.flags?.supervisor ? 'let' : 'const';
  const lines = [
    `// ${mod.file} desugars to the floor — every step is a public @pwngh/economy-lab call:`,
    `import { openPorts, createEconomy, createWorker, createServer } from '@pwngh/economy-lab';`,
    '',
    mod.ports
      ? `${bind} ports = await openPorts(process.env, { ...module.ports, config: ${policy} }); ` +
        `// overrides: ${Object.keys(mod.ports).join(', ')}`
      : `${bind} ports = await openPorts(process.env, { config: ${policy} });`,
    ...(mod.after
      ? [
          `// after: ${Object.keys(mod.after).join(', ')} — delivered by the outbox relay,`,
          '// at-least-once, retried to maxOutboxAttempts, 5000 ms per handler (a hang is a throw)',
          'const dispatcher = async (event) => module.after[event.type]?.(event);',
          'ports = { ...ports, dispatcher };',
        ]
      : []),
    ...(mod.catalog?.lookup
      ? [
          '// catalog.lookup rides in the bag, not in the server options: submit checks the price a',
          '// spend names against the live offer, so every door answers CATALOG_MISMATCH, not one',
          'ports = { ...ports, catalog: { lookup: module.catalog.lookup } };',
        ]
      : []),
    // Before createEconomy, exactly as createApp does it: the economy and the worker have to
    // emit through the wrapped ports, or the detectors watch a feed nothing writes to.
    ...(mod.flags?.supervisor
      ? [
          `const supervisorRuntime = createSupervisorRuntime({ meter: ports.meter, logger: ports.logger, clock: ports.clock }); // from '@pwngh/economy-lab/supervisor'`,
          'ports = { ...ports, logger: supervisorRuntime.logger, meter: supervisorRuntime.meter };',
        ]
      : []),
    'const economy = createEconomy(ports);',
    ...(mod.instances
      ? [
          `const instances = openInstanceEconomies(ports, ${literal(mod.instances)}); // from '@pwngh/economy-lab/netting'`,
        ]
      : []),
    ...(mod.flags?.payouts === false
      ? [
          '// flags.payouts: false — closed economy: the rail declines every submit, the payouts',
          '// sweep keeps running, so an accepted saga fails fast and its hold releases',
        ]
      : []),
    ...(w === false
      ? ['// worker: false — no sweeps run']
      : [
          `const worker = createWorker(ports, economy, { limit: ${knob('WORKER_BATCH')}${activeSweeps(mod) ? `, only: ${literal(activeSweeps(mod))}` : ''} });`,
          `const stop = worker.start(${knob('WORKER_INTERVAL_MS')});`,
        ]),
    // The supervisor itself comes last of the three, because it drives the worker's sweep.
    ...(mod.flags?.supervisor && w !== false
      ? [
          `const supervisor = createSupervisor({ clock: ports.clock, signals: supervisorRuntime.signals, sagas: ports.store.sagas, runSweep: (now) => worker.sweep({ now, limit: ${knob('WORKER_BATCH')} }), audit: jsonlAuditSink((line) => ports.logger.log('info', 'supervisor.audit', { line })) }); // from '@pwngh/economy-lab/supervisor'`,
        ]
      : []),
    ...(mod.routes
      ? [
          `// routes: ${Object.keys(mod.routes).join(', ')} — a table checked before the lab handler:`,
          '// authenticate → principal (null → 401); a returned Response passes through untouched;',
          '// a returned draft is stamped with the principal as actor (a user principal fills its',
          "// own userId/buyerId per OWN_SUBJECT), keyed from the caller's idempotency-key header",
          '// (else x-request-id, else 400), submitted through economy.submit, and answered in the',
          '// exact /v1/submit envelope.',
        ]
      : []),
    `const handler = createServer({ economy, ports, authenticate: ${auth} });`,
    `// host handler anywhere; economy.close() owns shutdown (drain bound ${knob('SHUTDOWN_TIMEOUT_MS')} ms)`,
  ];
  return lines.join('\n');
}

/**
 * The one compile: everything `check` and `routes` say is a projection of this value.
 * Pure over (definition, env, flags) — opens nothing, dials nothing, reads no ambient state.
 */
export function compileEconomy(
  definition: EconomyModule | ResolvedModule | Record<string, unknown>,
  env: Env,
  flags: Partial<Record<KnobKey, number>> = {},
): EconomyTruth {
  const mod =
    'file' in definition && 'exports' in definition
      ? (definition as ResolvedModule)
      : resolveEconomyModule(definition as Record<string, unknown>);
  const knobs = resolveConfig(mod, env, flags);
  const policy = policyTables(mod, env);
  const seams = KNOWN_EXPORTS.map((name) => ({
    name,
    present: mod.exports.includes(name),
  }));
  const capabilities = capabilitiesReport(mod, mod.authenticate !== undefined);
  const moduleRoutes = new Set(
    Object.keys(mod.routes ?? {}).map(
      (k) => `${k.slice(0, k.indexOf(' '))} ${k.slice(k.indexOf(' ') + 1)}`,
    ),
  );
  const routes = capabilities.routes.map((r) => ({
    ...r,
    source: moduleRoutes.has(`${r.method} ${r.path}`)
      ? ('module' as const)
      : ('product' as const),
  }));
  // The bag createApp would open, so both readings describe the boot that is going to happen:
  // a port the module wires is reported as wired and is not demanded from the environment.
  const init = portsInit(mod);
  return {
    module: { file: mod.file, exports: mod.exports },
    seams,
    posture: posture(mod),
    policy: policy.rows,
    knobs,
    adapters: describeEnv(env, init) as unknown as Record<string, unknown>,
    routes,
    capabilities,
    preflight: preflight(env, init),
    lints: lintModule(mod, env),
    desugar: renderDesugar(mod, knobs),
  };
}
