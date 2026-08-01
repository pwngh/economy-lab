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
 * This repository runs its own product.
 *
 * `economy/app.ts` is an ordinary `EconomyModule` and the `economy` bin finds it here with no
 * flag, so the boot path the lab exercises is the boot path a customer gets. Before this, the
 * host was `scripts/main.ts` — a hand-rolled second copy of `createApp`'s boot sequence, with its
 * own env reading, its own composition and its own shutdown, none of which any customer ran.
 *
 * What is asserted is the count of host wirings **composed**, not that a boot did not throw: an
 * app that composes nothing boots fine, and that is the shape this gate exists to refuse. The
 * empty environment is the negative control, and every wiring on the roster is reached from an
 * environment written here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import '#test/support/dist-guard.ts';

import { HOST_WIRINGS, openHostWirings } from '#economy/lib/host.ts';
import { silentLogger } from '#src/runtime.ts';

import type { HostWiringName } from '#economy/lib/host.ts';
import type { EnvMap } from '#src/env.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The umbrella's bin, by the path it occupies in an install rather than through a shim. */
const BIN = 'node_modules/@pwngh/economy/dist/cli-entry.js';

/** Node boots the whole lab from TypeScript here, so the ceiling is generous — but it is a
 *  ceiling: without one a verb that never answers hangs the file instead of failing it. */
const BOOT_CEILING_MS = 90_000;

/** The Tilia rail with no database: the payee table comes from the env map, so the wiring
 *  composes without a rig and opens no pool. */
