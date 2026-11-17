/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { createApp, type App } from '@pwngh/economy-core';
import { devTokens } from '@pwngh/economy-auth';
import {
  compileEconomy,
  resolveEconomyModule,
  EconomyModuleError,
  MODULE_ERROR_CODES,
  withDev,
} from '@pwngh/economy-core/module';
import type { EconomyTruth, ResolvedModule } from '@pwngh/economy-core/module';
import { seedDemo } from '@pwngh/economy-core/internal';
import { loadEconomyDir } from '../module.js';
import {
  detectRuntime,
  isPortInUse,
  platformOwner,
  serveFetch,
} from '../platform.js';
import { ReExecuted } from '../cli.js';
import type { Sink } from '../cli.js';
import type { Args } from '../parse-args.js';

// Node strips types by default from 22.18, this package's floor, so a TypeScript module file
// fails to load only where --no-experimental-strip-types turned that off. One re-exec undoes it.
async function importModule(url: string): Promise<Record<string, unknown>> {
  try {
    return await import(url);
  } catch (e) {
    if (
      (e as { code?: string }).code === 'ERR_UNKNOWN_FILE_EXTENSION' &&
      process.env.ECONOMY_TS_REEXEC !== '1'
    ) {
      const r = spawnSync(
        process.execPath,
        ['--experimental-strip-types', ...process.argv.slice(1)],
        { stdio: 'inherit', env: { ...process.env, ECONOMY_TS_REEXEC: '1' } },
      );
      throw new ReExecuted(r.status ?? 1);
    }
    throw e;
  }
}

export const isDir = (path: string): boolean =>
  existsSync(path) && statSync(path).isDirectory();

/** Coalesces an editor's several writes of one save into a single reload. */
const RELOAD_DEBOUNCE_MS = 120;

/** A dev watch that can be released: the debounce timer and the watcher go together, so the run
 *  that opened them can hand back one handle and close both. */
interface Reloader {
  close(): void;
}

/** Watches the module file and calls `reload` once per settled change. Nothing here decides what
 *  a reload does — the caller owns the service. */
function watchModule(path: string, reload: () => Promise<void>): Reloader {
  let pending: NodeJS.Timeout | null = null;
  const watcher: FSWatcher = watch(path, { recursive: isDir(path) }, () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
  });
  return {
    close() {
      watcher.close();
      if (pending) clearTimeout(pending);
    },
  };
}

/** The file every verb runs under when one is beside the module. One rule for all five doors:
 *  the file fills only the names the real environment left unset. */
export const ENV_FILE = '.env';

/**
 * Puts `.env` into the process environment the way `node --env-file` does — a name already set
 * wins — and hands back the undo. Returns `null` when there is no file.
 *
 * A module file is a program: this repository's own reads `process.env` at load time and exports
 * different ports for it. So the environment has to be in place *before* the import, or a verb
 * describes a module nobody is going to run. `dev` re-execs under `--env-file` and the `start`
 * and `worker` scripts pass `--env-file-if-exists`; this is how `check`, `routes`, `serve`, and
 * the worker role reach the same one. `parseEnv` is node's own reader, the one behind that flag.
 */
export function adoptEnvFile(): (() => void) | null {
  const file = resolve(ENV_FILE);
  if (!existsSync(file)) return null;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  const added = Object.keys(parsed).filter(
    (name) => process.env[name] === undefined,
  );
  for (const name of added) process.env[name] = parsed[name];
  // Only the names this call added come back out: runEconomy never exits the process, so an
  // embedding host keeps whatever is left behind.
  return () => {
    for (const name of added) delete process.env[name];
  };
}

export async function load(args: Args, generation: number) {
  const path = resolve(args.file);
  if (isDir(path)) {
    return loadEconomyDir(path, {
      generation,
      importer: importModule,
      label: relative(process.cwd(), path) || '.',
    });
  }
  if (!existsSync(path)) {
    // No file and none named: run on defaults. A named file that is missing stays an error.
    if (!args.explicit)
      return resolveEconomyModule({}, '(defaults — no economy.app.ts)');
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.NOT_FOUND,
      relative(process.cwd(), path),
      '(file)',
      'create it — `export const authenticate = false` is a complete dev module — or point --app at yours',
    );
  }
  const raw = await importModule(`${pathToFileURL(path).href}?v=${generation}`);
  // The resolver reads the namespace defensively — no spread here, so a hostile export
  // (a getter that throws) lands as a named refusal, never a raw TypeError.
  return resolveEconomyModule(raw, relative(process.cwd(), path));
}

