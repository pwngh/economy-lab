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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEconomyModule } from '../src/module.js';
import { compileEconomy } from '../src/truth.js';
import { createApp } from '../src/app.js';
import { withDev } from '../src/index.js';
import { isRejection, spendable, topUp, idempotencyKey } from '../src/ops.js';
import { credits } from '@pwngh/economy-money';
import { systemActor } from '@pwngh/economy-auth';

// explainReport, the lints, and the desugar/explain renders are asserted in economy-cli's
// render suite.

test('module-less: {} resolves, and a dev app boots and moves money on defaults', async () => {
  const mod = resolveEconomyModule({}, '(defaults)');
  assert.deepEqual(mod.exports, []);
  const app = await createApp(withDev(mod), { env: {} });
  const out = await app.economy.submit(
    topUp({
      idempotencyKey: idempotencyKey('t', 'defaults', '1'),
      actor: systemActor('test'),
      userId: 'usr_d',
      amount: credits(10),
      source: 'test',
    }),
  );
  assert.ok(!isRejection(out));
  assert.deepEqual(
    await app.economy.read.balance(spendable('usr_d')),
    credits(10),
  );
  await app.close();
});

test('instances seam opens the lanes and mounts the fast-lane route', async () => {
  const post = (h: (r: Request) => Promise<Response>) =>
    h(
      new Request('http://t/instances/s1/purchase', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      }),
    );
  const withLanes = await createApp(
    withDev({ authenticate: false, worker: false, instances: {} }),
    { env: {} },
  );
  assert.ok(withLanes.instances, 'manager opened');
  assert.notEqual((await post(withLanes.handler)).status, 404, 'route mounted');
  await withLanes.close();

  const bare = await createApp(
    withDev({ authenticate: false, worker: false }),
    { env: {} },
  );
  assert.equal(bare.instances, null);
  assert.equal(
    (await post(bare.handler)).status,
    404,
    'route absent without the seam',
  );
  await bare.close();
});

test('interop matrix: ESM, tsc-CJS, esbuild-CJS, and require shapes resolve identically', () => {
  const policy = { platformFeeBps: 900 };
  const esm = { policy };
  const tscCjs = {
    policy,
    __esModule: true,
    default: { policy, __esModule: true },
  };
  const esbuildCjs = { policy, default: { policy } };
  const required = { __esModule: true, policy };
  for (const raw of [esm, tscCjs, esbuildCjs, required]) {
    const mod = resolveEconomyModule(
      raw as Record<string, unknown>,
      'x.app.ts',
    );
    assert.deepEqual(mod.exports, ['policy']);
    assert.deepEqual(mod.policy, policy);
  }
  assert.throws(
    () => resolveEconomyModule({ default: { policy } }, 'x.app.ts'),
    /DEFAULT_EXPORT/,
    'an authored default is still refused',
  );
});

// What production demands that no module can wire in code: the two policy anchors and the two
// secrets. Everything else production asks for is a port, and the table below wires each one.
const PRODUCTION = {
  NODE_ENV: 'production',
  WEBHOOK_SECRET: 'whsec_truth',
  SIGNING_SECRET: 'sig_truth',
  MATURITY_HORIZON_CARD_MS: '0',
  VELOCITY_LIMIT_MINOR: '100000000',
};

// Each port a module can supply in code, with the env keys that port answers for.
const WIRED = {
  rates: {
    port: {
      buyRate: 12_000n,
      buyScale: 6,
      parRate: 6n,
      parScale: 3,
      payoutRate: 6n,
      payoutScale: 3,
    },
    keys: [
      'CREDIT_BUY_RATE',
      'CREDIT_PAR_RATE',
      'PAYOUT_RATE',
      'CREDIT_BUY_SCALE',
      'CREDIT_PAR_SCALE',
      'PAYOUT_SCALE',
    ],
  },
  processor: {
    port: { submitPayout: async () => ({ providerRef: 'ref_truth' }) },
    keys: ['PROCESSOR_URL'],
  },
  dispatcher: { port: async () => {}, keys: ['dispatcher'] },
  payees: {
    port: { status: async () => ({ state: 'CLEARED' as const }) },
    keys: ['payees'],
  },
  anchor: { port: { publish: async () => {} }, keys: ['anchor'] },
};