const TILIA: EnvMap = {
  TILIA_CLIENT_ID: 'cid_lab',
  TILIA_CLIENT_SECRET: 'secret_lab',
  TILIA_ACCOUNT_ID: 'acct_lab',
  TILIA_PAYEE_MAP: JSON.stringify({
    usr_ada: {
      accountId: 'a',
      sourcePaymentMethodId: 's',
      destinationPaymentMethodId: 'd',
    },
  }),
};

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one verb of the real bin against this repository, bounded. */
async function bin(argv: string[], env: EnvMap = {}): Promise<Ran> {
  const child = spawn(process.execPath, [BIN, ...argv], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill('SIGKILL'), BOOT_CEILING_MS);
  try {
    const status = await new Promise<number | null>((settle) =>
      child.on('exit', (code) => settle(code)),
    );
    assert.notEqual(
      status,
      null,
      `economy ${argv[0]} was killed at ${BOOT_CEILING_MS} ms without exiting`,
    );
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

interface Explain {
  readonly file: string;
  readonly seams: readonly { name: string; present: boolean }[];
  readonly adapters: Record<string, unknown>;
}

/**
 * Every wiring opt-in, cleared. This suite runs under `--env-file-if-exists=.env`, and this
 * repository's own `.env` turns the taskq bridge on against a live rig — so without this a
 * developer and CI would be reading two different apps. The overrides that opt in on their own
 * are cleared beside the flags they override.
 */
const BARE: EnvMap = {
  ...Object.fromEntries(HOST_WIRINGS.map((wiring) => [wiring.optIn, ''])),
  TASKQ_DATABASE_URL: '',
  TILIA_PAYEE_DATABASE_URL: '',
  // Two knobs name a backend this module supplies no driver for, so an inherited value is a
  // preflight refusal; DATABASE_URL now opens a real engine, so an inherited value would point
  // this suite at a developer's live database. Either way `check` would exit 2 on a developer's
  // machine and 0 in CI, which is the same drift the flags above are cleared for.
  DATABASE_URL: '',
  REDIS_URL: '',
  SQS_QUEUE_URL: '',
  WEBHOOK_SECRET: 'lab-app-test',
};

/** `economy check --json` over this repository's own module. WEBHOOK_SECRET is set because the
 *  module exports `providers`, and a webhook seam with no secret is a lint the verb exits 1 on. */
async function explain(env: EnvMap = {}): Promise<Explain> {
  const ran = await bin(['check', '--json'], { ...BARE, ...env });
  assert.equal(
    ran.status,
    0,
    `economy check exited ${ran.status}\n${ran.stderr}`,
  );
  // The hosts log their readiness to stdout as JSONL before the report, so the report is the
  // last JSON document rather than the whole stream.
  const at = ran.stdout.indexOf('{\n');
  assert.ok(at >= 0, `economy check printed no JSON report:\n${ran.stdout}`);
  return JSON.parse(ran.stdout.slice(at)) as Explain;
}

const present = (report: Explain): string[] =>
  report.seams.filter((seam) => seam.present).map((seam) => seam.name);

test('the bin finds this repository’s own module with no flag', async () => {
  const report = await explain();
  assert.equal(
    report.file,
    'economy',
    'the bin resolved some other module, so nothing below is about this repository',
  );
  assert.deepEqual(present(report), ['authenticate', 'providers']);
});

test('an environment that opts into nothing composes nothing', async () => {
  const composition = await openHostWirings({}, silentLogger());
  assert.deepEqual(composition.composed, []);
  assert.equal(composition.ports, undefined, 'an empty bag is not no bag');
  assert.equal(composition.flags, undefined);
});

test('each host wiring composes what the roster says it composes', async () => {
  // The store, driven rig-free at both boundaries. A scheme the framework refuses composes
  // nothing here, because a second refusal would be a second reading of one rule; a scheme it
  // accepts reaches the engine package, which is what the rejection below proves — nothing else
  // in this suite can tell "loaded the driver and dialed" from "read the name and shrugged".
  const noStore = await openHostWirings(
    { DATABASE_URL: 'redis://localhost:1' },
    silentLogger(),
  );
  assert.deepEqual(noStore.composed, []);
  await assert.rejects(
    () =>
      openHostWirings(
        { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' },
        silentLogger(),
      ),
    /schema_meta/,
    'DATABASE_URL naming a dead engine composed a store anyway',
  );

  const edge = await openHostWirings(TILIA, silentLogger());
  assert.deepEqual(edge.composed, ['edge']);
  assert.deepEqual(Object.keys(edge.ports!).sort(), ['payees', 'processor']);
  // The pool the edge opened leaves through the slot that carries it, which is the slot
  // economy.close() releases. A wiring that hands in a port with no close leaks it.
  assert.equal(
    typeof (edge.ports as { payees: { close?: unknown } }).payees.close,
    'function',
  );

  const supervisor = await openHostWirings({ SUPERVISOR: '1' }, silentLogger());
  assert.deepEqual(supervisor.composed, ['supervisor']);
  assert.deepEqual(supervisor.flags, { supervisor: true });
  assert.equal(
    supervisor.ports,
    undefined,
    'the supervisor is a flag, not a port override',
  );

  // The taskq wiring is reached the same way and refuses by name: TASKQ=1 with no database is
  // the misconfigured opt-in, and it throws at composition rather than at first delivery.
  await assert.rejects(
    () => openHostWirings({ TASKQ: '1' }, silentLogger()),
    /needs a database for the task table to live beside/,
  );

  const both = await openHostWirings(
    { ...TILIA, SUPERVISOR: '1' },
    silentLogger(),
  );
  assert.deepEqual(both.composed, ['edge', 'supervisor']);
  assert.equal(both.composed.length, 2);
});

test('the roster is exactly the set of wirings, and every one was reached', () => {
  const roster = HOST_WIRINGS.map((wiring) => wiring.name);
  assert.deepEqual(roster, ['store', 'edge', 'taskq', 'supervisor']);
  assert.equal(HOST_WIRINGS.length, 4);
  // Each name above was driven by the test before this one; naming them again here is what
  // fails when a wiring is added to the roster and never composed.
  const reached: readonly HostWiringName[] = [
    'store',
    'edge',
    'taskq',
    'supervisor',
  ];
  assert.deepEqual([...roster].sort(), [...reached].sort());
  for (const wiring of HOST_WIRINGS) {
    assert.ok(wiring.optIn.length > 0, `${wiring.name} names no env opt-in`);
    assert.ok(
      wiring.contributes.length > 0,
      `${wiring.name} contributes nothing`,
    );
  }
});

test('the module the bin loads carries the wirings the environment opted into', async () => {
  const bare = await explain();
  assert.equal(present(bare).includes('ports'), false);
  assert.equal(present(bare).includes('flags'), false);
  assert.equal(bare.adapters.payees, 'missing');

  const wired = await explain({ ...TILIA, SUPERVISOR: '1' });
  assert.deepEqual(present(wired), [
    'authenticate',
    'providers',
    'ports',
    'flags',
  ]);
  // describeEnv reads the init the module supplied, so a port wired in code is not then also
  // demanded from the environment.
  assert.equal(wired.adapters.payees, 'set');
});

test('the lab boots its own product and answers its health check', async () => {
  const child = spawn(
    process.execPath,
    [BIN, 'dev', '--host', '127.0.0.1', '--port', '0'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...BARE,
        // The dev hand-off re-execs to load .env, which exists on a developer's machine and not
        // in CI. Declining it keeps one process to signal and one shape to assert.
        ECONOMY_DEV_REEXEC: '1',
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  // One exit listener, attached now. Attaching a second one later would never fire for a child
  // that had already gone, and the wait behind it would be a promise nobody settles — which the
  // runner reports as a cancelled test rather than as a failure.
  const exited = new Promise<number | string>((settle) =>
    child.on('exit', (code, signal) => settle(code ?? signal ?? 'unknown')),
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `no bound port within ${BOOT_CEILING_MS} ms\n${stdout}\n${stderr}`,
        ),
      );
    }, BOOT_CEILING_MS);
  });
  // A boot that dies has to fail here, not wait out the ceiling: an exit before the banner is
  // the shape a refusal takes, and its own output is the only useful message.
  const died = exited.then((how): never => {
    throw new Error(
      `economy dev exited ${how} before binding\n${stdout}\n${stderr}`,
    );
  });
  const listening = new Promise<number>((settle) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const found = /on 127\.0\.0\.1:(\d+)/.exec(stdout);
      if (found) settle(Number(found[1]));
    });
  });

  try {
    const port = await Promise.race([listening, died, ceiling]);
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/healthz`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(health.status, 200);

    // A health check answers on a handler with nothing behind it, so the boot is proven by
    // money instead: one topUp through the framework's own write door, read back off the
    // ledger this module composed.
    const submitted = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'topUp',
        idempotencyKey: 'lab-app-test-1',
        actor: { kind: 'system', service: 'lab-app-test' },
        userId: 'usr_ada',
        amount: 'CREDIT:400.00',
        source: 'card',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(submitted.status, 200, await submitted.text());

    const wallet = await fetch(`${base}/v1/wallet?userId=usr_ada`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(wallet.status, 200);
    assert.match(await wallet.text(), /"spendable":"CREDIT:400\.00"/);
  } finally {
    clearTimeout(deadline);
    child.kill('SIGTERM');
    let overdue: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      exited,
      new Promise<'timeout'>((settle) => {
        overdue = setTimeout(() => settle('timeout'), 20_000);
      }),
    ]);
    clearTimeout(overdue);
    if (stopped === 'timeout') child.kill('SIGKILL');
    assert.notEqual(stopped, 'timeout', 'SIGTERM did not stop the dev server');
  }
});