/** The dev startup banner: posture, store, routes count, the three curls — nothing else. */
// max-params 5: the banner's inputs are passed positionally; an options object is the
// register's form and the change belongs with a caller sweep, not this pass.
// eslint-disable-next-line max-params
function devBanner(
  mod: ResolvedModule,
  truth: EconomyTruth,
  host: string,
  port: number,
  worker: boolean,
): string {
  const base = `http://${host}:${port}`;
  const tokens = devTokens();
  const user = tokens[0]!.token;
  const system =
    tokens.find((t) => t.token.startsWith('dev_system'))?.token ?? user;
  const posture =
    mod.authenticate === undefined
      ? 'dev tokens (module states no posture)'
      : mod.authenticate === false
        ? 'trusted (in-process only)'
        : 'module authenticate (function)';
  const store = mod.ports
    ? `module ports (${Object.keys(mod.ports).join(', ')})`
    : 'memory (dev posture)';
  const body = JSON.stringify({
    kind: 'topUp',
    idempotencyKey: 'try-1',
    userId: 'usr_ada',
    amount: 'CREDIT:100.00',
    source: 'card',
  });
  return [
    `economy dev — ${mod.file} on ${host}:${port}${worker ? ', worker running' : ''}`,
    `  posture  ${posture}`,
    `  store    ${store}`,
    `  routes   ${truth.routes.length}`,
    `  curl ${base}/healthz`,
    `  curl -H 'authorization: Bearer ${user}' ${base}/v1/wallet`,
    `  curl -X POST ${base}/submit -H 'authorization: Bearer ${system}' -H 'content-type: application/json' -d '${body}'`,
  ].join('\n');
}

interface Service {
  readonly app: App;
  readonly banner: string;
  close(): Promise<void>;
}

/** The drain every shutdown here is cut from: what `App.close()` gives the Node listener, what
 *  the Bun and Deno legs are handed, and half of the wedge backstop. */
const shutdownBudget = (app: App): number =>
  app.config.find((k) => k.key === 'SHUTDOWN_TIMEOUT_MS')!.value;

// complexity 18: one boot sequence, branching per verb and per declined port.
// eslint-disable-next-line complexity
async function up(
  args: Args,
  generation: number,
  dev: boolean,
): Promise<Service> {
  const mod = await load(args, generation);
  if (args.cmd === 'worker' && mod.worker === false) {
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.ROLE_CONFLICT,
      mod.file,
      'worker',
      '`worker: false` under the worker role runs nothing — drop the export, or run serve',
    );
  }
  const definition = dev ? withDev(mod, process.env) : mod;
  // One compile at boot; the banner and the non-node bind read it, not ad-hoc state.
  const truth = compileEconomy(definition, process.env, args.flags);
  const serverRole = args.cmd !== 'worker';
  const workerRole = args.cmd === 'worker' || args.worker;
  const app = await createApp(definition, {
    flags: args.flags,
    // --no-worker is the API-process shape; listen() then binds without background work.
    ...(workerRole ? {} : { worker: false }),
  });
  // dev binds loopback; --host widens it deliberately. serve binds all interfaces.
  const host = args.host ?? (args.cmd === 'dev' ? '127.0.0.1' : undefined);
  // Typed with the drain required, so the http step cannot be closed without a budget.
  let closeHttp: ((drainMs: number) => Promise<void>) | null = null;
  let port: number | null = null;
  if (serverRole) {
    const runtime = detectRuntime();
    if (runtime === 'node') {
      // listen() starts the background half itself and registers the server into close().
      port = (await app.listen(args.flags.PORT, host)).port;
    } else {
      const served = await serveFetch(
        runtime,
        app.handler,
        args.flags.PORT ?? truth.knobs.find((k) => k.key === 'PORT')!.value,
        host,
      );
      closeHttp = served.close;
      port = served.port;
      app.startWorker();
    }
  } else {
    app.startWorker();
  }
  let banner =
    dev && port !== null
      ? `${devBanner(mod, truth, host ?? '0.0.0.0', port, workerRole)}\n`
      : `economy ${args.cmd} — ${mod.file}${port === null ? '' : ` on ${host ?? '0.0.0.0'}:${port}`}${workerRole ? ', worker running' : ''}\n`;
  if (args.demo) banner += `${await seedDemo(app.economy)}\n`;
  return {
    app,
    banner,
    close: async () => {
      // Node's listener is closed by app.close() with this same budget; the Bun and Deno legs are
      // not registered there, so they are drained here rather than left to wait unbounded.
      if (closeHttp) await closeHttp(shutdownBudget(app));
      await app.close();
    },
  };
}