// What production refuses from a module that wires nothing: the six rate knobs, the payout
// provider, then the three optional ports it may not lose silently. Written out, so the table
// above cannot both set the expectation and satisfy it.
const BARE = [
  'CREDIT_BUY_RATE',
  'CREDIT_PAR_RATE',
  'PAYOUT_RATE',
  'CREDIT_BUY_SCALE',
  'CREDIT_PAR_SCALE',
  'PAYOUT_SCALE',
  'PROCESSOR_URL',
  'dispatcher',
  'payees',
  'anchor',
];

test('preflight judges the ports the module wires: each clears its own keys, the rest still refuse', () => {
  const refusals = (ports?: Record<string, unknown>): string[] =>
    compileEconomy(
      resolveEconomyModule({
        authenticate: false,
        ...(ports ? { ports } : {}),
      }),
      PRODUCTION,
    )
      .preflight.filter((i) => i.severity === 'error')
      .map((i) => i.path);

  assert.deepEqual(
    refusals(),
    BARE,
    'a module that wires nothing is judged by the environment alone',
  );

  // One slot at a time: a wired port clears exactly the keys it answers for, and every key the
  // module left to the environment is still refused.
  for (const [slot, { port, keys }] of Object.entries(WIRED)) {
    assert.deepEqual(
      refusals({ [slot]: port }),
      BARE.filter((path) => !keys.includes(path)),
      `wiring ${slot} in code moved the wrong rows`,
    );
  }

  // All five wired: nothing left to ask the environment for. The empty result is accounted for
  // port by port — five disjoint key sets covering the roster — rather than by a check that
  // stopped looking.
  const claimed = Object.values(WIRED).flatMap((w) => w.keys);
  assert.equal(Object.keys(WIRED).length, 5);
  assert.equal(new Set(claimed).size, BARE.length);
  assert.deepEqual([...claimed].sort(), [...BARE].sort());
  assert.deepEqual(
    refusals(
      Object.fromEntries(
        Object.entries(WIRED).map(([slot, w]) => [slot, w.port]),
      ),
    ),
    [],
  );
});

test('the adapter table names the ports the module wires, not the ones the environment lacks', () => {
  const truth = compileEconomy(
    resolveEconomyModule({
      authenticate: false,
      ports: {
        dispatcher: WIRED.dispatcher.port,
        payees: WIRED.payees.port,
        anchor: WIRED.anchor.port,
      },
    }),
    PRODUCTION,
  );
  assert.deepEqual(truth.adapters.dispatcher, {
    kind: 'in-process',
    url: null,
  });
  assert.equal(truth.adapters.payees, 'set');
  assert.equal(truth.adapters.anchor, 'set');
});

test('capabilities is honest: every listed route answers, unlisted probes 404', async () => {
  const app = await createApp(
    withDev({
      authenticate: false,
      worker: false,
      instances: {},
      providers: {
        tilia: () => ({
          provider: 'tilia',
          eventId: 'evt_cap_1',
          userId: 'usr_c',
          amount: credits(1),
          source: 'card',
        }),
      },
    }),
    { env: {} },
  );
  const caps = app.capabilities();
  // Exact: the loop below walks whatever this returns, so a floor lets a dropped route leave the
  // walk unnoticed, and an added one arrive unwalked.
  assert.equal(caps.routes.length, 12, 'writes plus the read family');
  for (const r of caps.routes) {
    if (r.path === '/v1/posting/:txnId') {
      continue; // 404 for an unknown txn is its contract; the lab reads test covers it
    }
    const path = r.path.replace(':scope', 's1').replace(':provider', 'tilia');
    const res = await app.handler(
      new Request(`http://t${path}`, {
        method: r.method,
        ...(r.method === 'POST'
          ? { body: '{}', headers: { 'content-type': 'application/json' } }
          : {}),
      }),
    );
    assert.notEqual(res.status, 404, `${r.method} ${r.path} listed but 404s`);
  }
  assert.deepEqual(caps.providers, ['tilia']);
  assert.ok(
    caps.routes.some((r) => r.path === '/webhooks/:provider'),
    'providers present, webhook route listed',
  );
  await app.close();

  const inProcess = await createApp({ worker: false }, { env: {} });
  assert.deepEqual(
    inProcess.capabilities().routes,
    [],
    'no posture, no network face',
  );
  assert.ok(inProcess.capabilities().worker.enabled === false);
  await inProcess.close();
});
