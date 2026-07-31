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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createWorker,
  credits,
  createEconomy,
  openPorts,
  proveEconomy,
  systemActor,
  topUp,
} from '#src/index.ts';
import { silentLogger, silentMeter } from '#src/runtime.ts';

import {
  createSupervisor,
  detectIntegrityMismatches,
  jsonlAuditSink,
  createSupervisorRuntime,
} from '#src/supervisor/index.ts';
import { fixedClock } from '#test/support/capabilities.ts';
import {
  feedOf,
  frozenSagaSource,
  meterSignal,
  proveReport,
  recorder,
} from '#test/supervisor/support.ts';

import type { AuditRecord } from '#src/supervisor/index.ts';
import type { ChainBreak } from '#src/chain.ts';
import type { ProveReport } from '#src/contract.ts';

test('integrity: a real ledger tamper escalates through the checkpoint mismatch, once, with a prove report', async () => {
  const clock = fixedClock(1_000_000);
  const runtime = createSupervisorRuntime({
    meter: silentMeter(),
    logger: silentLogger(),
    clock,
  });
  const ports = await openPorts(
    {},
    {
      processor: { submitPayout: async () => ({ providerRef: 'p' }) },
      clock,
      logger: runtime.logger,
      meter: runtime.meter,
    },
  );
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);

  const topped = await economy.submit(
    topUp({
      idempotencyKey: 'idem_topup',
      actor: systemActor('billing'),
      userId: 'usr_a',
      amount: credits(100),
      source: 'card',
    }),
  );
  assert.equal(topped.status, 'committed');
  if (topped.status !== 'committed') {
    return;
  }
  await worker.sweep({ now: clock.now(), limit: 10 });

  const { records, sink } = recorder();
  const lines: string[] = [];
  const jsonl = jsonlAuditSink((line) => lines.push(line));
  const escalations: AuditRecord[] = [];
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      throw new Error('integrity findings must never trigger the sweep');
    },
    audit: (record) => {
      sink(record);
      jsonl(record);
    },
    prove: () => economy.read.health(),
    escalate: (record) => escalations.push(record),
  });

  assert.deepEqual(await supervisor.tick(), []);

  const tamper = (
    ports.store.ledger as unknown as {
      __tamper?: (
        txnId: string,
        mutate: (legs: Array<{ amount: { minor: bigint } }>) => void,
      ) => void;
    }
  ).__tamper;
  assert.notEqual(tamper, undefined);
  tamper?.(topped.transaction.id, (legs) => {
    legs[0].amount.minor += 1n;
  });
  await worker.sweep({ now: clock.now(), limit: 10 });

  const escalated = await supervisor.tick();
  assert.deepEqual(
    escalated.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.deepEqual(escalated[0].detail.channels, ['log', 'meter']);
  assert.equal(escalations.length, 1);
  const proof = escalations[0].detail.proof as { conserved: boolean };
  assert.equal(proof.conserved, false);

  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(escalations.length, 1);
  assert.equal(records.length, 2);

  // The escalation's prove report serializes cleanly, bigint money fields included.
  assert.equal(lines.length, 2);
  for (const line of lines) {
    JSON.parse(line);
  }
});

