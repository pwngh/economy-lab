/// <reference types="node" />
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
 * Proves the effect-level exactly-once guarantee the workers actually rely on, under the same claim
 * pattern the production workers use. The three background sweeps each claim a batch of due or pending
 * rows and then act on each one:
 *   - advanceDuePayouts (src/worker/payouts.ts): claimDue, then advance(...), a compare-and-set.
 *   - relayOutbox      (src/worker/relay.ts):   claimBatch, deliver, then markRelayed.
 *   - drainInbox       (src/worker/inbox.ts):   claimInbound, submit the stored Operation, then markApplied.
 * On the SQL engines every claim is `SELECT ... FOR UPDATE SKIP LOCKED`.
 *
 * Why the claim is not the guarantee. The production workers do not claim and mark inside one
 * transaction. They claim on the pool, in autocommit, so the FOR UPDATE SKIP LOCKED lock is released
 * the instant the SELECT returns, before the row is marked. The workers confirm this: relay.ts claims
 * on the pool and calls `markRelayed` separately ("delivery can happen more than once ... the receiver
 * must drop duplicates"); inbox.ts claims on the pool, where "exactly-once rests on the stored
 * Operation's idempotencyKey"; payouts.ts claims on the pool, and the real state change is the
 * `advance` CAS inside `store.transaction`. So SKIP LOCKED only de-duplicates two claims while they
 * overlap in time. It reduces contention, but it is not the exactly-once mechanism. Under the real
 * autocommit-claim pattern two sweeps can transiently claim the same row: one claims, its lock drops on
 * autocommit before it has marked the row, and a second sweep claims the still-pending row. A test that
 * claimed and marked in one transaction (as an earlier version did) would hold the lock across the
 * claim and the mark, proving a guarantee the workers never make. This suite instead exercises the real
 * pattern and asserts on the real guarantee.
 *
 * What the real guarantee is: the exactly-once effect, the transactional-outbox and
 * at-least-once-delivery model. A transient double-claim is absorbed by three idempotent mechanisms,
 * one per method. Each test asserts on the effect (the terminal transition or the ledger effect),
 * never on claim-disjointness:
 *   - sagas: the advance CAS. `advance(id, from, to, ...)` moves the saga only if it is still in
 *     `from`, returning false otherwise (ports.ts: "two sweeps can't both advance it"). So each due
 *     saga advances exactly once across all sweeps: exactly one sweep's advance() returns true, and
 *     every other returns false. A loser getting false is correct. A saga whose advance returns true
 *     twice is a double-submit, a real bug.
 *   - outbox: at-least-once delivery with an idempotent mark. The receiver may see a row twice from a
 *     transient double-claim, and that is the contract, so there is no exactly-once-claim property to
 *     assert. `markRelayed` (UPDATE ... SET status = 'relayed' WHERE id = ANY) is idempotent, so a
 *     re-claim just re-delivers and re-marks harmlessly. What contention must still hold is no loss and
 *     no stranding: every row is delivered at least once, and every row ends terminal 'relayed'. The
 *     exactly-once effect is downstream, at the receiver. That is the inbox case, not this one.
 *   - inbox: the stored Operation's idempotencyKey. Each row submits a topUp through the real economy
 *     under the row's idempotencyKey. `submit` claims that key atomically, so a transient re-submit
 *     resolves to a `duplicate` Outcome with no second posting. So each operation's ledger effect
 *     happens exactly once: the user's spendable balance ends at exactly one top-up's worth, never two.
 *     A row whose topUp posts twice (balance doubled) is a double-apply, a real bug.
 *
 * The harness. Seed M (~80) due or pending rows on a fresh isolated store. Run N (~6) sweeps
 * concurrently behind a shared barrier, so they hit the locks at once and the SKIP LOCKED path is
 * genuinely exercised. Each sweep loops its production claim-then-mark unit until the set drains. Then
 * assert the per-method effect above. M is well above N×LIMIT so the drain takes many overlapping
 * rounds (real contention, not one batch each). ITERATIONS is at least 20 so a rare double-effect
 * interleaving has many chances to surface.
 *
 * Transient losers versus double-effects. Under genuine parallelism the engine may abort a sweep's
 * mark transaction with a deadlock or serialization conflict (Postgres 40P01/40001, InnoDB
 * ER_LOCK_DEADLOCK or lock-wait timeout). That is a principled loser, exactly as settle-vs-reverse
 * documents: the engine's own `transaction` wrapper retries it (withTransientRetry), and the drain
 * loop re-runs any round that still came up short, so nothing is dropped. A transient abort committed
 * nothing, so it is not a double-effect. A genuine fault is the real bug: a saga advanced twice, an
 * operation applied twice, or an outbox row lost or left stranded. The failing assertion names the
 * method, the offending id, and the engine, and the test fails. It is never weakened to pass.
 *
 * Backends. Postgres and MySQL run when reachable and are skipped (never failed) when not, the same
 * connect-or-skip contract the other conformance suites use. The SKIP LOCKED row locking and the
 * concurrent-submit dedup are the whole point, so the real proof is SQL. memory is a single writer
 * (overlapping transactions queue FIFO rather than interleave), so it has no genuine contention. A
 * trivial single-sweep reference pass over the same harness pins that the claim-then-mark effect
 * logic drains the seeded set exactly once on the reference adapter.
 */

import { describe, test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from '#src/adapters/memory.ts';
import { createEconomy } from '#src/economy.ts';
import { toAmount } from '#src/money.ts';
import { spendable } from '#src/accounts.ts';
import {
  fixedClock,
  seededDigest,
  seededSigner,
  sequentialIds,
  fixedRates,
  testLogger,
  silentMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
  testSecrets,
} from '#test/support/capabilities.ts';
import {
  adversarialPostgres,
  adversarialMysql,
} from '#test/conformance/adversarial-engines.ts';

import type { AdversarialEngine } from '#test/conformance/adversarial-engines.ts';
import type { Economy, Operation } from '#src/contract.ts';
import type { InboxMessage, OutboxMessage, Saga, Store } from '#src/ports.ts';

// M seeded rows, N concurrent sweeps, per-claim batch limit, and how many independent drains to run
// per claim method. M is far larger than N*LIMIT so the drain takes many overlapping rounds and the
// contention is real; ITERATIONS of at least 20 gives a rare double-effect interleaving many chances
// to surface; N stays modest so the in-flight sweeps keep their transaction connections inside the
// pool, the same pool-sizing discipline concurrency.adversarial documents.
const M = 80;
const N = 6;
const LIMIT = 4;
const ITERATIONS = 20;

// `now` for the due-time gate. Sagas are seeded due in the past so claimDue picks them, and a
// constant keeps the seeded set deterministic.
const NOW = 1;

const TOPUP_MINOR = 1_000n;

// One unique tag per drain so seeded ids never collide across iterations on a shared store. A base-36
// counter is plenty. The store is fresh per engine anyway, but distinct ids keep a failure message
// unambiguous about which row produced the double-effect. The tag is kept short and free of the
// verbose method name. A seeded row id is `<tag>_row<k>`, and every id and user_id column is
// VARCHAR(64) on MySQL, so embedding the long human-readable method name would overflow the column
// (a too-long id is silently dropped by INSERT IGNORE and the row vanishes). `code` is a short
// per-method stamp so a failure message still says which method.
let tagSeq = 0;
function freshTag(code: string): string {
  tagSeq += 1;
  return `${code}_${tagSeq.toString(36)}`;
}

// --- Seeding -----------------------------------------------------------------------------------

// Builds one due payout saga in SUBMITTED, a state claimDue returns (see the engine's `state in
// ('RESERVED','SUBMITTED')` gate). dueAt is in the past so the saga is due at NOW. The exactly-once
// effect is the advance CAS from SUBMITTED to SETTLED, which exactly one sweep wins.
function sagaRow(id: string): Saga {
  return {
    id,
    userId: `usr_claim_${id}`,
    reserve: toAmount('CREDIT', 100n),
    rateId: 'payout:CREDIT->USD:5/3',
    state: 'SUBMITTED',
    providerRef: 'prov_claim',
    reason: null,
    attempts: 1,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
  };
}

// Builds one pending outbox row to seed the contention set.
function outboxRow(id: string): OutboxMessage {
  return {
    id,
    event: {
      id: `evt_${id}`,
      type: 'economy.credits.topped_up',
      version: 1,
      occurredAt: 0,
      subject: `usr_claim_${id}`,
      data: {},
      audience: 'internal',
    },
    status: 'pending',
    attempts: 0,
    reason: null,
    correlationId: null,
  };
}

// Builds one pending inbox row carrying a topUp for this row's own user. `key` (the operation's
// idempotencyKey) is the dedupe key the exactly-once effect rests on. Each row gets a distinct key so
// each row's ledger effect is independently checkable and enqueue never dedupes two seeds. The
// `system` actor and `card` source mirror a real settlement webhook's stored Operation, which the
// pause gate exempts so drainInbox runs continuously.
function inboxRow(id: string): InboxMessage {
  const userId = `usr_claim_${id}`;
  return {
    id,
    key: `key_${id}`,
    operation: {
      kind: 'topUp',
      idempotencyKey: `key_${id}`,
      actor: { kind: 'system', service: 'webhook:billing' },
      userId,
      amount: toAmount('CREDIT', TOPUP_MINOR),
      source: 'card',
    } as Operation,
    status: 'pending',
    attempts: 0,
    receivedAt: 0,
    reason: null,
  };
}

// --- Per-method effect harness -----------------------------------------------------------------

// One claim method, abstracted so the same drain loop drives saga, outbox, and inbox. `seed` writes
// the M rows. `sweepOnce` is one production claim-then-mark unit: it claims a batch on the pool (in
// autocommit, so the SKIP LOCKED lock is released immediately, the real pattern), then acts on each
// claimed id with the same idempotent step the production worker uses (advance CAS, markRelayed, or
// submit plus markApplied) in its own write, not inside the claim's transaction. It returns the ids it
// claimed so the drain loop can tell when its view of the set is empty. `verify` runs after the drain
// and asserts the per-method invariant (saga advanced exactly once, every outbox row delivered and
// none stranded, or ledger effect applied exactly once). It throws, naming method, id, and engine,
// when one is violated.
interface ClaimMethod {
  name: string;
  // A short stamp used to build compact seeded row ids. Every id and user_id column is VARCHAR(64) on
  // MySQL, so the verbose `name` cannot go in an id. Distinct per method.
  code: string;
  // Builds any per-method shared context (for example, the real economy the inbox submits through)
  // bound to this store. Returns the method instance whose closures capture it.
  bind(store: Store, engineName: string): BoundMethod;
}

interface BoundMethod {
  seed(ids: ReadonlyArray<string>): Promise<void>;
  // Returns how many rows this sweep's claim handed back, not how many it managed to mark terminal.
  // The drain loop stops a sweep when a claim returns 0 rows, meaning its view of the pending set is
  // empty. A round that claims rows but marks none (all threw a transient conflict) still counts as
  // work remaining, so the loop keeps going. Returning the marked count instead would let a sweep stop
  // while rows it claimed are still pending.
  sweepOnce(): Promise<number>;
  // Asserts the per-method exactly-once effect over every seeded id. Throws, naming method, id, and
  // engine, on a double-effect.
  verify(ids: ReadonlyArray<string>): Promise<void>;
}

// Sagas: claimDue on the pool, then advance(SUBMITTED -> SETTLED) as a CAS in its own transaction.
// This is the shape of advanceDuePayouts: claimDue on the pool, and the state change is the advance
// CAS. The exactly-once effect is per-saga: exactly one sweep's advance returns true. We tally
// advance(true) per id across all sweeps and assert each due saga was advanced exactly once.
function sagaMethod(): ClaimMethod {
  return {
    name: 'SagaStore.claimDue + advance CAS',
    code: 'saga',
    bind: (store, engineName) => {
      // id -> how many sweeps' advance() returned true for it. Exactly-once means every value is 1.
      const advancedTrue = new Map<string, number>();
      return {
        seed: async (ids) => {
          await store.transaction(async (unit) => {
            for (const id of ids) {
              await unit.sagas.open(sagaRow(id));
            }
          });
        },
        sweepOnce: async () => {
          // Claim on the pool, in autocommit: the FOR UPDATE SKIP LOCKED lock drops the moment the
          // SELECT returns, before any advance runs, exactly as advanceDuePayouts claims.
          const due = await store.sagas.claimDue(NOW, LIMIT);
          for (const saga of due) {
            // The real state change: a CAS from SUBMITTED to SETTLED in its own transaction. Only the
            // sweep that finds the saga still in SUBMITTED wins and returns true. A sweep that
            // transiently re-claimed an already-advanced saga gets false. Tally only the winners.
            const advanced = await store.transaction((unit) =>
              unit.sagas.advance(saga.id, 'SUBMITTED', 'SETTLED', {
                updatedAt: NOW,
              }),
            );
            if (advanced) {
              advancedTrue.set(saga.id, (advancedTrue.get(saga.id) ?? 0) + 1);
            }
          }
          return due.length;
        },
        verify: async (ids) => {
          // Every due saga advanced exactly once. A 2 is a double-submit: two sweeps' advance both
          // returned true for the same saga, so the CAS failed to serialize. A 0 means it never
          // advanced, so a row was dropped.
          for (const id of ids) {
            const wins = advancedTrue.get(id) ?? 0;
            assert.equal(
              wins,
              1,
              `[${engineName}] SagaStore advance CAS: saga ${id} advanced ` +
                `${wins} times (expected exactly 1). ${
                  wins > 1
                    ? 'TWO sweeps advanced the same saga — a double-submit; the CAS failed to ' +
                      'serialize concurrent advances.'
                    : 'No sweep advanced this saga — a due row was dropped.'
                }`,
            );
          }
          // Every saga ends terminal SETTLED.
          for (const id of ids) {
            const saga = await store.sagas.load(id);
            assert.equal(
              saga?.state,
              'SETTLED',
              `[${engineName}] SagaStore: saga ${id} ended in ${String(
                saga?.state,
              )}, expected the terminal SETTLED`,
            );
          }
        },
      };
    },
  };
}

// Outbox: claimBatch on the pool, "deliver" to a test receiver, then markRelayed in its own
// transaction. This is the shape of relayOutbox: claim on the pool, deliver, and mark separately. The
// outbox is at-least-once, so there is no exactly-once-claim property to pin here. Two sweeps can both
// claim the same still-pending row in the gap between the autocommit claim (whose FOR UPDATE SKIP
// LOCKED lock drops the moment the SELECT returns) and either sweep's markRelayed. That transient
// double-claim delivers the row twice, which is the contract: the receiver drops duplicates by id.
// markRelayed is idempotent too (UPDATE ... SET status = 'relayed' WHERE id = ANY re-flips an
// already-relayed row to the same value), so a re-claim does no harm. What contention must still
// guarantee, and what we assert, is the pair that matters: no row is lost (every row delivered at
// least once) and no row is stranded (every row ends 'relayed'). The exactly-once effect belongs to
// the receiver, downstream of the outbox. That is the inbox method below, not this one.
function outboxMethod(): ClaimMethod {
  return {
    name: 'OutboxStore.claimBatch + markRelayed',
    code: 'obx',
    bind: (store, engineName) => {
      // Every delivery the receiver saw, by row id (duplicates allowed and expected).
      const deliveries: string[] = [];
      return {
        seed: async (ids) => {
          await store.transaction(async (unit) => {
            for (const id of ids) {
              await unit.outbox.enqueue(outboxRow(id));
            }
          });
        },
        sweepOnce: async () => {
          // Claim on the pool, in autocommit, as relayOutbox does: the FOR UPDATE SKIP LOCKED lock
          // drops when the SELECT returns, so two sweeps can claim the same still-pending row at once.
          const pending = await store.outbox.claimBatch(LIMIT);
          const claimed = pending.map((m) => m.id);
          for (const m of pending) {
            // Deliver, at-least-once. A duplicate from a transient double-claim is the contract.
            deliveries.push(m.id);
          }
          // markRelayed in its own transaction, a separate call, exactly as relay.ts does.
          await store.transaction((unit) => unit.outbox.markRelayed(claimed));
          return pending.length;
        },
        verify: async (ids) => {
          // At-least-once delivery: every row delivered one or more times. Duplicates are the
          // contract, not asserted away.
          const deliveredSet = new Set(deliveries);
          for (const id of ids) {
            assert.ok(
              deliveredSet.has(id),
              `[${engineName}] OutboxStore: row ${id} was never delivered ` +
                `(at-least-once delivery violated — a pending row was dropped)`,
            );
          }
          // Every row ends terminal 'relayed': nothing left claimable.
          const stillPending = await store.outbox.claimBatch(M);
          assert.equal(
            stillPending.length,
            0,
            `[${engineName}] OutboxStore: ${stillPending.length} rows still 'pending' ` +
              `after the drain (every row must end 'relayed')`,
          );
        },
      };
    },
  };
}

// Inbox: claimInbound on the pool, submit the stored Operation through the real economy, then
// markApplied. This is the shape of drainInbox: claim on the pool, submit, and mark separately.
// Exactly-once rests on the stored Operation's idempotencyKey: a transient re-submit resolves to a
// `duplicate` Outcome with no second posting. The effect we assert is the ledger: each row's user ends
// with exactly one top-up's spendable balance, never two.
function inboxMethod(): ClaimMethod {
  return {
    name: 'InboxStore.claimInbound + submit + markApplied',
    code: 'ibx',
    bind: (store, engineName) => {
      // A real economy over this store (one shared instance, one id generator), so a concurrent
      // re-submit of the same idempotencyKey is deduped by `submit`'s atomic key claim, the
      // production mechanism. It must share the store's seeded digest and fixed clock, or hashes
      // diverge.
      const economy: Economy = createEconomy({
        store,
        clock: fixedClock(0),
        ids: sequentialIds(),
        digest: seededDigest(1),
        signer: seededSigner(1),
        rates: fixedRates(),
        logger: testLogger(),
        meter: silentMeter(),
        processor: fakeProcessor(),
        pricing: defaultPricing(),
        config: testConfig(),
        secrets: testSecrets(),
      });
      return {
        seed: async (ids) => {
          await store.transaction(async (unit) => {
            for (const id of ids) {
              await unit.inbox.enqueueInbound(inboxRow(id));
            }
          });
        },
        sweepOnce: async () => {
          // Claim on the pool, in autocommit: the lock drops the moment the SELECT returns, before any
          // submit or markApplied, exactly as drainInbox claims.
          const pending = await store.inbox.claimInbound({
            now: NOW,
            limit: LIMIT,
          });
          for (const entry of pending) {
            // Submit through the real economy, mirroring drainInbox's applyOne. A first submit posts
            // the topUp and records the idempotencyKey. A transient re-submit (this row was claimed by
            // a prior sweep that had not yet marked it) claims the already-recorded key and returns
            // `duplicate`, with no second posting. On success the row is marked applied (markApplied
            // no-ops on an already-terminal row).
            //
            // A submit can throw under genuine parallelism. For example, two topUps racing on the
            // shared STORED_VALUE account's chain head collide on its unique chain link (SQLSTATE
            // 23505), which the engine's retry treats as non-transient and re-raises. That is a
            // principled loser, not a double-apply: the transaction rolled back, nothing posted, and
            // the key was never recorded. drainInbox's applyOne handles exactly this. It catches the
            // throw and leaves the row 'pending' for the next sweep (at-least-once apply). We mirror
            // that: on a throw we do not markApplied, so the row stays claimable and a later sweep
            // retries it. The idempotencyKey makes the eventual effect exactly-once regardless of how
            // many sweeps attempted it.
            let applied = false;
            try {
              await economy.submit(entry.operation);
              applied = true;
            } catch {
              // Transient conflict: leave the row pending, retried next sweep. Not a double-apply.
            }
            if (applied) {
              await store.inbox.markApplied(entry.id);
            }
          }
          // Report how many rows the claim returned, not how many we marked. A round that claimed
          // rows but applied none (all threw a transient conflict) still means work remains, so the
          // drain loop keeps going until a claim comes back genuinely empty.
          return pending.length;
        },
        verify: async (ids) => {
          // The ledger effect happened exactly once per row: each user's spendable balance equals
          // exactly one top-up. A doubled balance is a double-apply, where the idempotencyKey dedup
          // failed to absorb a transient double-claim.
          for (const id of ids) {
            const userId = `usr_claim_${id}`;
            const balance = await store.ledger.balance(spendable(userId));
            assert.equal(
              balance.minor,
              TOPUP_MINOR,
              `[${engineName}] InboxStore: ${userId} (row ${id}) has spendable ` +
                `${balance.minor} minor, expected exactly one top-up of ${TOPUP_MINOR}. ${
                  balance.minor > TOPUP_MINOR
                    ? 'The topUp posted MORE THAN ONCE — a double-apply; the idempotencyKey dedup ' +
                      'failed to absorb a transient double-claim.'
                    : 'The topUp never posted — a pending row was dropped.'
                }`,
            );
          }
          // Every row ends terminal: nothing left claimable.
          const stillPending = await store.inbox.claimInbound({
            now: NOW,
            limit: M,
          });
          assert.equal(
            stillPending.length,
            0,
            `[${engineName}] InboxStore: ${stillPending.length} rows still 'pending' ` +
              `after the drain (every row must end 'applied')`,
          );
        },
      };
    },
  };
}

// --- The drain --------------------------------------------------------------------------------

// Runs `sweeps` production claim-then-mark sweeps concurrently against a seeded set until it drains,
// then runs the method's effect verification. Each sweep loops `sweepOnce`, stopping when a round
// returns nothing, meaning its view of the set is empty. A shared barrier makes all sweeps start their
// first claim together, maximizing the overlap so the SKIP LOCKED path, and the concurrent-mark race
// the idempotent effect must absorb, is genuinely exercised. The SQL engines pass N. memory passes 1,
// because its store queues overlapping transactions behind one writer, so N>1 there is not a real
// race, just the same serial order with extra bookkeeping. The reference adapter drains with
// one sweep, and the effect checks still hold over that single logical pass. Returns nothing. The
// method's `verify` asserts on failure.
async function drainOnce(input: {
  store: Store;
  method: ClaimMethod;
  expected: ReadonlyArray<string>;
  engineName: string;
  sweeps?: number;
}): Promise<void> {
  const { store, method, expected, engineName } = input;
  const sweeps = input.sweeps ?? N;
  const bound = method.bind(store, engineName);
  await bound.seed(expected);

  // The barrier: every sweep awaits this before its first claim, so all of them hit the locks at once.
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const sweep = async (): Promise<void> => {
    await barrier;
    // Loop until a claim round comes back empty: this sweep sees nothing left to do. Stopping on the
    // claim count, not the marked count, means a sweep that claimed rows but could not mark them this
    // round (all threw a transient conflict) keeps going, because those rows are still pending. Other
    // sweeps may still be draining their own rows, but the method's `verify` checks the effect over
    // every seeded id, so an early-stopping sweep cannot hide an unprocessed row.
    for (;;) {
      const claimedCount = await bound.sweepOnce();
      if (claimedCount === 0) {
        return;
      }
    }
  };

  const runs = Array.from({ length: sweeps }, () => sweep());
  release();
  await Promise.all(runs);

  // The per-method exactly-once-effect assertions (advance-won-once, terminal-flip-once, or
  // ledger-effect-once). A genuine double-effect throws here, naming method, id, and engine.
  await bound.verify(expected);
}

// --- SQL registration -------------------------------------------------------------------------

// For each SQL engine: provision a fresh isolated store per drain (so every iteration starts from an
// empty seeded set with no carry-over), run the N-sweep drain, and tear it down. Skip, never fail,
// when the engine is unreachable. All three claim methods are covered, each asserting its own
// exactly-once effect under the production autocommit-claim-then-mark pattern.
function runClaimContention(
  name: string,
  provision: () => Promise<AdversarialEngine | null>,
): void {
  describe(`Claim contention: ${name}`, () => {
    // Probe reachability once so the whole describe can skip cleanly when the engine is down.
    let reachable: boolean | null = null;
    let probe: AdversarialEngine | null = null;

    before(async () => {
      probe = await provision();
      reachable = probe !== null;
    });
    after(async () => {
      if (probe) {
        await probe.close();
      }
    });

    for (const method of [sagaMethod(), outboxMethod(), inboxMethod()]) {
      test(`${method.name}: ${N} concurrent sweeps, ${M} rows, exactly-once-EFFECT over ${ITERATIONS} drains`, async (t: TestContext) => {
        if (!reachable) {
          return t.skip(`${name} unreachable`);
        }
        for (let i = 0; i < ITERATIONS; i += 1) {
          // A fresh isolated namespace per drain: a clean seeded set with no rows left from a prior
          // iteration, so the effect assertions see exactly the M ids this drain seeded.
          const engine = await provision();
          if (!engine) {
            return t.skip(`${name} became unreachable mid-run`);
          }
          try {
            // Compact tag (engine, short method code, and iteration). The verbose method name cannot
            // go in an id, which is VARCHAR(64) on MySQL. The base-36 counter keeps it globally unique.
            const tag = freshTag(`${name}_${method.code}_i${i}`);
            const ids = Array.from(
              { length: M },
              (_unused, k) => `${tag}_row${k}`,
            );
            await drainOnce({
              store: engine.store,
              method,
              expected: ids,
              engineName: name,
            });
          } finally {
            await engine.close();
          }
        }
      });
    }
  });
}

runClaimContention('postgres', () => adversarialPostgres(process.env));
runClaimContention('mysql', () => adversarialMysql(process.env));

// --- memory: single-threaded reference (no genuine contention) ---------------------------------

// memory queues overlapping transactions behind one writer, so there is no real race to run here.
// The same claim-then-mark effect harness must still drain the seeded set exactly once. This pins
// that the effect logic itself (claim a batch, run the idempotent step, repeat until empty) is
// correct on the reference adapter. It uses a single sweep (sweeps=1) because N sweeps would just
// take turns on the one writer; with no genuine parallelism a second sweep adds nothing. This is a
// trivial pass. The real exactly-once-effect-under-parallelism proof is the SQL suites above.
describe('Claim contention: memory (single-threaded reference)', () => {
  for (const method of [sagaMethod(), outboxMethod(), inboxMethod()]) {
    test(`${method.name}: drains the seeded set with the effect happening exactly once`, async () => {
      const store = memoryStore({
        digest: seededDigest(1),
        clock: fixedClock(0),
      });
      try {
        const tag = freshTag(`memory_${method.code}`);
        const ids = Array.from({ length: M }, (_unused, k) => `${tag}_row${k}`);
        await drainOnce({
          store,
          method,
          expected: ids,
          engineName: 'memory',
          sweeps: 1,
        });
      } finally {
        await store.close();
      }
    });
  }
});
