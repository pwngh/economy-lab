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

// Ops supervisor demos. argv[2] picks the mode:
//
//   scripts/ops-demo.ts stuck-saga  # closed loop: detect, sweep, verify (default)
//   scripts/ops-demo.ts integrity   # ledger tamper: prove and escalate, fix nothing
//   scripts/ops-demo.ts deadlock    # retry-pressure storm on a real engine ($DATABASE_URL)
//
// Each wires the supervisor exactly as a host would: opsRuntime wraps the
// composition's meter/logger, and audit records stream to stdout as JSONL.

import {
  capabilitiesFromEnv,
  createWorker,
  credits,
  economyFromCapabilities,
  externalsFromEnv,
  noopLogger,
  noopMeter,
  requestPayout,
  spend,
  systemActor,
  topUp,
  userActor,
  workerCtxFrom,
} from '#src/index.ts';

import {
  createSupervisor,
  jsonlAuditSink,
  opsRuntime,
} from '#src/ops/index.ts';

import type { Clock, Processor, Store } from '#src/ports.ts';
import type { Economy } from '#src/contract.ts';
import type { OpsRuntime } from '#src/ops/index.ts';

const say = (line: string): void => console.warn(line);

const stdoutAudit = jsonlAuditSink((line) => process.stdout.write(`${line}\n`));

function manualClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// --- stuck-saga -------------------------------------------------------------------

async function runStuckSaga(): Promise<void> {
  say('ops demo: the stuck payout saga, closed loop.');
  say('A host whose background worker is down: payouts park in RESERVED');
  say('and nothing advances them. The supervisor notices and acts once.');
  say('');

  const clock = manualClock(Date.parse('2026-07-16T12:00:00Z'));
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const processor: Processor = {
    submitPayout: async () => ({ providerRef: 'prov_demo' }),
  };
  const caps = await capabilitiesFromEnv(
    { PAYOUT_MIN_EARNED_MINOR: '1000' },
    externalsFromEnv({}, { processor }),
    { clock, logger: runtime.logger, meter: runtime.meter },
  );
  const economy = economyFromCapabilities(caps);
  const worker = createWorker(caps.store, workerCtxFrom(caps));

  const buyer = 'usr_buyer';
  const seller = 'usr_seller';
  await economy.submit(
    topUp({
      idempotencyKey: 'idem_topup',
      actor: systemActor('billing'),
      userId: buyer,
      amount: credits(150),
      source: 'card',
    }),
  );
  await economy.submit(
    spend({
      idempotencyKey: 'idem_order',
      actor: userActor(buyer),
      orderId: 'ord_demo',
      buyerId: buyer,
      sku: 'gallery-print',
      price: credits(100),
      recipients: [{ sellerId: seller, shareBps: 10_000 }],
    }),
  );
  const request = await economy.submit(
    requestPayout({
      idempotencyKey: 'idem_payout',
      actor: userActor(seller),
      userId: seller,
      amount: credits(40),
    }),
  );
  if (request.status !== 'committed') {
    throw new Error(`requestPayout ${request.status}`);
  }
  const sagaId = request.transaction.meta.sagaId as string;
  const before = await economy.read.saga(sagaId);
  say(`payout requested: saga ${sagaId} is ${before?.state}, worker down.`);

  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: caps.store.sagas,
    runSweep: (now) => worker.runOnce({ now, limit: 10 }),
    audit: stdoutAudit,
    config: { stuckSagaAgeMs: 60_000, actionCooldownMs: 30_000 },
  });

  say('tick at T+0: nothing is stuck yet, the supervisor emits nothing.');
  await supervisor.tick();

  clock.advance(120_000);
  say(
    'two minutes pass. tick at T+2m (audit records on stdout, one JSON line each):',
  );
  await supervisor.tick();

  const after = await economy.read.saga(sagaId);
  say(`saga ${sagaId} is now ${after?.state}: the sweep advanced it.`);

  const report = await economy.read.prove();
  say(
    `prove: conserved=${report.conserved} chainIntact=${report.chainIntact} ` +
      `noOverdraft=${report.noOverdraft} — the supervisor wrote no ledger state.`,
  );
}

// --- integrity --------------------------------------------------------------------

