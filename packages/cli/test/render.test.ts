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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileEconomy,
  compilePostures,
  resolveEconomyModule,
} from '@pwngh/economy-core/module';
import type { ResolvedModule } from '@pwngh/economy-core/module';
import { explainFromTruth, renderExplain } from '../src/lib/render.js';

// These assertions hold against the compiled plan, the one value every view projects.

type Env = Record<string, string | undefined>;

/** The report `check` prints: the compile, plus the verdict each posture's own boot reaches. */
const reportOf = (mod: ResolvedModule, env: Env = {}, envFile = false) =>
  explainFromTruth(
    compileEconomy(mod, env),
    compilePostures(mod, env),
    envFile,
  );

test('the plan is pure truth: seams, adapters, policy provenance — nothing constructed, nothing opened', async () => {
  const mod = resolveEconomyModule({
    authenticate: false,
    policy: { platformFeeBps: 1000 },
  });
  const env = { PAYOUT_FEE_BPS: '77' };
  const plan = await compileEconomy(mod, env);
  assert.ok(plan.seams.find((s) => s.name === 'authenticate')?.present);
  assert.ok(!plan.seams.find((s) => s.name === 'ports')?.present);
  const by = Object.fromEntries(plan.policy.map((p) => [p.key, p]));
  assert.equal(by.platformFeeBps!.source, 'module');
  assert.equal(by.platformFeeBps!.value, '1000');
  assert.equal(by.payoutFeeBps!.source, 'env');
  assert.equal(by.payoutFeeBps!.value, '77');
  assert.equal(by.freshnessWindowMs!.source, 'default');
  assert.equal((plan.adapters.store as { kind: string }).kind, 'memory');
  assert.ok(Array.isArray(plan.preflight));
  assert.ok(renderExplain(reportOf(mod, env)).includes('platformFeeBps'));
});

test('the four lints fire on their facts and stay quiet otherwise', async () => {
  const clean = await compileEconomy(
    resolveEconomyModule({ authenticate: false }),
    {},
  );
  assert.deepEqual(clean.lints, []);

  const noisy = resolveEconomyModule({
    authenticate: false,
    policy: { topUpBundlesMinor: [600n, 1200n], pauseStartMs: 1 },
    providers: {},
    worker: { sweeps: ['payouts'] },
  });
  const names = (await compileEconomy(noisy, {})).lints.map((l) => l.name);
  assert.deepEqual(names, [
    'bundle-unit-suspect',
    'pause-pinned',
    'providers-without-secret',
    'worker-only-steady',
  ]);
  const withSecret = (
    await compileEconomy(noisy, { WEBHOOK_SECRET: 'whsec_x' })
  ).lints.map((l) => l.name);
  assert.ok(!withSecret.includes('providers-without-secret'));

  const nullPause = resolveEconomyModule({
    authenticate: false,
    policy: { pauseStartMs: null },
  });
  assert.ok(
    (await compileEconomy(nullPause, {})).lints.some(
      (l) => l.name === 'pause-pinned',
    ),
    'a present pause key pins even when null',
  );
});

test('the compile survives a broken production env: policy degrades, preflight carries the failure', async () => {
  const mod = resolveEconomyModule({ authenticate: false });
  const plan = await compileEconomy(mod, { NODE_ENV: 'production' });
  assert.deepEqual(
    plan.policy,
    [],
    'policy table degrades instead of throwing',
  );
  assert.ok(
    plan.preflight.some(
      (i) => (i as { severity?: string }).severity === 'error',
    ),
    'the missing production anchors surface as preflight errors',
  );
  assert.ok(
    renderExplain(reportOf(mod, { NODE_ENV: 'production' })).includes(
      'unavailable — see preflight',
    ),
  );
});