/** serve is the production posture; every refusal happens before a socket binds.
 *  Resolves the exit code to answer with, or null when nothing refused. */
async function refuseServeStandIns(
  args: Args,
  err: Sink,
): Promise<number | null> {
  const owner = platformOwner(process.cwd());
  if (owner) {
    err.write(
      `this app deploys as ${owner.platform} — \`${owner.command}\` runs it; ` +
        'economy serve is for standalone hosts (`economy routes` proves the shape)\n',
    );
    return 1;
  }
  if (process.env.NODE_ENV !== 'production') {
    err.write(
      'economy serve is the production posture — set NODE_ENV=production; local runs use `economy dev`\n',
    );
    return 1;
  }
  const mod = await load(args, 0);
  if (mod.authenticate === undefined) {
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.AUTH_POSTURE,
      mod.file,
      'authenticate',
      'serve refuses to bind without a posture — export a function, or `false` for in-process trust',
    );
  }
  // The same compile `check` prints, so the refusal and the report it points at cannot disagree
  // about the module's own ports.
  const hard = compileEconomy(mod, process.env, args.flags).preflight.filter(
    (i) => (i as { severity?: string }).severity === 'error',
  );
  if (hard.length) {
    for (const i of hard) err.write(`preflight  ${JSON.stringify(i)}\n`);
    err.write(
      'serve refuses dev stand-ins — fix the environment (economy check shows it)\n',
    );
    return 1;
  }
  return null;
}

// dev's one hand-off: the runtime's watcher restarts the process, and on Node --env-file
// loads .env. Null means no hand-off; a promise means the re-exec owns the run.
function handOffDev(args: Args, out: Sink): Promise<number> | null {
  if (process.env.ECONOMY_DEV_REEXEC === '1') return null;
  const runtime = detectRuntime();
  // Bun and Deno load .env themselves; only Node needs the flag.
  const envFile = runtime === 'node' && existsSync(resolve(ENV_FILE));
  if (!args.watch && !envFile) return null;
  if (args.watch) {
    out.write(
      `--watch: the ${runtime} watcher restarts the whole process on change — ` +
        `in-memory state is lost each time${args.demo ? '; --demo reseeds every boot' : ''}\n`,
    );
  }
  if (envFile) out.write('.env loaded via node --env-file\n');
  const [bin, argv]: [string, string[]] =
    runtime === 'bun'
      ? [
          'bun',
          [
            ...(args.watch ? ['--watch'] : []),
            process.argv[1]!,
            ...process.argv.slice(2),
          ],
        ]
      : runtime === 'deno'
        ? [
            'deno',
            [
              'run',
              ...(args.watch ? ['--watch'] : []),
              '-A',
              process.argv[1]!,
              ...process.argv.slice(2),
            ],
          ]
        : [
            process.execPath,
            [
              ...process.execArgv,
              // The watched process must read a .ts module through node's own loader, or the file
              // never joins the watch graph. The flag holds stripping open if NODE_OPTIONS closed it.
              ...(args.watch ? ['--watch', '--experimental-strip-types'] : []),
              ...(envFile ? [`--env-file=${ENV_FILE}`] : []),
              ...process.argv.slice(1),
            ],
          ];
  const child = spawn(bin, argv, {
    stdio: 'inherit',
    env: { ...process.env, ECONOMY_DEV_REEXEC: '1' },
  });
  const relays = (['SIGINT', 'SIGTERM'] as const).map(
    (signal) => [signal, () => child.kill(signal)] as const,
  );
  for (const [signal, relay] of relays) process.on(signal, relay);
  // This process outlives the re-exec and answers with its code: exiting here would orphan a
  // running server and hand the shell back while the port is still held.
  return new Promise((settle) => {
    child.on('exit', (code, signal) => {
      // Released with the child: runEconomy never exits the process, so a host driving it in
      // a loop would otherwise accumulate a relay per call until node warns about listeners.
      for (const [name, relay] of relays) process.off(name, relay);
      settle(code ?? (signal ? 1 : 0));
    });
  });
}

/** Names the process listening on a port, as `lsof -Fcp` reports it. */
export type PortProbe = (port: number) => string;

// Injectable because the probe shells out, and the refusal must survive that failing: Deno denies
// node:child_process without --allow-run, and a throw here would replace the refusal it serves.
const lsofProbe: PortProbe = (port) =>
  spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fcp'], {
    encoding: 'utf8',
  }).stdout ?? '';

