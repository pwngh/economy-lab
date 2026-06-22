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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceHeads,
  proveChain,
  merkleRoot,
  recordCheckpoint,
  verifyCheckpoint,
} from '#src/chain.ts';
import { chainHash, credit, debit, postEntry } from '#src/ledger.ts';
import { EconomyError } from '#src/errors.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { systemSigner } from '#src/runtime.ts';
import { toAmount } from '#src/money.ts';
import { toHex } from '#src/bytes.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import {
  seededDigest,
  seededSigner,
  sequentialIds,
  fixedClock,
} from '#test/support/capabilities.ts';

import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { AccountRef } from '#src/accounts.ts';
import type {
  CheckpointStore,
  Digest,
  Leg,
  Posting,
  Store,
} from '#src/ports.ts';

// The "previous hash" reported for an account's very first posting, when nothing came
// before it: 64 zero characters (32 zero bytes written out in lowercase hexadecimal).
let GENESIS_HEX = '0'.repeat(64);

// Build one balanced double-entry posting: add 500 to the user's spendable balance and
// take the same amount from the platform's REVENUE account, so the two sides cancel. The
// two different accounts (the user's and REVENUE) are what let advanceHeads produce two
// separate chain links to assert on.
function balancedPosting(txnId: string, user: string): Posting {
  let amount = toAmount('CREDIT', 500n);
  return {
    txnId,
    legs: [credit(spendable(user), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { kind: 'test', source: 'card' },
  };
}

// A stand-in for the place checkpoints are saved (the CheckpointStore). It records nothing
// real — it just counts how many times `put` was called, via `rows()`, so a test can check
// that recordCheckpoint actually saved one. The production store lives in the database
// adapter and is saved outside the money-posting transaction on purpose.
function captureCheckpoints(): CheckpointStore & { rows: () => number } {
  let rows: number[] = [];
  return {
    put: async () => {
      rows.push(1);
    },
    latest: async () => null,
    rows: () => rows.length,
  };
}

// Set up a real in-memory store with one balanced posting already written through the
// normal write path (postEntry). Writing it that way means each account's hash chain is
// extended for real, so proveChain has genuine history to re-check. Returns the same hash
// function (digest) the write used, so any later verify re-hashes with the identical
// function and reproduces the same hashes.
async function populatedStore(): Promise<{ store: Store; digest: Digest }> {
  let digest = seededDigest(1);
  let store = memoryStore({ digest });
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_seed', 'usr_a')),
  );
  return { store, digest };
}

// --- advanceHeads: extend each account's hash chain when a posting is written ------

async function advancesOneHeadPerDistinctAccount(): Promise<void> {
  let digest = seededDigest(1);
  let posting = balancedPosting('txn_1', 'usr_a');

  let links = await advanceHeads(digest, posting, () => undefined);

  assert.equal(links.length, 2);
  assert.deepEqual(
    links.map((link) => link.account),
    [spendable('usr_a'), SYSTEM.REVENUE],
  );
}

async function usesGenesisForANewAccount(): Promise<void> {
  let digest = seededDigest(1);
  let posting = balancedPosting('txn_1', 'usr_a');

  let links = await advanceHeads(digest, posting, () => undefined);

  assert.equal(links[0]!.prevHash, GENESIS_HEX);
  assert.match(links[0]!.hash, /^[0-9a-f]{64}$/);
}

async function agreesWithTheChainHashSeam(): Promise<void> {
  let digest = seededDigest(1);
  let posting = balancedPosting('txn_1', 'usr_a');

  let links = await advanceHeads(digest, posting, () => undefined);

  // advanceHeads must compute the link hash by calling the shared chainHash function, not
  // by re-implementing the hashing itself. To prove that, call chainHash directly with the
  // same inputs and require the link's hash to match it exactly.
  let expected = await chainHash(digest, {
    accountPrevHash: new Uint8Array(32),
    txnId: posting.txnId,
    account: spendable('usr_a'),
    legs: posting.legs,
    meta: posting.meta,
  });
  assert.equal(links[0]!.hash, expected);
}

async function threadsThePriorHeadForward(): Promise<void> {
  let digest = seededDigest(1);
  let first = await advanceHeads(
    digest,
    balancedPosting('txn_1', 'usr_a'),
    () => undefined,
  );
  let priorHead = first[0]!.hash;

  let second = await advanceHeads(
    digest,
    balancedPosting('txn_2', 'usr_a'),
    (account) => (account === spendable('usr_a') ? priorHead : undefined),
  );

  assert.equal(second[0]!.prevHash, priorHead);
  assert.notEqual(second[0]!.hash, priorHead);
}

// --- proveChain: re-walk every account's chain and report the first thing that's wrong

async function reportsIntactOverAHealthyLedger(): Promise<void> {
  let { store, digest } = await populatedStore();

  // proveChain re-hashes every account's chain from its start, using the same hash function
  // the original write used. An untampered ledger must reproduce its stored hashes exactly,
  // so if this reports a break, the verifier (not the data) is broken.
  let report = await proveChain({ ledger: store.ledger, digest });

  assert.equal(report.intact, true);
  assert.equal(report.firstBreak, null);
  assert.equal(report.count, 2); // the user's spendable account and REVENUE
}

async function detectsATamperedLegOnACommittedPosting(): Promise<void> {
  // Simulate an attacker editing stored data directly: __tamper changes an already-written
  // entry but leaves the recorded hash untouched. Because the entry changed, re-hashing it
  // no longer produces the stored hash, so proveChain should catch the mismatch.
  let { store, digest } = await populatedStore();
  let ledger = store.ledger as MemoryLedger;
  ledger.__tamper('txn_seed', (legs: Leg[]) => {
    legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 999n) };
  });

  let report = await proveChain({ ledger: store.ledger, digest });

  assert.equal(report.intact, false);
  assert.equal(report.firstBreak?.txnId, 'txn_seed');
  assert.equal(report.firstBreak?.account, spendable('usr_a')); // the account whose entry was edited
  assert.equal(report.firstBreak?.reason, 'tampered-hash');
  // The freshly recomputed hash (expected) differs from the stored hash (actual).
  assert.notEqual(report.firstBreak?.expected, report.firstBreak?.actual);
}

