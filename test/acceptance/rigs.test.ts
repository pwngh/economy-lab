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
 * The scaffolder against a real engine: every template, on every rig this run can reach, booted by
 * the published `economy` bin in the production posture and answering over a socket.
 *
 * Why this file exists. `create-economy.walk.test.ts` is the memory posture — `economy dev`
 * substitutes the memory store whatever `DATABASE_URL` says — so before this file the CLI, the
 * umbrella, the engine packages and the rigs had never been in one reach set. A scaffolded project
 * was proven to run on a store nobody deploys.
 *
 * What the matrix covers is asserted, not assumed: the cells are the cross product of the template
 * directories and the engine roster, an unreachable rig produces a skip that names it, and the run
 * reconciles the cells it exercised against the ones it declared. A matrix that quietly covered one
 * cell would otherwise satisfy every assertion in it.
 *
 * The namespace discipline is the same one the rest of the tree keeps, for the same reason:
 * `applyMysqlSchema` drops and recreates its tables, so it only ever runs against a database
 * created moments earlier and dropped afterwards, and Postgres gets a throwaway schema the child
 * reaches through its own connection string. Nothing here touches the shared `economy_lab` tables,
 * which two other tiers are using while this one runs.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import '#test/support/dist-guard.ts';

import { applyMysqlSchema, createMysqlPool } from '@pwngh/economy-mysql';
import { postgresStore } from '@pwngh/economy-postgres';

import {
  freshName,
  safeDatabaseName,
  testMysqlUrl,
  testPostgresUrl,
  withDatabase,
} from '#test/support/adapters.ts';
import {
  LEG_BOUND_MS,
  TEMPLATES,
  build,
  amend,
  openWorkspace,
  reachable,
  request,
  run,
  scaffold,
  serve,
  serveRefused,
} from '#test/acceptance/harness.ts';

import type {
  Ran,
  Project,
  Refusal,
  Workspace,
} from '#test/acceptance/harness.ts';

/**
 * The environment `economy serve` refuses to bind without, minus the store — the template's own
 * `_env.example` with real values, down to the two policy anchors production must state rather
 * than inherit and the three optional ports declined out loud.
 */
const SERVE_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  WEBHOOK_SECRET: 'acceptance-webhook-secret',
  SIGNING_SECRET: 'acceptance-signing-secret',
  CREDIT_BUY_RATE: '120',
  CREDIT_BUY_SCALE: '0',
  CREDIT_PAR_RATE: '1',
  CREDIT_PAR_SCALE: '0',
  PAYOUT_RATE: '5',
  PAYOUT_SCALE: '3',
  PROCESSOR_URL: 'https://payouts.invalid/payout',
  MATURITY_HORIZON_CARD_MS: '604800000',
  VELOCITY_LIMIT_MINOR: '100000000',
  DISPATCHER_DECLINED: '1',
  PAYEES_DECLINED: '1',
  ANCHOR_DECLINED: '1',
};

const SERVE_ARGV = [
  'serve',
  '--app',
  'dist/economy.app.js',
  '--port',
  '0',
] as const;

/**
 * The engine wiring, as the framework's own refusal spells it: install the engine package and pass
 * the store. A scaffolded template states no store, because the lab's core loads no driver by
 * scheme — `openPorts` reads `DATABASE_URL` to decide what it is *missing*, never to import one.
 * These are the lines a host writes once, and running them here is what proves the remedy the
 * refusal prints is a remedy.
 *
 * The amend stays in this harness rather than moving into the template — decided at Q98: a
 * template ships no engine import it may never use and no scheme branch the core itself refuses
 * to have, so the module opens no store; the README's "Going to production" carries these lines
 * and `_env.example` says so beside `DATABASE_URL`. Running them here is what keeps the remedy a
 * remedy, and the refusal pair above is the state a scaffold is deliberately left in.
 */
const ENGINE_WIRING = `import { mysql } from '@pwngh/economy/mysql';
import { postgres } from '@pwngh/economy/postgres';

const databaseUrl = process.env.DATABASE_URL ?? '';
export const ports = {
  store: databaseUrl.startsWith('mysql://')
    ? await mysql(databaseUrl)
    : await postgres(databaseUrl),
};
`;

/** A namespace with this build's schema in it, and the URL a child process reaches it through. */
interface Namespace {
  /** What the child gets as DATABASE_URL. */
  readonly url: string;
  /** A URL of the same shape naming a namespace that was never created. */
  readonly absent: string;
  drop(): Promise<void>;
}

interface Engine {
  readonly name: string;
  /** The server this run was told about, or null when nothing named it. */
  readonly server: string | null;
  readonly host: string;
  readonly port: number;
  /** What a skip says when the rig is not there. */
  readonly needs: string;
  open(server: string): Promise<Namespace>;
}

