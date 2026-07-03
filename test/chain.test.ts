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

// The prevHash an account's first posting points back to. It is 64 zero characters,
// which is 32 zero bytes written as lowercase hex.
const GENESIS_HEX = '0'.repeat(64);

// Builds a balanced double-entry posting that credits 500 to the user's spendable account
// and debits 500 from REVENUE. The two legs touch distinct accounts, so advanceHeads
// produces two separate chain links to assert on.
function balancedPosting(txnId: string, user: string): Posting {
  const amount = toAmount('CREDIT', 500n);
  return {
    txnId,
    legs: [credit(spendable(user), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { kind: 'test', source: 'card' },
  };
}

// Builds a fake CheckpointStore that counts put() calls and exposes the count through rows(),
// so a test can assert recordCheckpoint saved exactly one checkpoint. The production store
// lives in the db adapter and writes outside the money-posting transaction by design.
function captureCheckpoints(): CheckpointStore & { rows: () => number } {
  const rows: number[] = [];
  return {
    put: async () => {
      rows.push(1);
    },
    latest: async () => null,
    rows: () => rows.length,
  };
}

// Builds an in-memory store and writes one balanced posting through the normal path
// (postEntry). Going through postEntry extends each account's hash chain for real, so
// proveChain has genuine history to re-check. The returned digest is the one the write used,
// so a later verify re-hashes identically.
async function populatedStore(): Promise<{ store: Store; digest: Digest }> {
  const digest = seededDigest(1);
  const store = memoryStore({ digest });
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_seed', 'usr_a')),
  );
  return { store, digest };
}

// --- advanceHeads: extend each account's hash chain when a posting is written ------

async function advancesOneHeadPerDistinctAccount(): Promise<void> {
  const digest = seededDigest(1);
  const posting = balancedPosting('txn_1', 'usr_a');

  const links = await advanceHeads(digest, posting, () => undefined);

  assert.equal(links.length, 2);
  assert.deepEqual(
    links.map((link) => link.account),
    [spendable('usr_a'), SYSTEM.REVENUE],
  );
}

async function usesGenesisForANewAccount(): Promise<void> {
  const digest = seededDigest(1);
  const posting = balancedPosting('txn_1', 'usr_a');

  const links = await advanceHeads(digest, posting, () => undefined);

  assert.equal(links[0]!.prevHash, GENESIS_HEX);
  assert.match(links[0]!.hash, /^[0-9a-f]{64}$/);
}

async function agreesWithTheChainHashSeam(): Promise<void> {
  const digest = seededDigest(1);
  const posting = balancedPosting('txn_1', 'usr_a');

  const links = await advanceHeads(digest, posting, () => undefined);

  // advanceHeads must hash via the shared chainHash, not its own copy. Call chainHash
  // directly with the same inputs and require the link's hash to match exactly.
  const expected = await chainHash(digest, {
    accountPrevHash: new Uint8Array(32),
    txnId: posting.txnId,
    account: spendable('usr_a'),
    legs: posting.legs,
    meta: posting.meta,
  });
  assert.equal(links[0]!.hash, expected);
}

async function threadsThePriorHeadForward(): Promise<void> {
  const digest = seededDigest(1);
  const first = await advanceHeads(
    digest,
    balancedPosting('txn_1', 'usr_a'),
    () => undefined,
  );
  const priorHead = first[0]!.hash;

  const second = await advanceHeads(
    digest,
    balancedPosting('txn_2', 'usr_a'),
    (account) => (account === spendable('usr_a') ? priorHead : undefined),
  );

  assert.equal(second[0]!.prevHash, priorHead);
  assert.notEqual(second[0]!.hash, priorHead);
}

// --- proveChain: re-walk every account's chain and report the first thing that's wrong

async function reportsIntactOverAHealthyLedger(): Promise<void> {
  const { store, digest } = await populatedStore();

  // proveChain re-hashes every chain from its start with the same digest the write used. An
  // untampered ledger reproduces its stored hashes, so a break here means the verifier is broken.
  const report = await proveChain({ ledger: store.ledger, digest });

  assert.equal(report.intact, true);
  assert.equal(report.firstBreak, null);
  assert.equal(report.count, 2); // the user's spendable account and REVENUE
}

async function detectsATamperedLegOnACommittedPosting(): Promise<void> {
  // __tamper edits a written entry but leaves its recorded hash untouched, mimicking an
  // attacker editing stored data. Re-hashing no longer matches the stored hash, so proveChain
  // catches it.
  const { store, digest } = await populatedStore();
  const ledger = store.ledger as MemoryLedger;
  ledger.__tamper('txn_seed', (legs: Leg[]) => {
    legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 999n) };
  });

  const report = await proveChain({ ledger: store.ledger, digest });

  assert.equal(report.intact, false);
  assert.equal(report.firstBreak?.txnId, 'txn_seed');
  assert.equal(report.firstBreak?.account, spendable('usr_a')); // the account whose entry was edited
  assert.equal(report.firstBreak?.reason, 'tampered-hash');
  // The freshly recomputed hash (expected) differs from the stored hash (actual).
  assert.notEqual(report.firstBreak?.expected, report.firstBreak?.actual);
}

