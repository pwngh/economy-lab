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
import { request } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VERBS } from '../src/lib/parse-args.js';
import { collect, runLive, runSync, stop, until } from './support/process.js';

// macOS CoreFoundation stamps this into every process it starts, whatever environment it is
// handed, so it is the one name a spawn cannot keep out. Absent on Linux, where the filter below
// removes nothing.
const PLATFORM_STAMPED = '__CF_USER_TEXT_ENCODING';

// Every verb this file drives against a running economy. The roster is closed at five, so the
// last test here asserts the set rather than counting on a reader to notice a gap.
const exercised = new Set<string>();

const ADA = 'live_user_usr_ada';
const PAYMENTS = 'live_system_payments';

// A module with a real posture: the bearer decides the principal, so a read the CLI serves is
// scoped by the token that asked for it rather than by a body the caller wrote.
const MODULE = `export const authenticate = async (request) => {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (bearer === '${ADA}') return { kind: 'user', userId: 'usr_ada' };
  if (bearer === '${PAYMENTS}') return { kind: 'system', service: 'payments' };
  return null;
};
`;

/** Every preflight row `check --json` reported, across each posture it answered for. */
const preflightOf = (stdout: string): { path: string; severity: string }[] =>
  (
    JSON.parse(stdout) as {
      postures: { preflight: { path: string; severity: string }[] }[];
    }
  ).postures.flatMap((posture) => posture.preflight);

// What serve demands before it binds: real secrets, stated policy anchors, real rates, a payout
// URL, and an explicit decline for each optional port. Nothing here is a dev stand-in.
const PRODUCTION: Record<string, string> = {
  NODE_ENV: 'production',
  WEBHOOK_SECRET: 'whsec_live_cli',
  SIGNING_SECRET: 'sig_live_cli',
  MATURITY_HORIZON_CARD_MS: '0',
  VELOCITY_LIMIT_MINOR: '100000000',
  CREDIT_BUY_RATE: '8333',
  CREDIT_BUY_SCALE: '6',
  CREDIT_PAR_RATE: '5',
  CREDIT_PAR_SCALE: '3',
  PAYOUT_RATE: '5',
  PAYOUT_SCALE: '3',
  PROCESSOR_URL: 'http://127.0.0.1:59999/pay',
  DISPATCHER_DECLINED: '1',
  PAYEES_DECLINED: '1',
  ANCHOR_DECLINED: '1',
};

// The seven keys a module wiring its own rates and payout rail supplies in code instead. What
// openPorts reads from the environment is what serve must judge it on, so these come out of
// PRODUCTION for the module below.
const SUPPLIED_IN_CODE = [
  'CREDIT_BUY_RATE',
  'CREDIT_BUY_SCALE',
  'CREDIT_PAR_RATE',
  'CREDIT_PAR_SCALE',
  'PAYOUT_RATE',
  'PAYOUT_SCALE',
  'PROCESSOR_URL',
];

const WIRED_IN_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(PRODUCTION).filter(([key]) => !SUPPLIED_IN_CODE.includes(key)),
);

// A house rate table and a payout rail behind a vault: the two ports a deployment is most likely
// to hold in code rather than in env vars.
const HOUSE_RATES =
  'rates: { buyRate: 12000n, buyScale: 6, parRate: 6n, parScale: 3, payoutRate: 6n, payoutScale: 3 }';
const VAULT_PROCESSOR =
  "processor: { submitPayout: async ({ key }) => ({ providerRef: 'vault_' + key }), " +
  "payoutStatus: async () => ({ state: 'PAID' }) }";

const withPorts = (...slots: string[]): string =>
  `${MODULE}\nexport const ports = { ${slots.join(', ')} };\n`;

function scaffold(source: string = MODULE): string {
  const dir = mkdtempSync(join(tmpdir(), 'economy-live-'));
  writeFileSync(join(dir, 'economy.app.ts'), source);
  return dir;
}

interface Answer {
  readonly status: number;
  readonly body: string;
}

interface Ask {
  readonly method?: string;
  readonly token?: string;
  readonly body?: unknown;
}

/**
 * One request on an unpooled socket, so nothing outlives the assertion. The peer is a process this
 * suite spawned, and one that accepts the connection and then says nothing would leave the request
 * waiting with no ceiling of its own.
 */