/**
 * Postgres takes a throwaway schema. `postgresStore` creates it, loads the canonical DDL into it
 * and verifies the stamp, and its `close()` drops it — so the applier stays open for the length of
 * the cell and the teardown is one call. The child resolves unqualified names to that schema
 * through a connection-string option, so the whole namespace travels as one value and nothing else
 * in the child's environment has to carry it.
 */
async function openPostgres(server: string): Promise<Namespace> {
  const schema = freshName('el_acc');
  const applier = await postgresStore({ url: server, schemaName: schema });
  return {
    url: searchPath(server, schema),
    absent: searchPath(server, `${schema}_absent`),
    drop: () => applier.close(),
  };
}

function searchPath(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-c search_path=${schema}`);
  return parsed.toString();
}

/**
 * MySQL takes a whole database of its own, because `applyMysqlSchema` drops and recreates every
 * table it owns: run against the shared one it would delete the tables another suite is mid-way
 * through using.
 */
async function openMysql(server: string): Promise<Namespace> {
  const database = safeDatabaseName(freshName('el_acc'));
  const admin = await createMysqlPool(withDatabase(server, null));
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
  } catch (error) {
    await admin.end().catch(() => {});
    throw error;
  }
  const pool = await createMysqlPool(withDatabase(server, database));
  try {
    await applyMysqlSchema(pool);
  } finally {
    await pool.end().catch(() => {});
  }
  return {
    url: withDatabase(server, database),
    absent: withDatabase(server, `${database}_absent`),
    drop: async () => {
      try {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      } finally {
        await admin.end();
      }
    },
  };
}

const ENGINES: readonly Engine[] = [
  {
    name: 'postgres',
    server: testPostgresUrl(process.env),
    host: '127.0.0.1',
    port: 55432,
    needs: 'the postgres rig on 55432 (npm run docker && npm run db:migrate)',
    open: openPostgres,
  },
  {
    name: 'mysql',
    server: testMysqlUrl(process.env),
    host: '127.0.0.1',
    port: 53306,
    needs: 'the mysql rig named by MYSQL_TEST_URL (npm run docker)',
    open: openMysql,
  },
];

/**
 * Which rigs answered, resolved once before any cell registers. A reachability probe rather than a
 * connect: a rig that is there and broken must fail a cell, not disappear from the matrix.
 */
const answered = new Map<string, boolean>(
  await Promise.all(
    ENGINES.map(
      async (engine) =>
        [
          engine.name,
          engine.server !== null &&
            (await reachable(hostOf(engine), portOf(engine))),
        ] as const,
    ),
  ),
);

function hostOf(engine: Engine): string {
  return engine.server === null ? engine.host : new URL(engine.server).hostname;
}

function portOf(engine: Engine): number {
  const named = engine.server === null ? '' : new URL(engine.server).port;
  return named === '' ? engine.port : Number(named);
}

/** Some rig, for the legs that need one engine rather than a named one. */
const anyRig = ENGINES.find((engine) => answered.get(engine.name)) ?? null;

/** Every cell the matrix declares, and every cell it actually ran. */
const DECLARED = TEMPLATES.flatMap((template) =>
  ENGINES.map((engine) => `${template} on ${engine.name}`),
);
const exercised: string[] = [];
const skipped: string[] = [];

describe('acceptance: every template on every reachable engine', () => {
  let ws: Workspace | null = null;

  before(
    () => {
      ws = openWorkspace();
    },
    { timeout: LEG_BOUND_MS },
  );

  after(() => {
    ws?.clean();
  });

  for (const template of TEMPLATES) {
    describe(template, () => {
      let project: Project | null = null;

      before(
        () => {
          project = scaffold(ws!, { template });
          build(project);
        },
        { timeout: LEG_BOUND_MS },
      );

      // The state a developer is actually in on their first production deploy: the module the
      // scaffolder wrote, the environment its own _env.example describes, and a `DATABASE_URL`
      // pointing at a real engine. The module supplies no store, so both verbs refuse it — and
      // the point of the pair is that they refuse it together. Q97 was that they did not: `check`
      // called this environment clean and exited 0, and `serve` then died in it.
      describe('as the scaffolder wrote it', () => {
        let checked: Ran = { code: 1, out: '' };
        let refused: Refusal = { code: null, bound: null, out: '' };

        before(
          async () => {
            if (anyRig === null) return;
            const env = { ...SERVE_ENV, DATABASE_URL: anyRig.server! };
            checked = run('npm', ['run', 'check'], project!.dir, {
              env,
              stated: true,
            });
            refused = await serveRefused(project!.dir, {
              argv: [...SERVE_ARGV],
              env,
              stated: true,
            });
          },
          { timeout: LEG_BOUND_MS },
        );

        test('economy check names the engine and refuses the module for it', (t) => {
          if (anyRig === null) {
            t.skip('needs one reachable engine rig');
            return;
          }
          assert.match(
            checked.out,
            /adapters {2}store (postgres|mysql) /,
            `the truth pass named no engine\n${checked.out.slice(-2000)}`,
          );
          assert.doesNotMatch(
            checked.out,
            /preflight clean/,
            `check called an environment clean that serve refuses\n${checked.out.slice(-2000)}`,
          );
          assert.match(
            checked.out,
            /but no store was supplied/,
            `check refused for some other reason\n${checked.out.slice(-2000)}`,
          );
          assert.equal(
            checked.code,
            2,
            `economy check answered ${checked.code}\n${checked.out.slice(-2000)}`,
          );
        });

        // The Q97 assertion, the way round it belongs: the deploy-time verdict and the boot are one
        // reading, so the developer is told at `check` what used to kill them at `serve`. Both
        // verbs refuse, both name the same knob, and neither binds.
        test('economy serve refuses to bind for the reason check printed', (t) => {
          if (anyRig === null) {
            t.skip('needs one reachable engine rig');
            return;
          }
          assert.notEqual(
            checked.code,
            0,
            'check passed the environment serve is about to refuse',
          );
          assert.equal(
            refused.bound,
            null,
            'serve bound a socket with no store, so this refusal is gone',
          );
          assert.notEqual(
            refused.code,
            0,
            'serve answered 0 and served nothing',
          );
          assert.match(
            refused.out,
            /but no store was supplied/,
            `serve failed for some other reason\n${refused.out.slice(-2000)}`,
          );
        });
      });

      describe('with the engine wiring its refusal prescribes', () => {
        before(
          () => {
            amend(project!, ENGINE_WIRING);
          },
          { timeout: LEG_BOUND_MS },
        );

        for (const engine of ENGINES) {
          const cell = `${template} on ${engine.name}`;

          test(
            `${cell}: economy serve binds and answers a store-backed read`,
            { timeout: LEG_BOUND_MS },
            async (t) => {
              if (!answered.get(engine.name)) {
                skipped.push(cell);
                t.skip(`${cell} needs ${engine.needs}`);
                return;
              }
              const namespace = await engine.open(engine.server!);
              try {
                const service = await serve(project!.dir, {
                  argv: [...SERVE_ARGV],
                  env: { ...SERVE_ENV, DATABASE_URL: namespace.url },
                  stated: true,
                });
                try {
                  const health = await request(`${service.base}/healthz`);
                  assert.equal(health.status, 200);
                  assert.match(health.body, /"status":"ok"/);

                  // /readyz is the framework's one store-touching read, and it takes no
                  // principal — which is the only money-shaped thing this posture can prove.
                  // The dev-token tail every template ships is inert under NODE_ENV=production
                  // by design, so /submit answers 401 here and the money leg stays with the
                  // memory variant.
                  const ready = await request(`${service.base}/readyz`);
                  assert.equal(
                    ready.status,
                    200,
                    `the engine answered no read: ${ready.body.slice(0, 400)}`,
                  );
                  assert.match(ready.body, /"status":"ready"/);

                  const wallet = await request(`${service.base}/v1/wallet`, {
                    headers: { authorization: 'Bearer dev_user_ada' },
                  });
                  assert.equal(
                    wallet.status,
                    401,
                    'a dev token authenticated against a production posture',
                  );

                  assert.match(
                    service.output(),
                    /economy serve — dist\/economy\.app\.js on /,
                    'the banner names some other module',
                  );
                } finally {
                  await service.stop();
                }

                // The control, and it is what makes the boot above evidence: the same project,
                // the same environment, one namespace that was never created. A build that had
                // quietly fallen back to memory would boot here too.
                const control = await serveRefused(project!.dir, {
                  argv: [...SERVE_ARGV],
                  env: { ...SERVE_ENV, DATABASE_URL: namespace.absent },
                  stated: true,
                });
                assert.equal(
                  control.bound,
                  null,
                  `the service bound port ${String(control.bound)} against a namespace that does not exist, so the boot above proves nothing about which one it reached`,
                );
              } finally {
                await namespace.drop();
              }
              exercised.push(cell);
            },
          );
        }
      });
    });
  }

  // Last, so it reads what the cells above did rather than what they were meant to do.
  test('the matrix reconciles: every declared cell ran or named its rig', () => {
    assert.deepEqual(
      DECLARED.sort(),
      [...exercised, ...skipped].sort(),
      'a declared cell neither ran nor skipped',
    );
    assert.equal(
      DECLARED.length,
      TEMPLATES.length * ENGINES.length,
      'the matrix is not the cross product it declares',
    );
    assert.equal(DECLARED.length, 4, 'the declared matrix changed size');
    assert.deepEqual(
      exercised.sort(),
      DECLARED.filter((cell) => exercisable(cell)).sort(),
      'a cell with a reachable rig did not run',
    );
  });
});

/** Whether a declared cell's engine answered, read back out of the cell label. */
function exercisable(cell: string): boolean {
  const engine = ENGINES.find((e) => cell.endsWith(` on ${e.name}`));
  return engine !== undefined && answered.get(engine.name) === true;
}