/** One line for the taken port: the holder by name, and the escape hatch. */
export function portInUseLine(
  e: { port?: number },
  cmd: string,
  probe: PortProbe = lsofProbe,
): string {
  const port = e.port ?? 0;
  return `port ${port} is in use by ${holderOf(port, probe)} — stop it, or pick another: economy ${cmd} --port ${port + 1}`;
}

function holderOf(port: number, probe: PortProbe): string {
  let reported = '';
  try {
    reported = probe(port);
  } catch {
    // A probe that cannot run says nothing about the holder, and saying nothing is the answer
    // below. There is no second way to ask.
  }
  const pid = /^p(\d+)$/m.exec(reported)?.[1];
  const command = /^c(.+)$/m.exec(reported)?.[1];
  return pid && command ? `${command} (pid ${pid})` : 'another process';
}

export async function runService(
  args: Args,
  out: Sink,
  err: Sink,
): Promise<number> {
  // The mirror of serve's refusal: dev is the memory posture with dev tokens — never
  // something to point at a production environment.
  if (args.cmd === 'dev' && process.env.NODE_ENV === 'production') {
    err.write(
      'economy dev is the dev posture — unset NODE_ENV=production; production runs use `economy serve`\n',
    );
    return 1;
  }
  // dev's .env arrives through the re-exec below; serve and the worker role adopt the same
  // file here, before the refusals compile the module, so the boot check judges is the boot
  // that happens. The undo runs when the run ends, for a host driving this in-process.
  const restoreEnv = args.cmd === 'dev' ? null : adoptEnvFile();
  try {
    if (restoreEnv) out.write('.env in place — a name already set wins\n');
    return await runServiceUnderEnv(args, out, err);
  } finally {
    restoreEnv?.();
  }
}

async function runServiceUnderEnv(
  args: Args,
  out: Sink,
  err: Sink,
): Promise<number> {
  if (args.cmd === 'serve') {
    const refused = await refuseServeStandIns(args, err);
    if (refused !== null) return refused;
  }
  if (args.cmd === 'dev') {
    const handedOff = handOffDev(args, out);
    if (handedOff) return handedOff;
  }
  let generation = 0;
  let service: Service;
  try {
    service = await up(args, generation, args.cmd === 'dev');
  } catch (e) {
    // One shape for all three runtimes: Node raises it, and the Fetch legs are normalized onto it
    // at the bind, where the port asked for is still known.
    if (isPortInUse(e)) {
      err.write(`${portInUseLine(e, args.cmd)}\n`);
      return 1;
    }
    throw e;
  }
  // The verb runs until a signal says otherwise; the caller exits on the code we resolve.
  let stopped: (code: number) => void;
  const running = new Promise<number>((resolve) => {
    stopped = resolve;
  });
  // worker binds nothing, so a parked timer is what holds the role open.
  const parked = args.cmd === 'worker' ? setInterval(() => {}, 1 << 30) : null;
  let closing = false;
  const shutdown = async () => {
    // One close per process: a group kill lands the signal twice on a re-exec'd child, and the
    // handler has to stay installed to absorb the second — removing it here left the default
    // action to kill the process, so the run answered by signal instead of draining.
    if (closing) return;
    closing = true;
    if (parked) clearInterval(parked);
    // close() is drain-bounded; if it still wedges, the run answers 1 and the caller owns
    // the exit. A process.exit here would take an embedding host down with it.
    const timer = setTimeout(() => stopped(1), shutdownBudget(service.app) * 2);
    timer.unref?.();
    await service.close();
    stopped(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Default dev watch: the module file only, restarted in-process. --watch hands the whole
  // graph to the runtime watcher instead.
  const reload =
    args.cmd === 'dev' && !args.watch && existsSync(resolve(args.file))
      ? watchModule(resolve(args.file), async () => {
          if (closing) return;
          out.write(`\n${args.file} changed — restarting\n`);
          await service.close();
          try {
            service = await up(args, (generation += 1), true);
            out.write(service.banner);
          } catch (e) {
            err.write(`${e instanceof Error ? e.message : String(e)}\n`);
            if (EconomyModuleError.is(e))
              err.write('run `economy check` for the full picture\n');
          }
        })
      : null;
  try {
    // A reader can signal as soon as this reaches its pipe. Announce readiness only after
    // the handlers and watcher exist, so that signal drains instead of taking the default exit.
    out.write(service.banner);
    return await running;
  } finally {
    // Everything this run opened, released once it is over. runEconomy never calls process.exit,
    // so a host driving it in-process keeps whatever is left: a live watcher holds the host's
    // event loop open and can still fire, building a second app against the service just closed,
    // and a signal handler per call accumulates until node warns about listeners.
    reload?.close();
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.off(signal, shutdown);
  }
}