async function pinpointsTheTamperedAccountAcrossAMultiPostingChain(): Promise<void> {
  // Writes two postings to one account and tampers only the second. proveChain should pin the
  // break to txn_2, not the still-valid txn_1, because it reports where the chain first fails.
  const digest = seededDigest(1);
  const store = memoryStore({ digest });
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_1', 'usr_b')),
  );
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_2', 'usr_b')),
  );
  (store.ledger as MemoryLedger).__tamper('txn_2', (legs: Leg[]) => {
    legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 1n) };
  });

  const report = await proveChain({ ledger: store.ledger, digest });

  assert.equal(report.intact, false);
  assert.equal(report.firstBreak?.txnId, 'txn_2');
  assert.equal(report.firstBreak?.account, spendable('usr_b'));
}

// --- merkleRoot: fold every account's head hash (the latest hash in its chain) into one summary hash

async function rootsAnEmptyHeadSetToGenesis(): Promise<void> {
  const digest = seededDigest(1);

  const root = await merkleRoot(digest, []);

  assert.deepEqual(root, new Uint8Array(32));
}

async function producesTheSameRootForTheSameHeadsOnEveryRuntime(): Promise<void> {
  // merkleRoot sorts accounts first, so the root is order-independent: the same set in two
  // orders gives identical bytes, letting a checkpoint reproduce on any runtime.
  const heads: ReadonlyArray<readonly [AccountRef, string]> = [
    [spendable('usr_a'), 'a'.repeat(64)],
    [SYSTEM.REVENUE, 'c'.repeat(64)],
    [spendable('usr_b'), 'e'.repeat(64)],
  ];

  const rootA = await merkleRoot(seededDigest(7), heads);
  const rootB = await merkleRoot(seededDigest(7), [...heads].reverse());

  assert.deepEqual(rootA, rootB); // reversed order, identical root, because merkleRoot sorts first
}

async function changesTheRootWhenAnyHeadChanges(): Promise<void> {
  const digest = seededDigest(1);
  const base: ReadonlyArray<readonly [AccountRef, string]> = [
    [spendable('usr_a'), 'a'.repeat(64)],
    [SYSTEM.REVENUE, 'c'.repeat(64)],
  ];
  const tampered: ReadonlyArray<readonly [AccountRef, string]> = [
    [spendable('usr_a'), 'a'.repeat(63) + 'b'], // one hex character differs from base
    [SYSTEM.REVENUE, 'c'.repeat(64)],
  ];

  const rootBase = toHex(await merkleRoot(digest, base));
  const rootTampered = toHex(await merkleRoot(digest, tampered));

  assert.notEqual(rootBase, rootTampered);
}

// --- recordCheckpoint / verifyCheckpoint: sign a snapshot of the ledger, then check it

async function recordsASignedCheckpointOverTheCurrentHeads(): Promise<void> {
  const { store } = await populatedStore();
  const digest = seededDigest(1);
  const checkpoints = captureCheckpoints();

  const checkpoint = await recordCheckpoint({
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
  // recordCheckpoint re-verifies the whole chain before signing. Tamper a committed leg
  // (hash left intact, so re-hashing no longer matches), then checkpoint. proveChain finds
  // the break, so recordCheckpoint throws CHAIN.BROKEN and never reaches the store.
  const { store, digest } = await populatedStore();
  (store.ledger as MemoryLedger).__tamper('txn_seed', (legs: Leg[]) => {
    legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 999n) };
  });
  const checkpoints = captureCheckpoints();

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
  const { store } = await populatedStore();
  const digest = seededDigest(1);

  const checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer: seededSigner(1),
    clock: fixedClock(0),
    ids: sequentialIds(),
  });
  const heads: Array<readonly [AccountRef, string]> = [];
  for await (const pair of store.ledger.heads()) {
    heads.push(pair);
  }

  assert.equal(checkpoint.root, toHex(await merkleRoot(digest, heads)));
}

