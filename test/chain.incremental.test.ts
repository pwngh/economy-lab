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

// The incremental seal re-proves only the accounts whose heads moved since the last signed
// seal. Its root must match a full replay's, a tampered tail must still fail to seal, and a
// doubtful snapshot must fall back to the full replay rather than a weaker seal.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  merkleSumRoot,
  proveChain,
  recordCheckpoint,
  verifyCheckpoint,
} from '#src/chain.ts';
import { postEntry } from '#src/ledger.ts';
import { EconomyError } from '#src/errors.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { toHex } from '#src/bytes.ts';
import { spendable } from '#src/accounts.ts';
import { reproveStoredChains } from '#src/worker/reproof.ts';
import { balancedPosting } from '#test/support/sweeps.ts';
import {
  makeWorkerCtx,
  seededDigest,
  seededSigner,
  sequentialIds,
  fixedClock,
} from '#test/support/capabilities.ts';

import type { MemoryLedger } from '#src/adapters/memory.ts';
import type {
  Checkpoint,
  Digest,
  Leg,
  SealHead,
  Signer,
  Store,
} from '#src/ports.ts';

type Fixture = {
  store: Store;
  digest: Digest;
  signer: Signer;
  seal(): Promise<Checkpoint>;
  post(txnId: string, userId: string): Promise<void>;
  liveRootHex(): Promise<string>;
  sealHeads(): Promise<ReadonlyArray<SealHead>>;
};

function setup(): Fixture {
  const digest = seededDigest(1);
  const signer = seededSigner(1);
  const store = memoryStore({ digest });
  const ids = sequentialIds();
  return {
    store,
    digest,
    signer,
    seal: () =>
      recordCheckpoint({
        ledger: store.ledger,
        checkpoints: store.checkpoints,
        digest,
        signer,
        clock: fixedClock(0),
        ids,
      }),
    post: async (txnId, userId) => {
      await store.transaction((unit) =>
        postEntry(unit.ledger, balancedPosting(txnId, userId)),
      );
    },
    liveRootHex: async () => {
      const leaves: SealHead[] = [];
      for await (const leaf of store.ledger.headSums()) {
        leaves.push(leaf);
      }
      return toHex((await merkleSumRoot(digest, leaves)).hash);
    },
    sealHeads: () => store.checkpoints.sealHeads!(),
  };
}

describe('incremental checkpoints', () => {
  test('the second seal proves only the dirty tail yet seals the exact full-replay root', async () => {
    const fx = setup();
    await fx.post('txn_1', 'usr_a');
    const first = await fx.seal();
    // The full first seal snapshotted every leaf: usr_a's spendable and REVENUE.
    assert.equal((await fx.sealHeads()).length, 2);

    await fx.post('txn_2', 'usr_b');
    const second = await fx.seal();

    assert.notEqual(second.root, first.root);
    assert.equal(second.root, await fx.liveRootHex());
    assert.equal(second.sum, '0');
    assert.equal(
      await verifyCheckpoint(
        { ledger: fx.store.ledger, digest: fx.digest, signer: fx.signer },
        second,
      ),
      true,
    );
    // The snapshot now mirrors the second seal's leaves, so the third seal diffs against it.
    const heads = new Map(
      (await fx.sealHeads()).map(([account, head]) => [account, head]),
    );
    for await (const [account, head] of fx.store.ledger.headSums()) {
      assert.equal(heads.get(account), head);
    }
  });

  test('a tampered dirty tail still refuses to seal', async () => {
    const fx = setup();
    await fx.post('txn_1', 'usr_a');
    await fx.seal();

    await fx.post('txn_2', 'usr_a');
    // __tamper is a MemoryLedger-only escape hatch: it edits stored legs in place without
    // touching the chain, which no SQL adapter can do.
    (fx.store.ledger as MemoryLedger).__tamper('txn_2', (legs: Leg[]) => {
      legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 999n) };
    });

    await assert.rejects(
      () => fx.seal(),
      (error: unknown) =>
        error instanceof EconomyError && error.code === 'CHAIN.BROKEN',
    );
  });

  test('a corrupted snapshot falls back to the full replay and heals itself', async () => {
    const fx = setup();
    await fx.post('txn_1', 'usr_a');
    await fx.seal();

    // An attacker (or a crash) rewrites one snapshot row and plants a stray one: the root no
    // longer matches the signed checkpoint, so nothing in it is trusted and the seal replays
    // from genesis instead.
    await fx.store.checkpoints.putSealHeads!([
      [spendable('usr_a'), 'f'.repeat(64), 0n],
      [spendable('usr_ghost'), 'e'.repeat(64), 0n],
    ]);
    await fx.post('txn_2', 'usr_b');
    const sealed = await fx.seal();

    assert.equal(sealed.root, await fx.liveRootHex());
    // The full path replaced the snapshot outright: the edited row is corrected and the stray
    // row is purged, so the next seal can take the fast path again.
    const heads = new Map(
      (await fx.sealHeads()).map(([account, head]) => [account, head]),
    );
    assert.equal(heads.has(spendable('usr_ghost')), false);
    let live = 0;
    for await (const [account, head] of fx.store.ledger.headSums()) {
      live += 1;
      assert.equal(heads.get(account), head);
    }
    assert.equal(heads.size, live);
  });

  test("a sum-preserving edit behind an unchanged head is the full prover's to catch", async () => {
    const fx = setup();
    // Two postings for usr_c, so a later +100/-100 edit pair can cancel inside one account.
    await fx.post('txn_c1', 'usr_c');
    await fx.post('txn_c2', 'usr_c');
    await fx.seal();

    // usr_c's head and sum both survive the paired edit, so the incremental seal cannot see it:
    // clean-by-head, vouched for by the previous signature. The seal proves the delta; `make
    // prove` audits history.
    const ledger = fx.store.ledger as MemoryLedger;
    ledger.__tamper('txn_c1', (legs: Leg[]) => {
      legs[0] = {
        account: legs[0]!.account,
        amount: toAmount('CREDIT', legs[0]!.amount.minor + 100n),
      };
    });
    ledger.__tamper('txn_c2', (legs: Leg[]) => {
      legs[0] = {
        account: legs[0]!.account,
        amount: toAmount('CREDIT', legs[0]!.amount.minor - 100n),
      };
    });

    await fx.post('txn_2', 'usr_b');
    const sealed = await fx.seal();
    assert.equal(sealed.v, 2);

    const audit = await proveChain({
      ledger: fx.store.ledger,
      digest: fx.digest,
    });
    assert.equal(audit.intact, false);
    assert.equal(audit.firstBreak!.account, spendable('usr_c'));

    // The rolling re-proof sweep catches the same edit on its next rotation, without anyone
    // running the prover by hand.
    await assert.rejects(
      () =>
        reproveStoredChains(
          fx.store,
          makeWorkerCtx({ digest: fx.digest, clock: fixedClock(0) }),
          { now: 0, limit: 1_000 },
        ),
      (error: unknown) => (error as { code?: string }).code === 'CHAIN.BROKEN',
    );
  });
});
