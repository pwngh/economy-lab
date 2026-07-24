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

// The multi-node netting shape bench: N separate Node processes over one shared database, each
// wired through openClusterNode; the parent reports the aggregate accept rate per node count.
//
//   sh scripts/docker.sh run --rm -e BENCH_BACKENDS=postgres,mysql bench scripts/bench-multinode.ts
//
// One machine, one fsync device: past the point it saturates the aggregate goes flat where real
// hardware would keep scaling, so the number is a shape, not a ceiling.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { postgresStore } from '#src/engines/postgres.ts';
import {
  mysqlStore,
  createMysqlPool,
  applyMysqlSchema,
} from '#src/engines/mysql.ts';
import { createMariadbPool } from '#src/engines/mysql-mariadb.ts';
import { sha256Digest } from '#src/digest.ts';
import { randomIds, systemClock } from '#src/runtime.ts';
import { openClusterNode } from '#src/netting.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { earned, spendable, SYSTEM } from '#src/accounts.ts';
import { resolveConfig } from '#scripts/support/harness.ts';
import { freshName, withDatabase } from '#test/support/adapters.ts';

import type { Leg, Store } from '#src/ports.ts';

const NODES_SWEEP = [1, 2, 4];
const SESSIONS_PER_NODE = 2;
const BUYERS_PER_NODE = 8;
const MOVEMENTS_PER_NODE = 400;

const cfg = resolveConfig(process.env);

// --- Child: one economy node ------------------------------------------------------

type ChildReport = {
  accepted: number;
  rejected: number;
  recordMs: number;
  settleMs: number;
};

async function openChildStore(): Promise<Store> {
  const digest = sha256Digest();
  const clock = systemClock();
  if (process.env.MULTI_BACKEND === 'postgres') {
    // Attach to the parent-applied schema: search_path via URL options, no re-apply.
    const url = new URL(cfg.urls.postgres);
    url.searchParams.set(
      'options',
      `-c search_path=${process.env.MULTI_SCHEMA}`,
    );
    return postgresStore({ url: url.toString(), digest, clock });
  }
  // The wire-trial knob rides the forked environment, so a BENCH_MYSQL_DRIVER=mariadb run
  // measures every node on the trial wire.
  const childUrl = withDatabase(cfg.urls.mysql, process.env.MULTI_SCHEMA!);
  const pool =
    cfg.mysqlDriver === 'mariadb'
      ? await createMariadbPool(childUrl)
      : await createMysqlPool(childUrl);
  return mysqlStore({ pool, digest, clock, schema: 'assert' });
}

function purchase(buyer: string, seller: string, minor: bigint): Leg[] {
  const amount = toAmount('CREDIT', minor);
  return [debit(spendable(buyer), amount), credit(earned(seller), amount)];
}

async function runChild(): Promise<void> {
  const nodeId = process.env.MULTI_NODE_ID!;
  const store = await openChildStore();
  try {
    const node = openClusterNode(
      { store, digest: sha256Digest(), clock: systemClock(), ids: randomIds() },
      { nodeId, nodes: process.env.MULTI_NODES!.split(',') },
    );
    const buyers = Array.from(
      { length: BUYERS_PER_NODE },
      (_, i) => `usr_mn_${nodeId}_${i}`,
    );
    for (const buyer of buyers) {
      await store.transaction((unit) =>
        postEntry(unit.ledger, {
          txnId: `txn_mn_fund_${buyer}`,
          legs: [
            credit(spendable(buyer), toAmount('CREDIT', 1_000_000n)),
            debit(SYSTEM.REVENUE, toAmount('CREDIT', 1_000_000n)),
          ],
          meta: { source: 'card' },
        }),
      );
    }
    // This node's sessions are the scopes the shared assignment hands it — the router's
    // contract, not hand-disjoint naming.
    const scopes: string[] = [];
    for (let k = 0; scopes.length < SESSIONS_PER_NODE; k += 1) {
      if (k >= 10_000) {
        throw new Error('scope scan exhausted without enough owned scopes');
      }
      const scope = `mn_${process.env.MULTI_ROUND}_${k}`;
      if (node.owns(scope)) {
        scopes.push(scope);
      }
    }
    const sessions = scopes.map((scope) => node.openSession(scope));

    // Signal ready and wait for the shared start signal, so the measured window is record and settle
    // only — child startup contends on the money-install catalog and must not pollute the number.
    process.send!({ ready: true });
    await new Promise<void>((resolve) => {
      process.once('message', () => resolve());
    });

    const report: ChildReport = {
      accepted: 0,
      rejected: 0,
      recordMs: 0,
      settleMs: 0,
    };
    const r0 = performance.now();
    for (let i = 0; i < MOVEMENTS_PER_NODE; i += 1) {
      const outcome = await sessions[i % sessions.length]!.record({
        idempotencyKey: `mn_${nodeId}_${i}`,
        legs: purchase(buyers[i % buyers.length]!, `usr_mn_c_${nodeId}`, 100n),
      });
      if (outcome.status === 'accepted') {
        report.accepted += 1;
      } else {
        report.rejected += 1;
      }
    }
    report.recordMs = performance.now() - r0;
    const s0 = performance.now();
    for (const session of sessions) {
      await session.settle();
    }
    report.settleMs = performance.now() - s0;
    process.send!(report);
  } finally {
    await store.close();
  }
}

