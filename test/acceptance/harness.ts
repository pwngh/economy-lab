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
 * Everything the acceptance tier needs to take a scaffolded project from a packed tarball to a
 * running service, in one place: the workspace pack, the install, the build, the boot, and the
 * money leg.
 *
 * Two suites drive it and they differ only in posture. `create-economy.walk.test.ts` runs every
 * offered combination under `economy dev`, which is the memory posture and needs no rig;
 * `acceptance/rigs.test.ts` runs the same projects under `economy serve` against a real engine.
 * Both were going to need the same six hundred lines, and the second copy is where the first one
 * stops being true.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readRootPackage,
  readWorkspace,
} from '#scripts/support/workspace-graph.ts';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGE = join(ROOT, 'packages', 'create-economy');
const TEMPLATE_DIR = join(PACKAGE, 'templates');

/**
 * Read, never spelled: the scaffolder's name decides its tarball key and its install path, and a
 * hand-written copy of it drifts from the manifest silently.
 */
export const SCAFFOLDER = JSON.parse(
  readFileSync(join(PACKAGE, 'package.json'), 'utf8'),
).name as string;

const OPTIONS = join(PACKAGE, 'dist', 'lib', 'options.js');

/**
 * Nested bounds, each strictly inside the next, so a wedge is named at the level it happened on.
 * One npm command may take COMMAND_BOUND_MS; one leg — pack, or scaffold through serve — may take
 * LEG_BOUND_MS; and the file as a whole answers to the runner's --test-timeout. A per-test bound
 * above that outer one is fiction: the file is cancelled first and the number never applies.
 */
export const COMMAND_BOUND_MS = 180_000;
export const LEG_BOUND_MS = 240_000;
export const REQUEST_BOUND_MS = 30_000;

/** How long a booted service gets to bind and answer its own health check. */
export const READY_CEILING_MS = 90_000;

/** How long a stopped service gets to exit before it is killed outright. A service holding an
 *  engine pool must be gone before its throwaway namespace is dropped under it. */
export const STOP_BOUND_MS = 20_000;

export type Selection = Readonly<Record<string, string>>;

/**
 * The scaffolder's own table is the row list, so a combination added to the menu is walked
 * without anyone remembering to add it. Empty when the scaffolder is not built; the suites assert
 * that rather than silently walking nothing.
 */
export const rows: readonly Selection[] = existsSync(OPTIONS)
  ? (
      (await import(pathToFileURL(OPTIONS).href)) as {
        combinations(): readonly Selection[];
      }
    ).combinations()
  : [];

/**
 * The template directories on disk, which is what the row list is counted against. A template
 * shipped and never offered — or offered and never shipped — is a scaffolder nobody can check.
 */
export const TEMPLATES: readonly string[] = existsSync(TEMPLATE_DIR)
  ? readdirSync(TEMPLATE_DIR)
      .filter((name) => statSync(join(TEMPLATE_DIR, name)).isDirectory())
      .sort()
  : [];

export interface Ran {
  readonly code: number;
  readonly out: string;
}

export interface RunOptions {
  /** Names added to the child's environment. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * True to run on `env` alone rather than on this process's environment.
   *
   * The production posture reads the environment for every port it has, so a run that inherits
   * this repository's `.env` is reading a developer's REDIS_URL and TASKQ as if the deployment had
   * stated them — and the refusal that follows belongs to the harness, not to the thing under
   * test. Only what a process needs to execute at all is kept.
   */
  readonly stated?: boolean;
}

/** What a stated run keeps: enough to find an interpreter and a scratch directory. */
function baseEnv(stated: boolean): NodeJS.ProcessEnv {
  if (!stated) return { ...process.env };
  const { PATH, HOME, TMPDIR, SHELL } = process.env;
  return { PATH, HOME, TMPDIR, SHELL };
}

/**
 * One command to completion, stdout and stderr together, never throwing on a bad code.
 *
 * The test runner exports NODE_TEST_CONTEXT to its children, and a nested `node --test` that
 * sees it reports to a parent that is not listening and exits 0 with failing tests. Scrubbing
 * it is what keeps the template's own suite a real leg instead of a green light.
 */
