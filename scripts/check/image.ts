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

// The image boots the repository's own economy and answers for it. `economy serve` is the
// production posture, so this run supplies a production environment and nothing else: no cache,
// no dispatcher — those optional ports are explicitly declined, which is what a deployment
// without them has to say out loud.
//
// The store is the one that is not declined. A `DATABASE_URL` this machine can reach is handed to
// the container, so the image boots against a SQL engine the way a deployment does; with none, the
// run falls back to the in-memory store and **says which store it ran** in its own output line,
// because "the app boots" and "the app boots against a database" are different claims and the
// step used to make only the first while reading like both.
//
// What that fallback does not cover, stated here rather than only in a report: with no reachable
// engine this step proves the image, the bin, the module and the health route, and proves nothing
// about the engine packages inside the image. `ci.yml`'s `live` job is where it meets one.
//
// The Dockerfile carried a `COPY db ./db` for a directory that moved into the engine packages, so
// `docker build .` failed on line one and nothing noticed. A gate that builds it is the answer to
// that, and it is why this step asserts the health check rather than the build's exit code.

import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TAG = 'economy-lab:check';
const CONTAINER = 'economy-lab-check';

/** Bounds every docker call. A daemon that stops answering must fail this step, not own it. */
const DOCKER_TIMEOUT_MS = 600_000;

/** How long the container gets to bind and answer. It boots the lab from TypeScript. */
const READY_CEILING_MS = 60_000;

/** How long the engine gets to accept a connection before this run calls it absent. */
const PROBE_MS = 2_000;

/**
 * The name a container resolves to the machine running it. `DATABASE_URL` names a port published
 * on the host, and `localhost` inside the container is the container.
 */
const HOST_ALIAS = 'host.docker.internal';

/** The production environment `economy serve` refuses to bind without. */
const SERVE_ENV: Readonly<Record<string, string>> = {
  PORT: '3000',
  WEBHOOK_SECRET: 'image-check-webhook',
  SIGNING_SECRET: 'image-check-signing',
  CREDIT_BUY_RATE: '8333',
  CREDIT_BUY_SCALE: '6',
  CREDIT_PAR_RATE: '5',
  CREDIT_PAR_SCALE: '3',
  PAYOUT_RATE: '5',
  PAYOUT_SCALE: '3',
  PROCESSOR_URL: 'https://payouts.invalid/payout',
  // The two policy anchors production must state rather than inherit a dev default for.
  MATURITY_HORIZON_CARD_MS: '604800000',
  VELOCITY_LIMIT_MINOR: '100000000',
  DISPATCHER_DECLINED: '1',
  PAYEES_DECLINED: '1',
  ANCHOR_DECLINED: '1',
};

/** Whether something is listening, bounded so an unroutable address cannot own this step. */
function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PROBE_MS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** The store leg: which engine the container will be pointed at, and the URL it reaches it by. */
interface StoreLeg {
  readonly engine: string;
  readonly url: string;
}

/**
 * Resolves `DATABASE_URL` into something the container can dial, or null when the environment
 * named no database. The host is rewritten because the URL names a port published on this machine.
 *
 * A `DATABASE_URL` that is set and cannot be reached is a refusal, not a fallback. Falling back
 * would make this step green in a CI job whose whole purpose is the SQL posture and whose engine
 * container had died — the shape `BENCH_REQUIRE` exists for on the bench side.
 */
async function storeLeg(): Promise<StoreLeg | null> {
  const raw = process.env.DATABASE_URL ?? '';
  if (raw === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`DATABASE_URL is set and is not a URL: ${raw}`);
  }
  const engine = parsed.protocol.replace(':', '');
  const port = Number(parsed.port === '' ? '5432' : parsed.port);
  if (!(await listening(parsed.hostname, port))) {
    throw new Error(
      `DATABASE_URL names ${engine} at ${parsed.hostname}:${port} and nothing is listening there (npm run docker)`,
    );
  }
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(parsed.hostname)) {
    parsed.hostname = HOST_ALIAS;
  }
  return { engine, url: parsed.toString() };
}