async function pinpointsTheTamperedAccountAcrossAMultiPostingChain(): Promise<void> {
  // Write two postings to the same account, then tamper only the second one. proveChain
  // should pin the break to the second posting's transaction, not the first (which is still
  // valid), proving it reports exactly where the chain first fails.
  let digest = seededDigest(1);
  let store = memoryStore({ digest });
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_1', 'usr_b')),
  );
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_2', 'usr_b')),
  );
  (store.ledger as MemoryLedger).__tamper('txn_2', (legs: Leg[]) => {
    legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 1n) };
  });

  let report = await proveChain({ ledger: store.ledger, digest });

  assert.equal(report.intact, false);
  assert.equal(report.firstBreak?.txnId, 'txn_2');
  assert.equal(report.firstBreak?.account, spendable('usr_b'));
}

// --- merkleRoot: fold every account's head hash (the latest hash in its chain) into one summary hash

async function rootsAnEmptyHeadSetToGenesis(): Promise<void> {
  let digest = seededDigest(1);

  let root = await merkleRoot(digest, []);

  assert.deepEqual(root, new Uint8Array(32));
}

async function producesTheSameRootForTheSameHeadsOnEveryRuntime(): Promise<void> {
  // The summary hash must not depend on the order the accounts arrive in. merkleRoot sorts
  // the accounts first, so feeding it the same set in two different orders must give the
  // exact same bytes. This is what lets a checkpoint reproduce identically on any runtime.
  let heads: ReadonlyArray<readonly [AccountRef, string]> = [
    [spendable('usr_a'), 'a'.repeat(64)],
    [SYSTEM.REVENUE, 'c'.repeat(64)],
    [spendable('usr_b'), 'e'.repeat(64)],
  ];

  let rootA = await merkleRoot(seededDigest(7), heads);
  let rootB = await merkleRoot(seededDigest(7), [...heads].reverse());

  assert.deepEqual(rootA, rootB); // same set in reversed order yields the same root, because merkleRoot sorts it
}

async function changesTheRootWhenAnyHeadChanges(): Promise<void> {
  let digest = seededDigest(1);
  let base: ReadonlyArray<readonly [AccountRef, string]> = [
    [spendable('usr_a'), 'a'.repeat(64)],
    [SYSTEM.REVENUE, 'c'.repeat(64)],
  ];
  let tampered: ReadonlyArray<readonly [AccountRef, string]> = [
    [spendable('usr_a'), 'a'.repeat(63) + 'b'], // a single hex character changed (last 'a' -> 'b')
    [SYSTEM.REVENUE, 'c'.repeat(64)],
  ];

  let rootBase = toHex(await merkleRoot(digest, base));
  let rootTampered = toHex(await merkleRoot(digest, tampered));

  assert.notEqual(rootBase, rootTampered);
}

// --- recordCheckpoint / verifyCheckpoint: sign a snapshot of the ledger, then check it

async function recordsASignedCheckpointOverTheCurrentHeads(): Promise<void> {
  let { store } = await populatedStore();
  let digest = seededDigest(1);
  let checkpoints = captureCheckpoints();

  let checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints,
    digest,
    signer: seededSigner(1),
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  assert.equal(checkpoints.rows(), 1);
  assert.equal(checkpoint.count, 2);
  assert.match(checkpoint.root, /^[0-9a-f]{64}$/);
  assert.match(checkpoint.signature, /^[0-9a-f]+$/); // signature is stored as lowercase hexadecimal
}

