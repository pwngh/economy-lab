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
 * The archival mover (src/worker/archive.ts): verify-copy-delete over a sealed prefix, with the
 * boundary signed at every step. Every posting lands in the sink before it leaves hot storage.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  archiveSealedPrefix,
  verifyArchiveHeads,
} from '#src/worker/archive.ts';
import { proveEconomy } from '#src/integrity.ts';
import { sealCheckpoint } from '#src/worker/checkpoint.ts';
import { fixedRates } from '#test/support/capabilities.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import {
  fixedClock,
  hasCode,
  makeWorkerCtx,
  seededDigest,
} from '#test/support/capabilities.ts';

import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { ArchivedPosting, ArchiveSink, Store } from '#src/ports.ts';

function harness() {
  const digest = seededDigest(1);
  const store = memoryStore({ digest, clock: fixedClock(0) });
  const ctx = makeWorkerCtx();
  return { store, ctx };
}

async function post(
  store: Store,
  userId: string,
  txnId: string,
  minor: bigint,
) {
  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId,
      legs: [
        credit(spendable(userId), toAmount('CREDIT', minor)),
        debit(SYSTEM.REVENUE, toAmount('CREDIT', minor)),
      ],
      meta: { source: 'card' },
    }),
  );
}

function memorySink(): ArchiveSink & { pages: ArchivedPosting[][] } {
  const pages: ArchivedPosting[][] = [];
  const seen = new Set<string>();
  return {
    pages,
    put: async (page) => {
      // Idempotent per txn id, as the port requires: a re-sent page replaces nothing.
      const fresh = page.filter((posting) => !seen.has(posting.txnId));
      for (const posting of fresh) {
        seen.add(posting.txnId);
      }
      if (fresh.length > 0) {
        pages.push([...fresh]);
      }
    },
  };
}