async function runIntegrity(): Promise<void> {
  say('ops demo: the integrity mismatch, escalation only.');
  say(
    'A stored posting is tampered behind the ledger. The checkpoint reverify',
  );
  say(
    'catches it; the supervisor gathers proof and escalates. It fixes nothing.',
  );
  say('');

  const clock = manualClock(Date.parse('2026-07-16T12:00:00Z'));
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const caps = await capabilitiesFromEnv(
    {},
    externalsFromEnv(
      {},
      { processor: { submitPayout: async () => ({ providerRef: 'p' }) } },
    ),
    { clock, logger: runtime.logger, meter: runtime.meter },
  );
  const economy = economyFromCapabilities(caps);
  const worker = createWorker(caps.store, workerCtxFrom(caps));

  const topped = await economy.submit(
    topUp({
      idempotencyKey: 'idem_topup',
      actor: systemActor('billing'),
      userId: 'usr_a',
      amount: credits(100),
      source: 'card',
    }),
  );
  if (topped.status !== 'committed') {
    throw new Error(`topUp ${topped.status}`);
  }
  await worker.runOnce({ now: clock.now(), limit: 10 });
  say(
    `a top-up committed (${topped.transaction.id}) and the checkpoint sealed.`,
  );

  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: { list: async function* () {}, load: async () => null },
    runSweep: async () => {
      throw new Error('integrity findings must never trigger the sweep');
    },
    audit: stdoutAudit,
    prove: () => economy.read.prove(),
    pauseWorker: () => worker.pause(),
    escalate: sayEscalation,
  });

  await supervisor.tick();
  say('tick with an intact ledger: the supervisor emits nothing.');

  tamperFirstLeg(caps.store, topped.transaction.id);
  say(
    'a leg of the stored posting is tampered: +1 minor unit out of thin air.',
  );

  await worker.runOnce({ now: clock.now(), limit: 10 });
  say(
    'the next sweep reverifies the sealed checkpoint and reports a mismatch.',
  );
  say('tick (audit records on stdout):');
  await supervisor.tick();

  const report = await economy.read.prove();
  say(
    `prove now says conserved=${report.conserved} — the evidence is attached, ` +
      'the response is human. No automated action touched the ledger.',
  );
  say(
    `worker.paused()=${worker.paused()} — containment: the scheduled loop is ` +
      'held until a human resumes it; the supervisor never resumes on its own.',
  );
}

function sayEscalation(record: { detail: Record<string, unknown> }): void {
  const proof = record.detail.proof as {
    conserved: boolean;
    drift: unknown[];
  };
  say(
    `ESCALATED to a human: conserved=${proof.conserved}, ` +
      `${proof.drift.length} drifted account(s) in the attached report.`,
  );
}

// The in-memory ledger's test back door: mutate a stored leg behind the hash chain.
function tamperFirstLeg(store: Store, txnId: string): void {
  const tamper = (
    store.ledger as unknown as {
      __tamper?: (
        id: string,
        mutate: (legs: Array<{ amount: { minor: bigint } }>) => void,
      ) => void;
    }
  ).__tamper;
  tamper?.(txnId, (legs) => {
    legs[0].amount.minor += 1n;
  });
}

// --- deadlock ---------------------------------------------------------------------

const STORM_BUYERS = 60;
const STORM_SPENDS_PER_BUYER = 4;

async function seedStorm(
  economy: Economy,
  buyers: ReadonlyArray<string>,
): Promise<void> {
  await Promise.all(
    buyers.map((buyer) =>
      economy.submit(
        topUp({
          idempotencyKey: `idem_${buyer}_topup`,
          actor: systemActor('billing'),
          userId: buyer,
          amount: credits(100),
          source: 'card',
        }),
      ),
    ),
  );
}

function fireStorm(
  economy: Economy,
  buyers: ReadonlyArray<string>,
  seller: string,
): Promise<string[]> {
  return Promise.all(
    buyers.flatMap((buyer) =>
      Array.from({ length: STORM_SPENDS_PER_BUYER }, (_, n) =>
        economy
          .submit(
            spend({
              idempotencyKey: `idem_${buyer}_o${n}`,
              actor: userActor(buyer),
              orderId: `ord_${buyer}_${n}`,
              buyerId: buyer,
              sku: 'gallery-print',
              price: credits(20),
              recipients: [{ sellerId: seller, shareBps: 10_000 }],
            }),
          )
          .then((outcome) => outcome.status as string)
          .catch(() => 'fault'),
      ),
    ),
  );
}