// --- Parent: provision once, sweep the node counts --------------------------------

async function provision(backend: string): Promise<{
  name: string;
  teardown: () => Promise<void>;
}> {
  const digest = sha256Digest();
  const clock = systemClock();
  if (backend === 'postgres') {
    const name = freshName('el_multi');
    // Opening with schemaName applies the schema, which postgresStore drops on close; this store
    // stays open until teardown to keep it alive for the children.
    const store = await postgresStore({
      url: cfg.urls.postgres,
      schemaName: name,
      digest,
      clock,
    });
    return { name, teardown: () => store.close() };
  }
  const name = freshName('el_multi');
  const admin = await createMysqlPool(withDatabase(cfg.urls.mysql, null));
  await admin.query(`CREATE DATABASE \`${name}\``);
  const pool = await createMysqlPool(withDatabase(cfg.urls.mysql, name));
  await applyMysqlSchema(pool);
  await pool.end();
  return {
    name,
    teardown: async () => {
      try {
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await admin.end();
      }
    },
  };
}

type SpawnedNode = {
  ready: Promise<void>;
  start: () => void;
  report: Promise<ChildReport>;
};

function spawnNode(input: {
  backend: string;
  schema: string;
  nodeId: string;
  nodeIds: ReadonlyArray<string>;
  round: string;
}): SpawnedNode {
  const child = fork(fileURLToPath(import.meta.url), {
    env: {
      ...process.env,
      MULTI_ROLE: 'node',
      MULTI_BACKEND: input.backend,
      MULTI_SCHEMA: input.schema,
      // Unique across the whole run: rounds share one database, so a reused node id would
      // collide on its funding txn ids.
      MULTI_NODE_ID: input.nodeId,
      MULTI_NODES: input.nodeIds.join(','),
      MULTI_ROUND: input.round,
    },
  });
  let markReady: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const report = new Promise<ChildReport>((resolve, reject) => {
    let received: ChildReport | null = null;
    child.on('message', (message) => {
      if ((message as { ready?: boolean }).ready) {
        markReady();
        return;
      }
      received = message as ChildReport;
    });
    child.on('exit', (code) =>
      received !== null && code === 0
        ? resolve(received)
        : reject(
            new Error(`node ${input.nodeId} exited ${code} without a report`),
          ),
    );
    child.on('error', reject);
  });
  return { ready, start: () => child.send('go'), report };
}

async function runParent(): Promise<void> {
  for (const backend of cfg.backends) {
    if (backend === 'in-memory') {
      continue;
    }
    let provisioned;
    try {
      provisioned = await provision(backend);
    } catch (error) {
      // A backend named in BENCH_REQUIRE that cannot provision fails the run, so partial
      // coverage never reads as a pass.
      if (cfg.required.includes(backend)) {
        throw new Error(
          `${backend} is required (BENCH_REQUIRE) but unavailable: ${(error as Error).message}`,
        );
      }
      console.warn(`${backend}: unavailable (${(error as Error).message})`);
      continue;
    }
    try {
      process.stdout.write(
        `${backend} — aggregate accept rate, N separate processes:\n`,
      );
      for (const nodes of NODES_SWEEP) {
        const round = `${process.pid}_n${nodes}`;
        const nodeIds = Array.from(
          { length: nodes },
          (_, i) => `${round}_${i}`,
        );
        const spawned = nodeIds.map((nodeId) =>
          spawnNode({
            backend,
            schema: provisioned.name,
            nodeId,
            nodeIds,
            round,
          }),
        );
        await Promise.all(spawned.map((node) => node.ready));
        const t0 = performance.now();
        for (const node of spawned) {
          node.start();
        }
        const reports = await Promise.all(spawned.map((node) => node.report));
        const wallMs = performance.now() - t0;
        const accepted = reports.reduce((sum, r) => sum + r.accepted, 0);
        const rejected = reports.reduce((sum, r) => sum + r.rejected, 0);
        if (rejected > 0) {
          throw new Error(
            `${rejected} movements rejected — disjoint scopes must not interfere`,
          );
        }
        const rate = Math.round(accepted / (wallMs / 1000));
        process.stdout.write(
          `  nodes ${nodes}: ${accepted} accepted, 0 rejected · ${rate} movements/s aggregate (record+settle) · settle clean\n`,
        );
      }
      process.stdout.write(
        '  caveat: one machine, one fsync device — the shape is the claim, not the ceiling.\n',
      );
    } finally {
      await provisioned.teardown();
    }
  }
}

if (process.env.MULTI_ROLE === 'node') {
  await runChild();
} else {
  await runParent();
}