export function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Ran {
  const env = { ...baseEnv(options.stated === true), ...options.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const r = spawnSync(cmd, [...args], {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: COMMAND_BOUND_MS,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export const ok = (r: Ran, what: string): void =>
  assert.equal(r.code, 0, `${what} answered ${r.code}\n${r.out.slice(-4000)}`);

/** The stem npm packs a package into: `@` dropped, `/` turned into `-`, version appended. */
const packStem = (name: string) => name.replace(/^@/, '').replace(/\//g, '-');

const ROSTER = [readRootPackage(ROOT).name, ...readWorkspace(ROOT).keys()];

/**
 * The package a tarball holds.
 *
 * The name cannot be read back out of the filename — `@pwngh/economy-lab` and an unscoped
 * `pwngh-economy-lab` pack to the same stem — so the file is matched against the real roster and
 * one matching nothing is refused rather than given an invented key. The comparison is exact
 * because `pwngh-economy-` prefixes `pwngh-economy-lab-`, and a startsWith would hand the
 * umbrella's key to the lab's tarball.
 */
export function packageOf(file: string): string {
  const stem = file.replace(/-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tgz$/, '');
  const name = ROSTER.find((member) => packStem(member) === stem);
  assert.ok(name, `${file} matches no package in the workspace`);
  return name;
}

/** The packed workspace, keyed by package name, as a `file:` specifier npm can install. */
function tarballs(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.tgz')) continue;
    out[packageOf(file)] = `file:${join(dir, file)}`;
  }
  return out;
}

/**
 * Points the scaffolded project at the workspace tarballs. They are copied in and named
 * relatively, so the lockfile npm writes holds no path outside the project and a Docker build
 * context carries everything the install needs.
 *
 * The direct dependency has to carry the same specifier as its override or npm refuses the
 * pair (EOVERRIDE), so the umbrella is rewritten and everything it drags in is overridden.
 */
function useWorkspaceBuild(project: string, tarDir: string): void {
  const vendor = join(project, 'vendor');
  mkdirSync(vendor, { recursive: true });
  const spec: Record<string, string> = {};
  for (const file of readdirSync(tarDir)) {
    if (!file.endsWith('.tgz')) continue;
    copyFileSync(join(tarDir, file), join(vendor, file));
    spec[packageOf(file)] = `file:vendor/${file}`;
  }
  const path = join(project, 'package.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies: Record<string, string>;
    overrides?: Record<string, string>;
  };
  json.dependencies['@pwngh/economy'] = spec['@pwngh/economy']!;
  json.overrides = Object.fromEntries(
    Object.entries(spec).filter(([name]) => name !== '@pwngh/economy'),
  );
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

export interface Workspace {
  /** The throwaway directory every project of this run is scaffolded into. */
  readonly dir: string;
  readonly tarDir: string;
  /** The packed scaffolder's own bin, run from a clean install of its tarball. */
  readonly scaffolder: string;
  readonly packed: Readonly<Record<string, string>>;
  clean(): void;
}

/**
 * Packs the workspace and installs the scaffolder out of its own tarball.
 *
 * Tarballs, not a workspace link: this proves what a published install actually resolves,
 * `files` and `exports` included. The scaffolder runs from its tarball too, so a template left
 * out of `files` fails here rather than in a stranger's terminal.
 */
export function openWorkspace(): Workspace {
  assert.ok(
    existsSync(join(ROOT, 'dist', 'src', 'index.js')),
    'the lab dist is missing — run `npm run build` first',
  );
  assert.ok(
    existsSync(join(PACKAGE, 'dist', 'bin.js')),
    'create-economy is not built',
  );

  const dir = mkdtempSync(join(tmpdir(), 'economy-acc-'));
  const tarDir = join(dir, 'tarballs');
  mkdirSync(tarDir);

  ok(
    run(
      'npm',
      [
        'pack',
        `--pack-destination=${tarDir}`,
        '--workspaces',
        '--include-workspace-root',
        '--ignore-scripts',
      ],
      ROOT,
    ),
    'npm pack of the workspace',
  );
  const packed = tarballs(tarDir);
  for (const name of ['@pwngh/economy', '@pwngh/economy-lab', SCAFFOLDER]) {
    assert.ok(packed[name], `${name} did not pack`);
  }

  const launcher = join(dir, 'launcher');
  mkdirSync(launcher);
  writeFileSync(
    join(launcher, 'package.json'),
    JSON.stringify({ name: 'launcher', private: true, version: '0.0.0' }),
  );
  ok(
    run(
      'npm',
      ['install', '--no-audit', '--no-fund', packed[SCAFFOLDER]!.slice(5)],
      launcher,
    ),
    'installing the packed scaffolder',
  );
  const scaffolder = join(
    launcher,
    'node_modules',
    ...SCAFFOLDER.split('/'),
    'dist',
    'bin.js',
  );
  assert.ok(existsSync(scaffolder), 'the packed scaffolder ships its bin');

  return {
    dir,
    tarDir,
    scaffolder,
    packed,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** One scaffolded project: where it landed, and the selection that produced it. */
export interface Project {
  readonly dir: string;
  readonly name: string;
  readonly selection: Selection;
}

/**
 * Scaffolds one combination and installs it against the packed workspace. Stops short of the
 * build so a caller can edit the module first — which is what the rig matrix does.
 */
export function scaffold(ws: Workspace, selection: Selection): Project {
  const name = `acc-${Object.values(selection).join('-')}`;
  const dir = join(ws.dir, name);
  const flags = Object.entries(selection).flatMap(([id, value]) => [
    `--${id}`,
    value,
  ]);

  ok(
    run(process.execPath, [ws.scaffolder, name, ...flags, '--yes'], ws.dir),
    'scaffold',
  );
  assert.ok(existsSync(join(dir, 'economy.app.ts')), 'the module file landed');

  // What the scaffolder wrote, before the vendored rewrite: the umbrella and nothing else.
  const written = JSON.parse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
  ) as { name: string; dependencies: Record<string, string> };
  assert.deepEqual(
    Object.keys(written.dependencies),
    ['@pwngh/economy'],
    'a scaffolded project depends on the umbrella alone',
  );
  assert.equal(written.name, name, 'the project name was substituted');

  useWorkspaceBuild(dir, ws.tarDir);
  ok(run('npm', ['install', '--no-audit', '--no-fund'], dir), 'npm install');

  return { dir, name, selection };
}

/** Compiles the project and asserts the module reached JavaScript. */
export function build(project: Project): void {
  ok(run('npm', ['run', 'build'], project.dir), 'npm run build');
  assert.ok(
    existsSync(join(project.dir, 'dist', 'economy.app.js')),
    'the build emitted the module as JavaScript',
  );
}

/** Appends `source` to the project's module file, then rebuilds it. */
export function amend(project: Project, source: string): void {
  const path = join(project.dir, 'economy.app.ts');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n${source}`);
  build(project);
}

/** The port `--port 0` actually bound, read off the banner the service prints. */
const portOf = (banner: string): number =>
  Number(/on \d+\.\d+\.\d+\.\d+:(\d+)/.exec(banner)?.[1] ?? 0);

/**
 * A pause that keeps the event loop alive while it waits.
 *
 * Not unref'd, deliberately. A run whose only remaining handle is an unref'd timer is one node
 * considers finished: it reports "Promise resolution is still pending but the event loop has already
 * resolved" and cancels every test in the file, having run none. That is what an unref'd poll did
 * here the moment a child process exited fast enough to leave the timer alone in the loop.
 */
const wait = (ms: number): Promise<void> =>
  new Promise((settle) => {
    setTimeout(settle, ms);
  });

/**
 * A signal, because a service that accepts the connection and then says nothing leaves a bare
 * fetch waiting with no ceiling of its own — which is the shape the health poll below is written
 * to survive and the assertions after it are not.
 */
export async function request(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_BOUND_MS),
  });
  return { status: response.status, body: await response.text() };
}

/** Reports whether something accepts a TCP connection on host:port inside the timeout. */
export function reachable(
  host: string,
  port: number,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

export interface Service {
  readonly base: string;
  /** Everything the service has written to either stream so far. */
  output(): string;
  /** Signals the service and waits for it to be gone, so an engine pool is closed before its
   *  throwaway namespace is dropped. */
  stop(): Promise<void>;
}

export interface ServeOptions extends RunOptions {
  /** The verb and its flags, `--port 0` included. */
  readonly argv: readonly string[];
}

interface Child {
  output(): string;
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

/** Starts the project's own `economy` bin and collects both its streams. */
function launch(project: string, options: ServeOptions): Child {
  const child = spawn(
    join(project, 'node_modules', '.bin', 'economy'),
    [...options.argv],
    {
      cwd: project,
      env: { ...baseEnv(options.stated === true), ...options.env },
    },
  );
  let text = '';
  const collect = (chunk: Buffer): void => {
    text += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const exited = new Promise<number | null>((settle) => {
    child.once('exit', (code) => settle(code));
  });
  return {
    output: () => text,
    exited,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), STOP_BOUND_MS);
      killer.unref?.();
      await exited;
      clearTimeout(killer);
    },
  };
}

/**
 * Starts the built module and waits for it to answer its own health check.
 *
 * A service that dies during boot is reported as that, not as a poll that ran out: the exit is
 * raced against the poll so a refusal comes back in the second it happened rather than at the
 * ceiling.
 */
export async function serve(
  project: string,
  options: ServeOptions,
): Promise<Service> {
  const child = launch(project, options);
  let dead = false;
  void child.exited.then(() => {
    dead = true;
  });

  const deadline = Date.now() + READY_CEILING_MS;
  while (Date.now() < deadline) {
    const port = portOf(child.output());
    if (port > 0) {
      const base = `http://127.0.0.1:${port}`;
      try {
        if ((await request(`${base}/healthz`)).status === 200) {
          return { base, output: child.output, stop: child.stop };
        }
      } catch {
        // The banner prints before the socket is accepting; keep polling.
      }
    }
    if (dead) break;
    await wait(250);
  }
  const output = child.output();
  await child.stop();
  throw new Error(
    `the service never answered /healthz${dead ? ' — it exited first' : ''}\n${output.slice(-4000)}`,
  );
}

export interface Refusal {
  /** The verb's exit code, or null when it was still running and had to be stopped. */
  readonly code: number | null;
  /** The port it bound, when it bound one — which is the refusal failing, not the wait running out. */
  readonly bound: number | null;
  readonly out: string;
}

/**
 * Runs the verb expecting it not to serve, and reports what it said and how it ended.
 *
 * It watches for a bound port as well as for the exit. A refusal that stops refusing does not exit
 * at all — it binds a socket and runs — so waiting for the exit alone turns a failed assertion into
 * a four-minute wait, which is a hang wearing a bound's clothing. Found by mutating the namespace
 * isolation out of the rig matrix and watching the control take 240s to say so.
 */
export async function serveRefused(
  project: string,
  options: ServeOptions,
): Promise<Refusal> {
  const child = launch(project, options);
  let running = true;
  void child.exited.then(() => {
    running = false;
  });

  const deadline = Date.now() + READY_CEILING_MS;
  while (Date.now() < deadline) {
    const port = portOf(child.output());
    if (port > 0) {
      const out = child.output();
      await child.stop();
      return { code: null, bound: port, out };
    }
    if (!running)
      return { code: await child.exited, bound: null, out: child.output() };
    await wait(100);
  }
  const out = child.output();
  await child.stop();
  return { code: null, bound: null, out };
}

/**
 * The money leg: a system caller funds a wallet, the buyer spends through the module's own
 * checkout route, and the wallet reflects both. Every template prices `starter-pack` at 120
 * credits and puts 600 on the top-up menu, so this reads the same for every row.
 */
export async function moveMoney(base: string): Promise<void> {
  const health = await request(`${base}/healthz`);
  assert.equal(
    health.status,
    200,
    'the built service answers its health check',
  );
  assert.match(health.body, /"status":"ok"/);

  const topUp = await request(`${base}/submit`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer dev_system_payments',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'topUp',
      idempotencyKey: 'walk-topup',
      userId: 'usr_ada',
      amount: 'CREDIT:600.00',
      source: 'card',
    }),
  });
  assert.equal(
    topUp.status,
    200,
    `the top-up committed: ${topUp.body.slice(0, 400)}`,
  );
  assert.match(topUp.body, /"status":"committed"/);

  const funded = await request(`${base}/v1/wallet`, {
    headers: { authorization: 'Bearer dev_user_ada' },
  });
  assert.match(
    funded.body,
    /"spendable":"CREDIT:600\.00"/,
    'the credits landed',
  );

  const sale = await request(`${base}/checkout`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer dev_user_ada',
      'content-type': 'application/json',
      'idempotency-key': 'walk-ord-1',
    },
    body: JSON.stringify({ sku: 'starter-pack', orderId: 'walk-ord-1' }),
  });
  assert.equal(
    sale.status,
    200,
    `the checkout committed: ${sale.body.slice(0, 400)}`,
  );
  assert.match(sale.body, /"status":"committed"/);

  const spent = await request(`${base}/v1/wallet`, {
    headers: { authorization: 'Bearer dev_user_ada' },
  });
  assert.match(
    spent.body,
    /"spendable":"CREDIT:480\.00"/,
    'the sale took the price',
  );
}