// Prints the storm's outcome and retry pressure; returns the retry count for the
// no-advisory explanation.
function sayStormPressure(
  runtime: OpsRuntime,
  started: number,
  outcomes: ReadonlyArray<string>,
): number {
  const committed = outcomes.filter((status) => status === 'committed').length;
  const faulted = outcomes.filter((status) => status === 'fault').length;
  const elapsed = Date.now() - started;
  const pressure = runtime.signals
    .since(started)
    .filter((s) => s.source === 'meter' && s.name === 'engine.retry')
    .reduce((sum, s) => sum + s.value, 0);
  const rescued = runtime.signals
    .since(started)
    .filter((s) => s.source === 'meter' && s.name === 'engine.retry.recovered')
    .reduce((sum, s) => sum + s.value, 0);
  say(
    `${committed} committed, ${faulted} faulted in ${elapsed}ms; the engine ` +
      `retried ${pressure} conflicts and rescued ${rescued} commits with them.`,
  );
  return pressure;
}

async function runDeadlock(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || !/^(mysql|postgres):\/\//.test(url)) {
    say('the deadlock demo needs a real SQL engine to contend on.');
    say('Set DATABASE_URL to a migrated database:');
    say('  make bootstrap');
    say(
      '  DATABASE_URL=mysql://root:economy@localhost:3306/economy_lab npm run demo:ops -- deadlock',
    );
    throw new Error('DATABASE_URL is not a mysql:// or postgres:// DSN');
  }

  say('ops demo: retry-pressure storm on a real engine, advisory only.');
  say(
    'Concurrent spends against one shared seller and platform account contend',
  );
  say('on the chain head; the engine absorbs the conflicts inside its retry');
  say('budget, invisibly to every caller. The supervisor sees the pressure.');
  say('');

  const clock: Clock = { now: () => Date.now() };
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const caps = await capabilitiesFromEnv(
    { DATABASE_URL: url, DB_POOL_MAX: '60' },
    externalsFromEnv(
      {},
      { processor: { submitPayout: async () => ({ providerRef: 'p' }) } },
    ),
    { clock, logger: runtime.logger, meter: runtime.meter },
  );
  const economy = economyFromCapabilities(caps);
  createWorker(caps.store, workerCtxFrom(caps));

  const run = `storm_${crypto.randomUUID().slice(0, 8)}`;
  const seller = `usr_${run}_seller`;
  const buyers = Array.from(
    { length: STORM_BUYERS },
    (_, i) => `usr_${run}_b${i}`,
  );

  say(`seeding ${STORM_BUYERS} buyers on ${url.split('@').pop() ?? url} ...`);
  await seedStorm(economy, buyers);

  say(
    `firing ${STORM_BUYERS * STORM_SPENDS_PER_BUYER} concurrent spends into one seller ...`,
  );
  const started = Date.now();
  const outcomes = await fireStorm(economy, buyers, seller);
  const pressure = sayStormPressure(runtime, started, outcomes);

  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: caps.store.sagas,
    runSweep: async () => {
      throw new Error('the storm advisory must never trigger the sweep');
    },
    audit: stdoutAudit,
    config: { deadlockThreshold: 10, deadlockWindowMs: 120_000 },
  });

  say('tick (audit records on stdout):');
  const records = await supervisor.tick();
  if (records.length === 0) {
    say(
      `no advisory: ${pressure} retries stayed under the demo threshold of 10 — ` +
        'the sorted lock order kept the storm away; the detector stays armed.',
    );
  }

  const report = await economy.read.prove();
  say(
    `prove: conserved=${report.conserved} chainIntact=${report.chainIntact} — ` +
      'every retried conflict committed nothing; the pressure was real, the money never wrong.',
  );
  say(
    'in production the advisory corroborates against the engine counters ' +
      '(performance_schema on MySQL, pg_stat_database on Postgres).',
  );
  await caps.store.close();
}

// --- entry ------------------------------------------------------------------------

const mode = process.argv[2] ?? 'stuck-saga';
if (mode === 'stuck-saga') {
  await runStuckSaga();
} else if (mode === 'integrity') {
  await runIntegrity();
} else if (mode === 'deadlock') {
  await runDeadlock();
} else {
  console.error(
    `unknown mode "${mode}"; use "stuck-saga", "integrity", or "deadlock"`,
  );
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
}