// The remedy `Q97` routed through preflight is an install-and-pass block — one form per
// audience since `Q195` — and it is what `check` prints at exit 2. Escaped into a JSON object
// it arrived as one 340-character line.
test('a multi-line preflight remedy renders as an indented block under its code and path', () => {
  const mod = resolveEconomyModule(
    { authenticate: false, ports: { dispatcher: false } },
    'wired.app.ts',
  );
  const out = renderExplain(
    reportOf(mod, { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x' }),
  );
  assert.ok(
    !out.includes('\\n'),
    `the remedy is still escaped onto one line:\n${out}`,
  );
  const lines = out.split('\n');
  const head = lines.findIndex((l) =>
    l.startsWith('  port.unsupplied  DATABASE_URL'),
  );
  assert.notEqual(head, -1, `no head line for the issue:\n${out}`);
  const body = lines
    .slice(head + 1)
    .slice(0, 16)
    .filter((l) => l.trim() !== '');
  assert.ok(
    body.every((l) => l.startsWith('      ')),
    `the remedy is not indented under its head line:\n${body.join('\n')}`,
  );
  assert.ok(
    body.some((l) => l.includes('@pwngh/economy/postgres')),
    'the module-door line survives',
  );
  assert.ok(
    body.some((l) => l.includes('@pwngh/economy-postgres')),
    'the install line survives',
  );
  assert.ok(
    body.some((l) => l.includes('store: await postgres(')),
    'and the line to paste',
  );
  // Longest line of the remedy, rather than the one 340-character run it used to be.
  const longest = Math.max(...body.map((l) => l.length));
  assert.ok(longest < 100, `longest remedy line is ${longest} characters`);
});

// Two postures, one report. The verdicts agree far more often than not, and a report that
// printed two blocks every time would be noise; when they differ, both are named.
test('the preflight rows name the posture only when the two disagree', () => {
  const clean = renderExplain(
    reportOf(resolveEconomyModule({ authenticate: false }, 'a.app.ts')),
  );
  assert.match(clean, /^preflight deployed and dev agree — clean$/m);
  assert.ok(!clean.includes('env       '), 'no .env, so no env row');

  // A bare module and a named backend: the deployed reading refuses and `withDev` fills the slot,
  // so the two point opposite ways on one environment.
  const split = renderExplain(
    reportOf(
      resolveEconomyModule({ authenticate: false }, 'bare.app.ts'),
      { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x' },
      true,
    ),
  );
  assert.match(
    split,
    /^preflight deployed \(economy serve, worker\) — 1 issue\(s\):$/m,
  );
  assert.match(split, /^preflight dev \(economy dev\) — clean$/m);
  assert.match(split, /^env {7}\.env in place for this reading/m);
});

test('desugar prints the floor calls with the module values inlined', async () => {
  const plan = await compileEconomy(
    resolveEconomyModule({
      authenticate: false,
      policy: { topUpBundlesMinor: [60000n] },
      worker: { intervalMs: 5_000 },
    }),
    {},
  );
  assert.ok(plan.desugar.includes('createEconomy(ports)'));
  assert.ok(plan.desugar.includes('topUpBundlesMinor: [60000n]'));
  assert.ok(plan.desugar.includes('worker.start(5000)'));
  assert.ok(plan.desugar.includes('authenticate: false'));
});

test('desugar states each seam recipe: after, catalog, routes, supervisor, the closed economy', async () => {
  const desugarOf = async (
    definition: Record<string, unknown>,
  ): Promise<string> =>
    (await compileEconomy(resolveEconomyModule(definition), {})).desugar;

  const after = await desugarOf({
    authenticate: false,
    after: { 'economy.payout.settled': () => {} },
  });
  assert.ok(
    after.includes(
      'const dispatcher = async (event) => module.after[event.type]?.(event);',
    ),
  );
  assert.ok(after.includes('economy.payout.settled'));
  assert.ok(after.includes('at-least-once'));
  assert.ok(after.includes('maxOutboxAttempts'));

  const catalog = await desugarOf({
    authenticate: false,
    catalog: { bundles: [60_000n], lookup: () => null },
  });
  assert.ok(
    catalog.includes('topUpBundlesMinor: [60000n]'),
    'bundles ride the policy expansion',
  );
  assert.ok(
    catalog.includes(
      'ports = { ...ports, catalog: { lookup: module.catalog.lookup } };',
    ),
    'the catalog joins the ports bag, which is where every door reads it',
  );
  assert.ok(catalog.includes('let ports = await openPorts('));
  assert.ok(catalog.includes('CATALOG_MISMATCH'));

  const routes = await desugarOf({
    authenticate: false,
    routes: { 'POST /checkout': () => new Response() },
  });
  assert.ok(routes.includes('POST /checkout'));
  assert.ok(routes.includes('null → 401'));
  assert.ok(routes.includes('/v1/submit envelope'));

  // The printed floor is only worth reading if it assembles the way createApp assembles. The
  // supervisor's whole point is that the economy and the worker emit through its wrapped
  // logger and meter, and that holds only when the rebind is printed and printed early:
  // createSupervisorRuntime, then `ports = { ...ports, logger, meter }`, then createEconomy, then the
  // worker, and createSupervisor last because it drives worker.sweep. Positions, not presence.
  const supervisor = await desugarOf({
    authenticate: false,
    flags: { supervisor: true },
  });
  const at = (needle: string): number => {
    const i = supervisor.indexOf(needle);
    assert.notEqual(i, -1, `desugar never prints ${needle}`);
    return i;
  };
  const runtime = at('const supervisorRuntime = createSupervisorRuntime(');
  const rebind = at(
    'ports = { ...ports, logger: supervisorRuntime.logger, meter: supervisorRuntime.meter };',
  );
  const economy = at('const economy = createEconomy(ports);');
  const worker = at('const worker = createWorker(ports, economy,');
  const supervise = at('const supervisor = createSupervisor(');
  assert.ok(
    runtime < rebind && rebind < economy,
    'the wrapped ports must be bound before the economy is built, as createApp does it',
  );
  assert.ok(
    economy < worker && worker < supervise,
    'createSupervisor drives worker.sweep, so it comes after the worker',
  );
  assert.ok(
    supervisor.includes('let ports = await openPorts('),
    'the bag is rebound, so it cannot be declared const',
  );

  const closed = await desugarOf({
    authenticate: false,
    flags: { payouts: false },
  });
  assert.ok(closed.includes('closed economy'), 'recipe named');
  assert.ok(closed.includes('rail declines'), 'recipe states the mechanism');
  assert.ok(
    !closed.includes('only:'),
    'the payouts sweep stays on — excluding it strands sagas',
  );
});