function call(port: number, path: string, ask: Ask = {}): Promise<Answer> {
  const { method = 'GET', token, body } = ask;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        timeout: 20_000,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(payload === null
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`${method} ${path} was never answered`));
    });
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

type Route = { method: string; path: string; source: string };

// The table this module mounts, written out rather than derived from the run. A verb that
// under-reports its own routes would otherwise shrink both the claim and the sweep that reads it,
// and the two would still agree.
const TABLE = [
  'GET /healthz',
  'GET /readyz',
  'POST /submit',
  'GET /v1/wallet',
  'GET /v1/entitlements',
  'GET /v1/subscriptions',
  'GET /v1/payouts',
  'GET /v1/rates',
  'GET /v1/catalog',
  'GET /v1/posting/:txnId',
];

function claimedRoutes(dir: string): Route[] {
  const listed = runSync(['routes', '--json'], dir, PRODUCTION);
  assert.equal(listed.status, 0, listed.stderr);
  exercised.add('routes');
  const routes = (JSON.parse(listed.stdout) as { routes: Route[] }).routes;
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.path}`),
    TABLE,
  );
  return routes;
}

// The reporting verbs describe a boot that has not happened yet. Running them against the same
// module and the same environment serve is about to use is what makes the description checkable.
test('check and routes agree with the environment serve will bind under', () => {
  const dir = scaffold();

  const checked = runSync(['check', '--json'], dir, PRODUCTION);
  exercised.add('check');
  assert.equal(checked.status, 0, checked.stderr);
  const report = JSON.parse(checked.stdout) as {
    posture: string;
    postures: { name: string }[];
    lints: unknown[];
    adapters: { production: boolean; store: { kind: string } };
  };
  assert.equal(report.posture, 'function', 'the module states a real posture');
  assert.deepEqual(
    report.postures.map((p) => p.name),
    ['deployed'],
    'dev refuses NODE_ENV=production, so there is no dev posture to report',
  );
  assert.deepEqual(
    preflightOf(checked.stdout),
    [],
    'production preflight is not clean',
  );
  assert.deepEqual(report.lints, []);
  assert.equal(report.adapters.production, true);

  const routes = claimedRoutes(dir);
  assert.deepEqual(
    [...new Set(routes.map((r) => r.source))],
    ['product'],
    'a module route appeared in a module that declares none',
  );
});

// serve's happy path: the production posture, a real bind, and every route the reporting verb
// claimed actually answering. A refusal is what the rest of this suite already proves; this is
// the run that follows one.
test('serve binds in production and answers every route routes claims', async () => {
  const dir = scaffold();
  const routes = claimedRoutes(dir);

  const child = runLive(['serve', '--port', '0'], dir, PRODUCTION);
  exercised.add('serve');
  const seen = collect(child);
  let code: number | null = null;
  try {
    const banner = await until(seen, /economy serve — /);
    const port = Number(
      /on 0\.0\.0\.0:(\d+), worker running/.exec(banner)?.[1] ?? 0,
    );
    assert.ok(port > 0, `serve printed no bound port:\n${banner}`);

    let txnId = '';
    const probed: string[] = [];
    for (const route of routes) {
      const path = route.path.replace(':txnId', txnId);
      const answer =
        route.method === 'POST'
          ? await call(port, path, {
              method: 'POST',
              token: PAYMENTS,
              body: {
                kind: 'topUp',
                idempotencyKey: 'live_cli_topup',
                userId: 'usr_ada',
                amount: 'CREDIT:400.00',
                source: 'card',
              },
            })
          : await call(port, path, { token: ADA });
      assert.notEqual(
        answer.status,
        404,
        `${route.method} ${path} is claimed and does not exist`,
      );
      if (route.path === '/submit') {
        const outcome = JSON.parse(answer.body) as {
          status: string;
          transaction: { id: string };
        };
        assert.equal(outcome.status, 'committed');
        txnId = outcome.transaction.id;
      }
      if (route.path === '/v1/wallet') {
        const wallet = JSON.parse(answer.body) as { spendable: string };
        assert.equal(
          wallet.spendable,
          'CREDIT:400.00',
          'the top-up this test posted is not the balance the bind reads back',
        );
      }
      if (route.path === '/v1/posting/:txnId') {
        assert.equal(
          (JSON.parse(answer.body) as { txnId: string }).txnId,
          txnId,
        );
      }
      probed.push(`${route.method} ${route.path}`);
    }
    assert.deepEqual(probed, TABLE, 'the bind was not swept route for route');

    // The posture is real, so the same read without the bearer is refused by the bind itself.
    assert.equal((await call(port, '/v1/wallet')).status, 401);
    assert.equal((await call(port, '/v1/nowhere', { token: ADA })).status, 404);

    code = await stop(child);
  } finally {
    if (code === null)
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
  }
  assert.equal(
    code,
    0,
    'SIGTERM drains the bind and serve answers with its code',
  );
});

// A module may wire a port in code, and openPorts then never reads that port's env keys. Both
// reporting and refusal have to judge the bag the module actually supplies — and the half-wired
// module at the end is what keeps that from becoming a check that judges nothing.
test('serve binds a module that wires its own ports, and still refuses the ones it leaves', async () => {
  const dir = scaffold(withPorts(HOUSE_RATES, VAULT_PROCESSOR));

  const checked = runSync(['check', '--json'], dir, WIRED_IN_CODE);
  exercised.add('check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(
    preflightOf(checked.stdout),
    [],
    'check judged the module against env keys openPorts would never read',
  );

  const child = runLive(['serve', '--port', '0'], dir, WIRED_IN_CODE);
  exercised.add('serve');
  const seen = collect(child);
  let code: number | null = null;
  try {
    const banner = await until(seen, /economy serve — /);
    const port = Number(
      /on 0\.0\.0\.0:(\d+), worker running/.exec(banner)?.[1] ?? 0,
    );
    assert.ok(port > 0, `serve printed no bound port:\n${banner}`);

    // The bind quotes the module's own table, so the ports it wired are the ones in force —
    // a bind on the dev stand-ins would quote 8333/6 and 5/3.
    const quoted = JSON.parse(
      (await call(port, '/v1/rates', { token: ADA })).body,
    ) as { buy: { rateId: string }; payout: { rateId: string } };
    assert.equal(quoted.buy.rateId, 'buy:CREDIT->USD:12000/6');
    assert.equal(quoted.payout.rateId, 'payout:CREDIT->USD:6/3');

    code = await stop(child);
  } finally {
    if (code === null)
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
  }
  assert.equal(code, 0);

  // Half wired: the module states its rates and leaves the payout rail to an environment that
  // does not carry it. That refusal is what the check exists for, and it is intact.
  const half = scaffold(withPorts(HOUSE_RATES));
  const halfChecked = runSync(['check', '--json'], half, WIRED_IN_CODE);
  assert.equal(halfChecked.status, 2, halfChecked.stderr);
  assert.deepEqual(
    preflightOf(halfChecked.stdout)
      .filter((i) => i.severity === 'error')
      .map((i) => i.path),
    ['PROCESSOR_URL'],
  );
  const refused = runSync(['serve', '--port', '0'], half, WIRED_IN_CODE);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"path":"PROCESSOR_URL"/);
  assert.match(refused.stderr, /serve refuses dev stand-ins/);
});

// The worker role: no socket, real work through the real economy, and a run that stays up until
// it is signalled. Until now the verb was only ever seen refusing.
test('worker runs the background role alone, binds nothing, and drains on SIGTERM', async () => {
  const dir = scaffold();
  const child = runLive(['worker', '--demo', '--interval', '200'], dir);
  exercised.add('worker');
  const seen = collect(child);
  let code: number | null = null;
  try {
    const line = (await until(seen, /economy worker — /))
      .trim()
      .split('\n')[0]!;
    assert.match(line, /^economy worker — economy\.app\.ts, worker running$/);
    assert.equal(
      /on \d+\.\d+\.\d+\.\d+:\d+/.test(line),
      false,
      'the worker role bound a socket',
    );

    // --demo drives a top-up, a spend and an overdraft through the economy this role opened,
    // so the seed line is the proof that the role has a live economy behind it.
    const seeded = await until(seen, /demo seeded/);
    assert.match(
      seeded,
      /demo seeded — ada spendable CREDIT:280\.00; overdraft rejected INSUFFICIENT_FUNDS/,
    );

    code = await stop(child);
  } finally {
    if (code === null)
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
  }
  assert.equal(
    code,
    0,
    'SIGTERM drains the worker and it answers with its code',
  );
});

// dev is the fifth, and the one already covered running; what is added here is that its bind
// serves the same economy the production bind does, under the dev grammar instead.
test('dev binds loopback and serves the same reads under dev tokens', async () => {
  const dir = scaffold();
  const child = runLive(['dev', '--port', '0'], dir);
  exercised.add('dev');
  const seen = collect(child);
  let code: number | null = null;
  try {
    const banner = await until(seen, /economy dev — /);
    const port = Number(
      /on 127\.0\.0\.1:(\d+), worker running/.exec(banner)?.[1] ?? 0,
    );
    assert.ok(port > 0, `dev printed no bound port:\n${banner}`);

    // The module states its own posture, so dev serves that one and not the dev grammar.
    assert.match(banner, /posture {2}module authenticate \(function\)/);
    assert.equal((await call(port, '/healthz')).status, 200);
    assert.equal((await call(port, '/v1/wallet', { token: ADA })).status, 200);
    assert.equal(
      (await call(port, '/v1/wallet', { token: 'dev_user_ada' })).status,
      401,
    );

    code = await stop(child);
  } finally {
    if (code === null)
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
  }
  assert.equal(code, 0);
});

// The environment a spawned verb reads decides which store it opens, so a verb that inherits the
// machine's is running someone else's composition. The fan-out loads the repo's .env before it
// plans, and every name in it used to reach these children.
test('a spawned verb reads the environment the test states and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-hermetic-'));
  writeFileSync(
    join(dir, 'economy.app.ts'),
    `console.error('SAW ' + JSON.stringify(process.env));\n${MODULE}`,
  );

  // What the machine holds while the verb runs. DATABASE_URL and REDIS_URL each select an adapter;
  // SIGNING_SECRET is stated below as well, so it also says which of the two the child reads.
  const ambient: Record<string, string> = {
    DATABASE_URL: 'postgres://poison:poison@127.0.0.1:1/nothing',
    PG_URL: 'postgres://poison:poison@127.0.0.1:1/nothing',
    MYSQL_TEST_URL: 'mysql://poison:poison@127.0.0.1:1/nothing',
    REDIS_URL: 'redis://127.0.0.1:1',
    SIGNING_SECRET: 'sig_ambient',
    FORCE_COLOR: '1',
  };
  const restore = new Map(
    Object.keys(ambient).map((name) => [name, process.env[name]]),
  );
  let checked;
  try {
    Object.assign(process.env, ambient);
    checked = runSync(['check', '--json'], dir, {
      WEBHOOK_SECRET: 'whsec_hermetic',
      SIGNING_SECRET: 'sig_stated',
    });
  } finally {
    for (const [name, value] of restore) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.equal(checked.status, 0, checked.stderr);
  const saw = JSON.parse(
    /^SAW (\{.*\})$/m.exec(checked.stderr)?.[1] ??
      assert.fail(
        `the module never reported its environment:\n${checked.stderr}`,
      ),
  ) as Record<string, string>;

  // Written out rather than read back from the helper, which would agree with itself whatever it
  // passed. The machine names are the three a spawned node process is given; a run on a host that
  // sets none of them expects none of them.
  const machine = ['HOME', 'PATH', 'TMPDIR'].filter(
    (name) => process.env[name] !== undefined,
  );
  assert.deepEqual(
    Object.keys(saw)
      .filter((name) => name !== PLATFORM_STAMPED)
      .sort(),
    [...machine, 'NODE_ENV', 'SIGNING_SECRET', 'WEBHOOK_SECRET'].sort(),
  );
  for (const name of Object.keys(ambient)) {
    if (name === 'SIGNING_SECRET') continue;
    assert.equal(
      saw[name],
      undefined,
      `${name} reached the verb from the machine`,
    );
  }
  assert.equal(
    saw.SIGNING_SECRET,
    'sig_stated',
    'the stated secret lost to the machine',
  );

  // And the product fact the leak produced: the ambient DATABASE_URL chose the store.
  const report = JSON.parse(checked.stdout) as {
    adapters: { store: { kind: string; url: string | null } };
  };
  assert.deepEqual(report.adapters.store, { kind: 'memory', url: null });
});

// The roster is closed at five verbs, so a live run of each is the whole obligation. This
// counts what ran rather than trusting the file above to have covered it.
test('all five verbs ran against a live economy in this file', () => {
  assert.deepEqual([...exercised].sort(), [...VERBS].sort());
  assert.equal(exercised.size, 5);
});
