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

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The package root, so a test can reach its manifest and its built library. */
export const PKG = new URL('../..', import.meta.url).pathname;

/** What the suite spawns: the same two lines the shipped bin runs. */
export const CLI = new URL('./entry.ts', import.meta.url).pathname;

export const TSX = fileURLToPath(import.meta.resolve('tsx'));

// The only names a spawned node process takes from the machine. Everything the economy reads is
// stated by the caller instead, because the package fan-out runs under `--env-file-if-exists=.env`
// and an inherited environment hands the CLI a DATABASE_URL, a REDIS_URL and a pair of secrets the
// test never asked for. It also drops NODE_TEST_CONTEXT, which a child that inherits it reads as
// an instruction to report on the reporter protocol.
const INHERITED = ['PATH', 'HOME', 'TMPDIR'] as const;

/**
 * The whole environment a spawned CLI sees: the machine names above, then exactly what the test
 * states. A stated name wins, and a name neither list carries is absent.
 */
export function childEnv(
  env: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return { ...base, NODE_ENV: '', ...env };
}

/** The knobs that name a backend the lab opens no driver for, so a module must supply the port. */
const SELECTED_BACKENDS = [
  'DATABASE_URL',
  'REDIS_URL',
  'SQS_QUEUE_URL',
] as const;

/**
 * Runs `body` with those knobs cleared, then puts them back.
 *
 * The in-process twin of {@link childEnv}: a verb called through `runEconomy` reads `process.env`
 * itself, so there is no child to state an environment for. This repository's `.env` names a
 * postgres and a redis, and preflight refuses a module that supplies no port for a named
 * backend — which would make the verb's verdict a fact about the machine, not about the module.
 */
export async function withoutSelectedBackends<T>(
  body: () => Promise<T>,
): Promise<T> {
  const held = new Map(
    SELECTED_BACKENDS.map((name) => [name, process.env[name]] as const),
  );
  for (const name of SELECTED_BACKENDS) delete process.env[name];
  try {
    return await body();
  } finally {
    for (const [name, value] of held) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// spawnSync waits forever by default, so a verb that stops refusing and binds instead would wedge
// the suite rather than fail it. Past this bound the run is killed and answers with a signal.
const SYNC_BOUND_MS = 30_000;

export const runSync = (
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) =>
  spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv(env),
    timeout: SYNC_BOUND_MS,
  });

/** Detached, so `stop` can signal the whole group and reach a re-exec'd grandchild. */
export const runLive = (
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) =>
  spawn(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    detached: true,
    env: childEnv(env),
  });

/** How a run ended, once it has. */
export interface Ended {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface Watched {
  out(): string;
  err(): string;
  /** The exit, or null while the run is still going. */
  ended(): Ended | null;
}

export function collect(child: ChildProcess): Watched {
  let out = '';
  let err = '';
  let ended: Ended | null = null;
  child.stdout!.on('data', (d: Buffer) => {
    out += d.toString();
  });
  child.stderr!.on('data', (d: Buffer) => {
    err += d.toString();
  });
  // 'close' rather than 'exit': it fires once both pipes are at EOF, so everything the run printed
  // is already in `out` and `err` by the time a waiter reads them.
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    ended = { code, signal };
  });
  return { out: () => out, err: () => err, ended: () => ended };
}

const both = (seen: Watched): string =>
  `stdout:\n${seen.out()}\nstderr:\n${seen.err()}`;

/**
 * Waits for `pattern` on the run's stdout. A run that ends first ends the wait with it — a boot
 * that refuses prints its reason on stderr and exits, and waiting out the clock for stdout that
 * can no longer arrive reports the refusal as a timeout with nothing to read.
 */
export async function until(
  seen: Watched,
  pattern: RegExp,
  ms = 20_000,
): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = seen.out();
    if (pattern.test(text)) return text;
    const ended = seen.ended();
    if (ended !== null) {
      throw new Error(
        `exited code ${ended.code}, signal ${ended.signal}, without ${pattern}\n${both(seen)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${pattern}\n${both(seen)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// SIGTERM the whole group, then wait for the process itself to go. A verb that hands its run
// to a re-exec still owns the exit, so an early exit here is the failure, never the teardown.
export function stop(child: ChildProcess, ms = 20_000): Promise<number | null> {
  const done = new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(
        new Error(
          `pid ${child.pid} exited before stop() — code ${child.exitCode}, ` +
            `signal ${child.signalCode}; a re-exec was orphaned`,
        ),
      );
      return;
    }
    const timer = setTimeout(
      () => reject(new Error(`pid ${child.pid} ignored SIGTERM`)),
      ms,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  try {
    process.kill(-child.pid!, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  return done;
}