describe('Archival mover', () => {
  test('moves the sealed prefix to the sink, prunes it, and signs the boundary', async () => {
    const { store, ctx } = harness();
    for (let i = 0; i < 5; i += 1) {
      await post(store, `usr_ar${i}`, `txn_ar_${i}`, 100n);
    }
    const sealed = await sealCheckpoint(store, ctx);
    assert.notEqual(sealed.sealed, null);

    const sink = memorySink();
    const summary = await archiveSealedPrefix(store, ctx, {
      sink,
      checkpointOlderThanMs: 1_000,
      limit: 2,
      now: 10_000,
    });
    assert.equal(summary.moved, 5);
    assert.equal(summary.finished, true);

    // Everything landed in the sink, in commit order, before it left hot storage.
    const archived = sink.pages.flat();
    assert.deepEqual(
      archived.map((posting) => posting.txnId),
      [0, 1, 2, 3, 4].map((i) => `txn_ar_${i}`),
    );
    assert.equal(await store.ledger.posting('txn_ar_0'), null);
    // Balances are money state, not history: pruning never touches them.
    assert.equal(
      (await store.ledger.balance(spendable('usr_ar0'))).minor,
      100n,
    );

    // The boundary is signed and verifies: the anchor an attacker cannot move.
    const state = await store.checkpoints.archiveState!();
    assert.notEqual(state, null);
    assert.equal(state!.throughSeq, summary.throughSeq);
    const heads = await store.checkpoints.archiveHeads!();
    assert.equal(await verifyArchiveHeads(ctx, heads, state!), true);
    const bent = heads.map((row, i) =>
      i === 0 ? { ...row, sum: row.sum + 1n } : row,
    );
    assert.equal(await verifyArchiveHeads(ctx, bent, state!), false);

    // The deep audit holds over the pruned ledger: consistency folds from the signed archived
    // sums, conservation from the remainder, and the chain walks anchor at the signed heads.
    const report = await proveEconomy({
      store,
      rates: fixedRates(),
      digest: ctx.digest,
      signer: ctx.signer,
    });
    assert.equal(report.conserved, true);
    assert.equal(report.consistent, true);
    assert.equal(report.chainIntact, true);
    assert.equal(report.noOverdraft, true);

    // A fresh seal still nets to zero: the sealed leaves fold the archived sums back in.
    const resealed = await sealCheckpoint(store, ctx);
    assert.notEqual(resealed.sealed, null);
    assert.equal(resealed.deadLettered.length, 0);
  });

  test('waits for a checkpoint older than the age bound, as a stated fact', async () => {
    const { store, ctx } = harness();
    await post(store, 'usr_ar_young', 'txn_ar_young', 100n);
    await sealCheckpoint(store, ctx);

    const sink = memorySink();
    const summary = await archiveSealedPrefix(store, ctx, {
      sink,
      checkpointOlderThanMs: 60_000,
      limit: 10,
      now: 5_000,
    });
    assert.equal(summary.moved, 0);
    assert.match(
      summary.reason!,
      /archival waits for one older than the checkpointOlderThanMs bound/,
    );
    assert.notEqual(await store.ledger.posting('txn_ar_young'), null);
  });

  test('a crashed run resumes from its signed cursor without loss or double-count', async () => {
    const { store, ctx } = harness();
    for (let i = 0; i < 6; i += 1) {
      await post(store, `usr_rs${i}`, `txn_rs_${i}`, 100n);
    }
    await sealCheckpoint(store, ctx);

    // The sink dies on its second page; the first page is already pruned under a signed state.
    const kept = memorySink();
    let puts = 0;
    const flaky: ArchiveSink = {
      put: async (page) => {
        puts += 1;
        if (puts === 2) {
          throw new Error('sink unreachable');
        }
        await kept.put(page);
      },
    };
    await assert.rejects(
      archiveSealedPrefix(store, ctx, {
        sink: flaky,
        checkpointOlderThanMs: 1_000,
        limit: 2,
        now: 10_000,
      }),
      /sink unreachable/,
    );
    assert.equal(await store.ledger.posting('txn_rs_0'), null);
    assert.notEqual(await store.ledger.posting('txn_rs_2'), null);

    // The crash window: pages pruned under the signed boundary, pages not yet — the deep audit
    // must hold mid-crash, not only after the resume completes.
    const midCrash = await proveEconomy({
      store,
      rates: fixedRates(),
      digest: ctx.digest,
      signer: ctx.signer,
    });
    assert.equal(midCrash.conserved, true);
    assert.equal(midCrash.consistent, true);
    assert.equal(midCrash.chainIntact, true);

    const resumed = await archiveSealedPrefix(store, ctx, {
      sink: kept,
      checkpointOlderThanMs: 1_000,
      limit: 2,
      now: 11_000,
    });
    assert.equal(resumed.finished, true);
    assert.equal(2 + resumed.moved, 6);
    assert.deepEqual(
      kept.pages
        .flat()
        .map((posting) => posting.txnId)
        .sort(),
      [0, 1, 2, 3, 4, 5].map((i) => `txn_rs_${i}`).sort(),
    );
    const state = await store.checkpoints.archiveState!();
    assert.equal(
      await verifyArchiveHeads(
        ctx,
        await store.checkpoints.archiveHeads!(),
        state!,
      ),
      true,
    );
  });

  test('refuses edited history before anything is copied or deleted', async () => {
    const { store, ctx } = harness();
    await post(store, 'usr_tm', 'txn_tm_0', 100n);
    await post(store, 'usr_tm', 'txn_tm_1', 50n);
    await sealCheckpoint(store, ctx);
    (store.ledger as MemoryLedger).__tamper('txn_tm_0', (legs) => {
      legs[0] = { ...legs[0]!, amount: toAmount('CREDIT', 999n) };
    });

    const sink = memorySink();
    await assert.rejects(
      archiveSealedPrefix(store, ctx, {
        sink,
        checkpointOlderThanMs: 1_000,
        limit: 10,
        now: 10_000,
      }),
      hasCode('CHAIN.BROKEN'),
    );
    assert.equal(sink.pages.length, 0);
    assert.notEqual(await store.ledger.posting('txn_tm_0'), null);
  });
});