async function refusesToCheckpointATamperedChainAndWritesNothing(): Promise<void> {
  // recordCheckpoint must re-verify the whole chain before it signs anything. Tamper a committed posting's
  // stored leg (leaving its recorded hash untouched, so re-hashing no longer reproduces it),
  // then attempt to checkpoint. proveChain finds the break, so recordCheckpoint throws
  // CHAIN.BROKEN and never reaches the store — no checkpoint is persisted over a tampered
  // ledger.
  let { store, digest } = await populatedStore();
  (store.ledger as MemoryLedger).__tamper('txn_seed', (legs: Leg[]) => {
    legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 999n) };
  });
  let checkpoints = captureCheckpoints();

  await assert.rejects(
    () =>
      recordCheckpoint({
        ledger: store.ledger,
        checkpoints,
        digest,
        signer: seededSigner(1),
        clock: fixedClock(0),
        ids: sequentialIds(),
      }),
    (error: unknown) =>
      error instanceof EconomyError && error.code === 'CHAIN.BROKEN',
  );
  assert.equal(checkpoints.rows(), 0);
}

async function recordedRootEqualsTheDirectMerkleRoot(): Promise<void> {
  let { store } = await populatedStore();
  let digest = seededDigest(1);

  let checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer: seededSigner(1),
    clock: fixedClock(0),
    ids: sequentialIds(),
  });
  let heads: Array<readonly [AccountRef, string]> = [];
  for await (let pair of store.ledger.heads()) {
    heads.push(pair);
  }

  assert.equal(checkpoint.root, toHex(await merkleRoot(digest, heads)));
}

async function verifiesAFreshlyRecordedCheckpoint(): Promise<void> {
  let { store } = await populatedStore();
  let digest = seededDigest(1);
  let signer = seededSigner(1);
  let checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer,
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  let ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer },
    checkpoint,
  );

  assert.equal(ok, true);
}

async function rejectsACheckpointWhenTheLedgerMoved(): Promise<void> {
  let { store } = await populatedStore();
  let digest = seededDigest(1);
  let signer = seededSigner(1);
  let checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer,
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  // Write another posting after the checkpoint was taken. That changes an account's head
  // hash, so the root recomputed now differs from the one signed into the checkpoint, and
  // verify must report a mismatch.
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_after', 'usr_a')),
  );
  let ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer },
    checkpoint,
  );

  assert.equal(ok, false);
}

async function rejectsAForgedSignature(): Promise<void> {
  let { store } = await populatedStore();
  let digest = seededDigest(1);
  let checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer: seededSigner(1),
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  // Verify with a different signing key (seed 2) than the one that signed the checkpoint
  // (seed 1). Since key 2 never produced this signature, verify must reject it.
  let ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer: seededSigner(2) },
    checkpoint,
  );

  assert.equal(ok, false);
}

async function verifiesAcrossAKeyRotation(): Promise<void> {
  // After the signing key is rotated, a checkpoint signed with the old key must still
  // verify. The point: when the new signer is given the new key plus the old key as a
  // still-accepted prior key, verify tries the prior key and accepts the old signature.
  // This uses the real production signer (Ed25519, a public-key signature scheme where a
  // separate public key verifies what a private key signed), not the seeded test stand-in.
  let oldKey = 'aa'.repeat(32);
  let newKey = 'bb'.repeat(32);
  let { store } = await populatedStore();
  let digest = seededDigest(1);
  let checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer: systemSigner({ signingKey: oldKey }),
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  let rotated = systemSigner({ signingKey: newKey, priorKeys: [oldKey] });
  let ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer: rotated },
    checkpoint,
  );

  assert.equal(ok, true);
}

describe('Chain', () => {
  test('advances one head per distinct account in a posting', () =>
    advancesOneHeadPerDistinctAccount());
  test('uses the empty-chain starting placeholder for a brand-new account', () =>
    usesGenesisForANewAccount());
  test('hashes each link through the shared chainHash function', () =>
    agreesWithTheChainHashSeam());
  test('threads the prior head forward into the next link', () =>
    threadsThePriorHeadForward());

  test('proves a healthy ledger intact by recomputing every head', () =>
    reportsIntactOverAHealthyLedger());
  test('detects a tampered leg on a committed posting', () =>
    detectsATamperedLegOnACommittedPosting());
  test('pinpoints the tampered account/txn across a multi-posting chain', () =>
    pinpointsTheTamperedAccountAcrossAMultiPostingChain());

  test('roots an empty head set to all-zero bytes', () =>
    rootsAnEmptyHeadSetToGenesis());
  test('produces the same root for the same heads on every runtime', () =>
    producesTheSameRootForTheSameHeadsOnEveryRuntime());
  test('changes the root when any head changes', () =>
    changesTheRootWhenAnyHeadChanges());

  test('records a signed checkpoint over the current heads', () =>
    recordsASignedCheckpointOverTheCurrentHeads());
  test('refuses to checkpoint a tampered chain and writes nothing', () =>
    refusesToCheckpointATamperedChainAndWritesNothing());
  test('records a root equal to the direct Merkle root', () =>
    recordedRootEqualsTheDirectMerkleRoot());
  test('verifies a freshly recorded checkpoint', () =>
    verifiesAFreshlyRecordedCheckpoint());
  test('rejects a checkpoint after the ledger moved', () =>
    rejectsACheckpointWhenTheLedgerMoved());
  test('rejects a forged signature', () => rejectsAForgedSignature());
  test('verifies a checkpoint signed under a rotated-out key', () =>
    verifiesAcrossAKeyRotation());
});