test('integrity: the escalation record names the prover that filled its evidence', async () => {
  const clock = fixedClock(1_000_000);
  const runtime = createSupervisorRuntime({
    meter: silentMeter(),
    logger: silentLogger(),
    clock,
  });
  const ports = await openPorts(
    {},
    {
      processor: { submitPayout: async () => ({ providerRef: 'p' }) },
      clock,
      logger: runtime.logger,
      meter: runtime.meter,
    },
  );
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);

  const topped = await economy.submit(
    topUp({
      idempotencyKey: 'idem_topup',
      actor: systemActor('billing'),
      userId: 'usr_a',
      amount: credits(100),
      source: 'card',
    }),
  );
  assert.equal(topped.status, 'committed');
  if (topped.status !== 'committed') {
    return;
  }
  await worker.sweep({ now: clock.now(), limit: 10 });

  const tamper = (
    ports.store.ledger as unknown as {
      __tamper?: (
        txnId: string,
        mutate: (
          legs: Array<{ account: string; amount: { minor: bigint } }>,
        ) => void,
      ) => void;
    }
  ).__tamper;
  assert.notEqual(tamper, undefined);
  // Which leg was edited is recorded here, at the edit, so the escalation's break below is held
  // against the tamper rather than against anything the prover reported.
  let editedAccount = '';
  tamper?.(topped.transaction.id, (legs) => {
    editedAccount = legs[0].account;
    legs[0].amount.minor += 1n;
  });
  assert.notEqual(editedAccount, '');
  await worker.sweep({ now: clock.now(), limit: 10 });

  // Each wiring gets its own supervisor, so each meets the same episode for the first time and
  // escalates once.
  const escalationOf = async (
    prove?: () => Promise<ProveReport>,
  ): Promise<Record<string, unknown>> => {
    const supervisor = createSupervisor({
      clock,
      signals: runtime.signals,
      sagas: frozenSagaSource([]),
      runSweep: async () => {
        throw new Error('integrity findings must never trigger the sweep');
      },
      audit: () => {},
      ...(prove === undefined ? {} : { prove }),
    });
    const records = await supervisor.tick();
    assert.deepEqual(
      records.map((record) => record.phase),
      ['detected', 'escalated'],
    );
    return records[1]!.detail;
  };

  const full = await escalationOf(() => proveEconomy(ports));
  const light = await escalationOf(() => economy.read.health());
  const threw = await escalationOf(async () => {
    throw new Error('prover down');
  });
  const absent = await escalationOf();

  const flagsOf = (proof: unknown): Record<string, unknown> => {
    const report = proof as Record<string, unknown>;
    return {
      conserved: report.conserved,
      backed: report.backed,
      noOverdraft: report.noOverdraft,
      chainIntact: report.chainIntact,
      consistent: report.consistent,
    };
  };
  // Two escalation records over the one tampered ledger. The four flags both provers derive the
  // same way agree; `chainIntact` does not, because the full prover replays every link and the
  // light one checks the head's shape. So `chainIntact` in an audit trail carries whichever
  // answer the host happened to wire, and the record has to say which.
  assert.deepEqual(flagsOf(light.proof), {
    conserved: false,
    backed: true,
    noOverdraft: true,
    chainIntact: true,
    consistent: false,
  });
  assert.deepEqual(flagsOf(full.proof), {
    conserved: false,
    backed: true,
    noOverdraft: true,
    chainIntact: false,
    consistent: false,
  });

  assert.deepEqual(
    [full.prover, light.prover, threw.prover, absent.prover],
    ['proveEconomy', 'read.health', null, null],
    'four wirings of the prove port examined',
  );

  // The record a human reads after the containment latch has already pulled. It carried the
  // verdict and no location until this landing; the replay knew the link the whole time.
  const brokenOf = (proof: unknown): ChainBreak | null =>
    (proof as { firstBreak: ChainBreak | null }).firstBreak;
  const named = brokenOf(full.proof);
  if (named === null) {
    assert.fail('the escalation reported a broken chain and named no link');
  }
  assert.deepEqual(
    { account: named.account, txnId: named.txnId, reason: named.reason },
    {
      account: editedAccount,
      txnId: topped.transaction.id,
      reason: 'tampered-hash',
    },
    'the escalation named a link and it is not the leg that was edited',
  );
  // The light wiring reports the same episode with `chainIntact: true` above, and it has no link
  // to name in either direction — the two records differ in what they can say, not only in what
  // they say.
  assert.equal(brokenOf(light.proof), null);
  assert.equal(absent.proof, null);
  assert.match(
    String((threw.proof as { proverFailed: string }).proverFailed),
    /prover down/,
  );
});

