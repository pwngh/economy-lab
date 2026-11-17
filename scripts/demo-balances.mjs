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

// Starts from source and npm alone. The databases and private network belong to this
// invocation. Tests read the built checkout through a read-only mount; no host ports or
// existing database services are used.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const containers = [];
let network;
let interrupted = null;
let active = null;

const env = {
  ...process.env,
  DATABASE_URL: '',
  PG_URL: '',
  MYSQL_TEST_URL: '',
  BENCH_POSTGRES_URL: '',
  BENCH_MYSQL_URL: '',
  REDIS_URL: '',
  SQS_QUEUE_URL: '',
  TASKQ_DATABASE_URL: '',
  TILIA_PAYEE_DATABASE_URL: '',
};
delete env.NODE_TEST_CONTEXT;

function assertRunning() {
  if (interrupted !== null) throw new Error(`interrupted by ${interrupted}`);
}

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function onSignal(signal) {
  interrupted = signal;
  // Let docker finish creating a container so its returned ID can be recorded for cleanup.
  // Build/test children have their own process group, including npm's children.
  if (active?.cancellable) signalChild(active.child, signal);
}

function run(command, args, options = {}) {
  const { capture = false, timeout = 600_000, cancellable = true } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      detached: process.platform !== 'win32',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    active = { child, cancellable };
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8').on('data', (data) => (stdout += data));
      child.stderr.setEncoding('utf8').on('data', (data) => (stderr += data));
    }
    const timer = setTimeout(() => signalChild(child, 'SIGKILL'), timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      active = null;
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      active = null;
      if (code === 0) resolve(stdout.trim());
      else {
        reject(
          new Error(
            `${command} ${args[0]} failed (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        );
      }
    });
  });
}

async function database(alias, image, variables, health, command = []) {
  assertRunning();
  const id = await run(
    'docker',
    [
      'run',
      '-d',
      '--label',
      'economy-lab.balance-proof=true',
      '--network',
      network,
      '--network-alias',
      alias,
      ...variables.flatMap((value) => ['-e', value]),
      '--health-cmd',
      health,
      '--health-interval=1s',
      '--health-timeout=5s',
      '--health-retries=120',
      image,
      ...command,
    ],
    { capture: true, cancellable: false },
  );
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new Error('docker did not return a container ID');
  }
  containers.push(id);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assertRunning();
    const [state] = JSON.parse(
      await run('docker', ['inspect', id], { capture: true, timeout: 10_000 }),
    );
    if (!state.State.Running || state.State.Health.Status === 'unhealthy') {
      throw new Error(`${image} failed to become healthy`);
    }
    if (state.State.Health.Status === 'healthy') return;
    // Infrastructure readiness only; hold expiry tests advance an injected clock.
    await delay(250);
  }
  throw new Error(`${image} did not become healthy within 120 seconds`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    throw new Error('usage: npm run demo:balances');
  }
  await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    capture: true,
    timeout: 15_000,
  });
  for (const args of [['ci'], ['run', 'build'], ['run', 'build:packages']]) {
    assertRunning();
    await run('npm', args);
  }
  network = await run(
    'docker',
    [
      'network',
      'create',
      '--internal',
      '--label',
      'economy-lab.balance-proof=true',
      `balance-proof-${randomUUID()}`,
    ],
    { capture: true, cancellable: false },
  );
  console.log(
    'balance proof: starting fresh PostgreSQL and MySQL on a private network',
  );
  await database(
    'postgres',
    'postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb',
    [
      'POSTGRES_USER=economy',
      'POSTGRES_PASSWORD=economy',
      'POSTGRES_DB=economy_lab',
    ],
    'pg_isready -h 127.0.0.1 -U economy -d economy_lab',
  );
  await database(
    'mysql',
    'mysql:8.4',
    [
      'MYSQL_ROOT_PASSWORD=economy',
      'MYSQL_ROOT_HOST=%',
      'MYSQL_DATABASE=economy_lab',
    ],
    'mysqladmin ping -h 127.0.0.1 -uroot -peconomy',
    ['--skip-log-bin'],
  );
  assertRunning();
  const runner = await run(
    'docker',
    [
      'create',
      '--label',
      'economy-lab.balance-proof=true',
      '--network',
      network,
      '--mount',
      `type=bind,source=${ROOT},target=/workspace,readonly`,
      '--workdir',
      '/workspace',
      '-e',
      'DATABASE_URL=postgres://economy:economy@postgres:5432/economy_lab',
      '-e',
      'PG_URL=postgres://economy:economy@postgres:5432/economy_lab',
      '-e',
      'MYSQL_TEST_URL=mysql://root:economy@mysql:3306/economy_lab',
      '-e',
      'BALANCE_HOLDS_REQUIRE_STORES=1',
      'node:22.18.0',
      'npm',
      'run',
      'test:balances',
    ],
    { capture: true, cancellable: false },
  );
  if (!/^[a-f0-9]{64}$/.test(runner)) {
    throw new Error('docker did not return a test container ID');
  }
  containers.push(runner);
  assertRunning();
  await run('docker', ['start', '--attach', runner]);
  const code = await run(
    'docker',
    ['inspect', '--format', '{{.State.ExitCode}}', runner],
    { capture: true },
  );
  if (code !== '0')
    throw new Error(`test container exited with status ${code}`);
  console.log('balance proof: passed with memory, PostgreSQL, MySQL, and HTTP');
}

const onInterrupt = () => onSignal('SIGINT');
const onTerminate = () => onSignal('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  await main();
} catch (error) {
  console.error(`balance proof: ${error.message}`);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted ? 143 : 1;
} finally {
  for (const id of containers.reverse()) {
    try {
      await run('docker', ['rm', '-f', '-v', id], {
        capture: true,
        cancellable: false,
        timeout: 30_000,
      });
    } catch (error) {
      console.error(
        `balance proof: cleanup failed for ${id}: ${error.message}`,
      );
      process.exitCode = 1;
    }
  }
  if (network) {
    try {
      await run('docker', ['network', 'rm', network], {
        capture: true,
        cancellable: false,
        timeout: 30_000,
      });
    } catch (error) {
      console.error(`balance proof: network cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
}