async function verifiesAFreshlyRecordedCheckpoint(): Promise<void> {
  const { store } = await populatedStore();
  const digest = seededDigest(1);
  const signer = seededSigner(1);
  const checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer,
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  const ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer },
    checkpoint,
  );

  assert.equal(ok, true);
}

async function rejectsACheckpointWhenTheLedgerMoved(): Promise<void> {
  const { store } = await populatedStore();
  const digest = seededDigest(1);
  const signer = seededSigner(1);
  const checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer,
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  // Post again after the checkpoint. That changes an account's head hash, so the recomputed
  // root differs from the one signed into the checkpoint and verify reports a mismatch.
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_after', 'usr_a')),
  );
  const ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer },
    checkpoint,
  );

  assert.equal(ok, false);
}

async function rejectsAForgedSignature(): Promise<void> {
  const { store } = await populatedStore();
  const digest = seededDigest(1);
  const checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer: seededSigner(1),
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  // Verify with seed 2, but the checkpoint was signed with seed 1. Key 2 never produced this
  // signature, so verify rejects it.
  const ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer: seededSigner(2) },
    checkpoint,
  );

  assert.equal(ok, false);
}

async function verifiesAcrossAKeyRotation(): Promise<void> {
  // A checkpoint signed with the old key must still verify after rotation: given the new key
  // plus the old key as a still-accepted prior key, verify tries the prior key and accepts.
  // Uses the real production Ed25519 signer, not the seeded test stand-in.
  const oldKey = 'aa'.repeat(32);
  const newKey = 'bb'.repeat(32);
  const { store } = await populatedStore();
  const digest = seededDigest(1);
  const checkpoint = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: captureCheckpoints(),
    digest,
    signer: systemSigner({ signingKey: oldKey }),
    clock: fixedClock(0),
    ids: sequentialIds(),
  });

  const rotated = systemSigner({ signingKey: newKey, priorKeys: [oldKey] });
  const ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer: rotated },
    checkpoint,
  );

  assert.equal(ok, true);
}

async function separatesLeafAndNodeHashDomains(): Promise<void> {
  // RFC 6962 domain separation: a leaf is H(0x00 || "account:head") and an internal node is
  // H(0x01 || left || right). This rebuilds both preimages by hand and checks that merkleRoot
  // agrees, which locks in the one-byte tags. Without those tags, leaves and nodes would share
  // one hash domain, and a leaf could be reinterpreted as an interior left||right pair.
  const digest = seededDigest(1);
  const encoder = new TextEncoder();
  const tagged = (prefix: number, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(1 + body.length);
    out[0] = prefix;
    out.set(body, 1);
    return out;
  };
  const leafHash = (account: AccountRef, head: string): Promise<Uint8Array> =>
    digest.hash(tagged(0x00, encoder.encode(`${account}:${head}`)));

  const a = spendable('usr_a');
  const b = spendable('usr_b');
  const headA = 'a'.repeat(64);
  const headB = 'b'.repeat(64);

  // With a single leaf, the root is that leaf's 0x00-tagged hash, left unchanged.
  const one: ReadonlyArray<readonly [AccountRef, string]> = [[a, headA]];
  assert.deepEqual(await merkleRoot(digest, one), await leafHash(a, headA));

  // With two leaves, the root is the 0x01-tagged hash of the two leaf hashes, left then right.
  // merkleRoot sorts by account id, so usr_a is the left child even though it is passed second.
  const left = await leafHash(a, headA);
  const right = await leafHash(b, headB);
  const node = new Uint8Array(1 + left.length + right.length);
  node[0] = 0x01;
  node.set(left, 1);
  node.set(right, 1 + left.length);
  const two: ReadonlyArray<readonly [AccountRef, string]> = [
    [b, headB],
    [a, headA],
  ];
  assert.deepEqual(await merkleRoot(digest, two), await digest.hash(node));
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
  test('separates the Merkle leaf and node hash domains (RFC 6962)', () =>
    separatesLeafAndNodeHashDomains());

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