test('integrity: rounds of ordinary traffic raise nothing, and one edit to sealed history raises one episode', async () => {
  const clock = fixedClock(1_000_000);
  const runtime = createSupervisorRuntime({
    meter: silentMeter(),
    logger: silentLogger(),
    clock,
  });
  const ports = await openPorts(
    {},
    {
      processor: { submitPayout: async () => ({ providerRef: 'p' }) },
      clock,
      logger: runtime.logger,
      meter: runtime.meter,
    },
  );
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);

  // Counts the auditor's own heartbeat, so "no findings" cannot be read off a verify that never
  // ran. The first cycle has no checkpoint to check and is expected to skip.
  const verifies = (outcome: string): number =>
    runtime.signals
      .since(0)
      .filter(
        (signal) =>
          signal.source === 'meter' &&
          signal.name === 'worker.checkpoint.verify' &&
          signal.tags.outcome === outcome,
      ).length;

  const ROUNDS = 4;
  let first = '';
  for (let round = 1; round <= ROUNDS; round += 1) {
    const topped = await economy.submit(
      topUp({
        idempotencyKey: `idem_topup_${round}`,
        actor: systemActor('billing'),
        userId: 'usr_a',
        amount: credits(100),
        source: 'card',
      }),
    );
    assert.equal(topped.status, 'committed');
    if (topped.status !== 'committed') {
      return;
    }
    if (round === 1) {
      first = topped.transaction.id;
    }
    await worker.sweep({ now: clock.now(), limit: 10 });
    assert.deepEqual(
      detectIntegrityMismatches(runtime.signals, 0),
      [],
      `round ${round}: ordinary traffic raised an integrity finding`,
    );
  }
  assert.equal(verifies('ok'), ROUNDS - 1);
  assert.equal(verifies('unverified'), 0);

  const tamper = (
    ports.store.ledger as unknown as {
      __tamper?: (
        txnId: string,
        mutate: (legs: Array<{ amount: { minor: bigint } }>) => void,
      ) => void;
    }
  ).__tamper;
  assert.notEqual(tamper, undefined);
  // The very first round's posting, three seals deep in sealed history.
  tamper?.(first, (legs) => {
    legs[0].amount.minor += 1n;
  });
  await worker.sweep({ now: clock.now(), limit: 10 });

  // One episode, carried on the two channels the detector matches — not one finding.
  const found = detectIntegrityMismatches(runtime.signals, 0);
  assert.equal(found.length, 2);
  assert.deepEqual(
    [...new Set(found.map((finding) => finding.channel))].sort(),
    ['log', 'meter'],
  );
  assert.equal(verifies('ok'), ROUNDS - 1);
});

// The pager is a host hook and a host hook can be down. Before this was gated, a throw out of it
// aborted the tick between the escalation and the containment it exists to announce, so the one
// lever the integrity pass has never pulled and every later tick re-detected and re-threw.
test('integrity: a pager hook that throws still leaves the worker paused, the latch set and the episode handled once', async () => {
  const clock = fixedClock(1_000_000);
  const { records, sink } = recorder();
  let paused = 0;
  let sweeps = 0;
  const supervisor = createSupervisor({
    clock,
    signals: feedOf([
      meterSignal(clock.now() - 1_000, 'worker.checkpoint.verify', 1, {
        outcome: 'mismatch',
      }),
    ]),
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      sweeps += 1;
    },
    pauseWorker: () => {
      paused += 1;
    },
    prove: async () => proveReport({ chainIntact: false }),
    escalate: () => {
      throw new Error('pagerduty 503');
    },
    audit: sink,
  });

  const first = await supervisor.tick();
  assert.deepEqual(
    first.map((record) => `${record.signature}:${record.phase}`),
    [
      'integrity-mismatch:detected',
      'integrity-mismatch:escalated',
      'integrity-mismatch:acted',
      'integrity-mismatch:acted',
    ],
    'the trail has to carry the pause and the page that did not go out',
  );
  assert.equal(paused, 1, 'the containment lever never pulled');
  assert.deepEqual(first[2].detail, {
    action: 'page',
    failure: 'Error: pagerduty 503',
  });
  assert.deepEqual(first[3].detail, { action: 'pause' });

  // The watermark advanced, so the same episode is not re-escalated on every later tick.
  assert.deepEqual(await supervisor.tick(), []);
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(records.length, 4);
  assert.equal(sweeps, 0);
});