interface Ran {
  readonly status: number | null;
  readonly output: string;
}

function docker(args: readonly string[]): Ran {
  const run = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: DOCKER_TIMEOUT_MS,
  });
  return {
    status: run.error !== undefined ? null : run.status,
    output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Says what went wrong, shows the output it went wrong in, and takes the container down.
 *  Throwing rather than exiting keeps the cleanup on one path. */
function refuse(what: string, ran: Ran): never {
  console.error(ran.output.slice(-4000));
  docker(['rm', '-f', CONTAINER]);
  throw new Error(what);
}

/**
 * Waits for the container to bind and answer, or refuses with the container's own log. Its own
 * function because a wait is where a step wedges: the ceiling is the bound, and a container that
 * exited is refused the moment its state says so rather than after the full ceiling.
 */
async function answerOn(port: string): Promise<Response> {
  const deadline = Date.now() + READY_CEILING_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (waiting) {
      last = waiting instanceof Error ? waiting.message : String(waiting);
      // A container that exited is never going to answer; its own log says why.
      const alive = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]);
      if (alive.output.trim() !== 'true') {
        refuse(
          'the container exited before answering',
          docker(['logs', CONTAINER]),
        );
      }
      await sleep(500);
    }
  }
  refuse(
    `no answer on /healthz within ${READY_CEILING_MS} ms (${last})`,
    docker(['logs', CONTAINER]),
  );
}

async function build(): Promise<number> {
  // Resolved before the build, so an engine that is named and not there is reported in a second
  // rather than after a minute of image layers.
  const leg = await storeLeg();
  const store = leg === null ? 'memory' : leg.engine;

  // A previous run killed mid-flight leaves the name taken, and `docker run --name` then fails
  // for a reason that has nothing to do with the image.
  docker(['rm', '-f', CONTAINER]);

  const built = docker(['build', '--tag', TAG, '.']);
  if (built.status !== 0) refuse('docker build failed', built);

  const env = Object.entries({
    ...SERVE_ENV,
    ...(leg === null ? {} : { DATABASE_URL: leg.url }),
  }).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  // Published on an ephemeral host port so a developer's own :3000 is never the reason this fails.
  const started = docker([
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--publish',
    '127.0.0.1::3000',
    // Only when the store leg needs it: the alias is what makes a host-published engine port
    // reachable from inside the container, and an unused --add-host is a line nobody can read.
    ...(leg === null ? [] : ['--add-host', `${HOST_ALIAS}:host-gateway`]),
    ...env,
    TAG,
  ]);
  if (started.status !== 0) refuse('docker run failed', started);

  const mapped = docker(['port', CONTAINER, '3000/tcp']);
  const port = /:(\d+)\s*$/.exec(mapped.output.trim())?.[1];
  if (!port) refuse('the container published no port', mapped);

  const answered = await answerOn(port);
  const body = await answered.text();
  if (answered.status !== 200) {
    refuse(
      `/healthz answered ${answered.status} ${body}`,
      docker(['logs', CONTAINER]),
    );
  }

  const logs = docker(['logs', CONTAINER]);
  // The health check is a route with nothing behind it. This is the line the CLI prints once the
  // module is loaded and the socket is bound, and it names the module the image actually ran.
  if (!/economy serve — economy on /.test(logs.output)) {
    refuse('the image answered without booting economy/', logs);
  }

  const stopped = docker(['rm', '-f', CONTAINER]);
  if (stopped.status !== 0) refuse('the container would not stop', stopped);

  process.stdout.write(
    `image: ${TAG} booted economy/ on ${store} and answered /healthz ${answered.status} ${body}\n`,
  );
  return 0;
}

try {
  process.exitCode = await build();
} catch (failed) {
  console.error(
    `image: ${failed instanceof Error ? failed.message : String(failed)}`,
  );
  process.exitCode = 1;
}
