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
 * Per-account hash chains and the signed Merkle checkpoint over their heads. `advanceHeads`
 * computes new links on the write path, `proveChain` re-derives every chain from genesis, and
 * `recordCheckpoint`/`verifyCheckpoint` sign and re-check the root. Tampering with stored history
 * is detectable.
 */

import { GENESIS, GENESIS_HEX, chainHash } from '#src/ledger.ts';
import { toHex, fromHex, byCodeUnit, toInt64BE } from '#src/bytes.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';

import type { AccountRef } from '#src/accounts.ts';
import type {
  Checkpoint,
  CheckpointStore,
  Digest,
  Ids,
  Clock,
  Ledger,
  CallOptions,
  Posting,
  Signer,
  StoredLink,
} from '#src/ports.ts';

/**
 * One step in an account's hash chain: the new head after a posting and the head it followed.
 * Each account has its own chain, and its latest head summarizes its whole history.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 * tamper-evidence construction these links and checkpoints implement.
 */
export type ChainLink = {
  account: AccountRef;

  /**
   * Head hash before this posting, lowercase hex. For an account's first posting this is the
   * genesis value (64 zeros).
   */
  prevHash: string;

  /** Head hash after this posting, lowercase hex. */
  hash: string;
};

/**
 * The first broken link the prover finds in an account's chain. Returned instead of a bare
 * boolean so a caller can see which posting failed and how.
 */
export type ChainBreak = {
  account: AccountRef;

  txnId: string;

  /**
   * 'broken-link' means the stored "previous head" does not match the head reached by walking the
   * chain so far, so the chain is not continuous. 'tampered-hash' means re-hashing the stored
   * entries and metadata no longer produces the recorded head hash, so the contents were changed
   * after the fact.
   */
  reason: 'broken-link' | 'tampered-hash';

  /**
   * The hash that should have been found. For 'broken-link' this is the head reached by walking the
   * chain. For 'tampered-hash' this is the recomputed hash.
   */
  expected: string;

  /** The stored hash that failed to match `expected`. */
  actual: string;
};

export type ChainReport = {
  intact: boolean;

  firstBreak: ChainBreak | null;

  /** How many account chains were checked. */
  count: number;
};

/**
 * Computes the new head for each distinct account a posting touches, in first-appearance order. It
 * produces one link per account, not one per leg, so a posting that names an account in several legs
 * still advances that account's chain a single step. Each account hashes only its own legs onto its
 * own prior head, so chains never cross. `prevHeadOf` returns an account's current head; an undefined
 * result or the genesis value starts a fresh chain.
 */
export async function advanceHeads(
  digest: Digest,
  posting: Posting,
  prevHeadOf: (account: AccountRef) => string | undefined,
): Promise<ChainLink[]> {
  const links: ChainLink[] = [];
  for (const account of distinctAccounts(posting)) {
    const prevHex = prevHeadOf(account) ?? GENESIS_HEX;
    const accountPrevHash =
      prevHex === GENESIS_HEX ? GENESIS : fromHex(prevHex);
    const hash = await chainHash(digest, {
      accountPrevHash,
      txnId: posting.txnId,
      account,
      legs: posting.legs,
      meta: posting.meta,
    });
    links.push({ account, prevHash: prevHex, hash });
  }
  return links;
}

/**
 * Re-checks every account's chain. It walks each account's postings from genesis, recomputes each
 * head with the write path's hash function, and stops at the first mismatch. Accounts are checked in
 * a fixed order, sorted by id char by char, so a break is reported identically whatever order a
 * runtime or database returns accounts in.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 *   re-derivation this proves and what a break means.
 */
export async function proveChain(
  deps: { ledger: Ledger; digest: Digest },
  options?: CallOptions,
): Promise<ChainReport> {
  const heads = [...(await collectHeadPairs(deps.ledger))].sort((a, b) =>
    byCodeUnit(a[0], b[0]),
  );
  const count = heads.length;
  for (const [account] of heads) {
    const broken = await recomputeAccount(deps, account, options);
    if (broken) {
      return { intact: false, firstBreak: broken, count };
    }
  }
  return { intact: true, firstBreak: null, count };
}

// `prev` is the head reached so far — the genesis value before the first posting.
async function recomputeAccount(
  deps: { ledger: Ledger; digest: Digest },
  account: AccountRef,
  options?: CallOptions,
): Promise<ChainBreak | null> {
  let prev = GENESIS_HEX;
  for await (const link of deps.ledger.lineage(account, options)) {
    if (link.prevHash !== prev) {
      return {
        account,
        txnId: link.txnId,
        reason: 'broken-link',
        expected: prev,
        actual: link.prevHash,
      };
    }
    const recomputed = await recomputeLink(deps.digest, account, link);
    if (recomputed !== link.hash) {
      return {
        account,
        txnId: link.txnId,
        reason: 'tampered-hash',
        expected: recomputed,
        actual: link.hash,
      };
    }
    prev = link.hash;
  }
  return null;
}

function recomputeLink(
  digest: Digest,
  account: AccountRef,
  link: StoredLink,
): Promise<string> {
  return chainHash(digest, {
    accountPrevHash: fromHex(link.prevHash),
    txnId: link.txnId,
    account,
    legs: link.legs,
    meta: link.meta,
  });
}

/**
 * Reduces every account's head into one Merkle root, so signing the root (see `recordCheckpoint`)
 * covers every chain in one signature. The root changes if any head changes. The root is
 * reproducible across machines because leaves are sorted by account id, the RFC 6962 domain tags
 * (`MERKLE_LEAF` and `MERKLE_NODE`) are applied, and each pair is hashed left then right so order
 * matters. With no accounts the root is the genesis value of 32 zero bytes, so a fresh ledger still
 * has a stable root to sign.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for how the
 *   root anchors the whole ledger under one signature.
 */
export async function merkleRoot(
  digest: Digest,
  heads: ReadonlyArray<readonly [AccountRef, string]>,
): Promise<Uint8Array> {
  const sorted = [...heads].sort((a, b) => byCodeUnit(a[0], b[0]));
  let level: Uint8Array[] = [];
  for (const [account, head] of sorted) {
    level.push(await digest.hash(leafPreimage(account, head)));
  }
  if (level.length === 0) {
    return new Uint8Array(32);
  }
  while (level.length > 1) {
    level = await combineLevel(digest, level);
  }
  return level[0]!;
}

/**
 * Reduces every account's (head, sum) pair into one sum-carrying Merkle root: each node holds its
 * subtree's balance sum, and each node's hash commits to (both child hashes + that sum), so the
 * root hash fixes every head AND every sum at once, and the root sum is as tamper-evident as the
 * root hash. `sum` per leaf is the account's raw signed leg total (debit positive), which is why
 * a consistent ledger's root sums to zero: legs net to zero per currency, so they net to zero in
 * total. Reproducible across machines the same way `merkleRoot` is: leaves sorted by account id,
 * versioned domain tags, left-then-right hashing, and the sum encoded as fixed-width big-endian
 * bytes (`toInt64BE`), never as formatted text. With no accounts the root is the genesis value of
 * 32 zero bytes and a zero sum.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for how the
 *   root anchors the whole ledger under one signature.
 */
export async function merkleSumRoot(
  digest: Digest,
  leaves: ReadonlyArray<readonly [AccountRef, string, bigint]>,
): Promise<{ hash: Uint8Array; sum: bigint }> {
  const sorted = [...leaves].sort((a, b) => byCodeUnit(a[0], b[0]));
  let level: Array<{ hash: Uint8Array; sum: bigint }> = [];
  for (const [account, head, sum] of sorted) {
    level.push({
      hash: await digest.hash(sumLeafPreimage(account, head, sum)),
      sum,
    });
  }
  if (level.length === 0) {
    return { hash: new Uint8Array(32), sum: 0n };
  }
  while (level.length > 1) {
    const next: Array<{ hash: Uint8Array; sum: bigint }> = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      // On an odd count the last unpaired node carries up unchanged, sum included.
      next.push(
        right
          ? {
              hash: await digest.hash(sumNodePreimage(left, right)),
              sum: left.sum + right.sum,
            }
          : left,
      );
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Takes a tamper-evident snapshot, called a "checkpoint". It first proves the chain re-derives, then
 * signs the sum-carrying Merkle root (v2) over every head and saves it. On a break this throws a
 * non-retryable CHAIN_BROKEN fault and persists nothing, so a signed root never attests to a
 * tampered ledger, and the caller sets the job aside for an operator rather than retrying. It also
 * refuses to sign when the collected sums do not net to zero (a non-retryable LEDGER_UNBALANCED
 * fault): the chain hashes cover every leg, so an edit breaks CHAIN_BROKEN first — a nonzero total
 * with intact chains means the write path itself recorded unbalanced money, which is exactly the
 * enforcement bug this last-resort check exists to catch. The signature covers the root hash and
 * the root sum together, so neither stored field can be edited under a valid signature. The save
 * goes through the checkpoint store, outside the money transaction, so a rolled-back operation
 * cannot undo an already-recorded checkpoint.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 *   checkpoint's role in the tamper-evidence story.
 */
export async function recordCheckpoint(
  deps: {
    ledger: Ledger;
    checkpoints: CheckpointStore;
    digest: Digest;
    signer: Signer;
    clock: Clock;
    ids: Ids;
  },
  options?: CallOptions,
): Promise<Checkpoint> {
  const report = await proveChain(
    { ledger: deps.ledger, digest: deps.digest },
    options,
  );
  if (!report.intact) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'The hash chain failed to re-derive; refusing to sign a checkpoint over a tampered ledger.',
      { retryable: false, detail: { firstBreak: report.firstBreak } },
    );
  }
  const leaves = await collectHeadSums(deps.ledger, options);
  const root = await merkleSumRoot(deps.digest, leaves);
  if (root.sum !== 0n) {
    throw fault(
      ERROR_CODES.LEDGER_UNBALANCED,
      'The ledger sums to a nonzero total; refusing to sign a checkpoint over unbalanced books.',
      { retryable: false, detail: { sum: root.sum.toString() } },
    );
  }
  const signature = await deps.signer.sign(sumRootPayload(root));
  const checkpoint: Checkpoint = {
    id: deps.ids.next('chk'),
    root: toHex(root.hash),
    signature: toHex(signature),
    count: leaves.length,
    at: deps.clock.now(),
    v: 2,
    sum: root.sum.toString(),
    kid: (await deps.signer.kid?.()) ?? null,
  };
  await deps.checkpoints.put(checkpoint, options);
  return checkpoint;
}

/**
 * Checks a saved checkpoint against the current ledger: recomputes the root the same way the
 * checkpoint's version sealed it (v1: hash-only over heads; v2: sum-carrying over heads and
 * sums), compares it to the stored root, then verifies the signature (accepting still-valid
 * rotated-out keys, so a checkpoint signed before a rotation keeps verifying). Rows from before
 * versioning verify forever down the v1 path, byte for byte. Returns false on a normal mismatch;
 * a live head count below the recorded one is one such mismatch, since deleting accounts to
 * shrink the root's coverage is itself tampering, and on v2 an edited stored sum is another,
 * since the signature covers the sum. Throws only on malformed stored hex, which is a corrupt
 * row, not a failed verification.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for why fewer
 * heads than recorded is itself a tamper signal.
 */
export async function verifyCheckpoint(
  deps: { ledger: Ledger; digest: Digest; signer: Signer },
  checkpoint: Checkpoint,
): Promise<boolean> {
  if (checkpoint.v === 2) {
    const leaves = await collectHeadSums(deps.ledger);
    if (leaves.length < checkpoint.count) {
      return false;
    }
    const root = await merkleSumRoot(deps.digest, leaves);
    if (toHex(root.hash) !== checkpoint.root) {
      return false;
    }
    if (checkpoint.sum === null || BigInt(checkpoint.sum) !== root.sum) {
      return false;
    }
    return deps.signer.verify(
      sumRootPayload(root),
      fromHex(checkpoint.signature),
    );
  }

  const heads = await collectHeadPairs(deps.ledger);
  if (heads.length < checkpoint.count) {
    return false;
  }
  const root = await merkleRoot(deps.digest, heads);
  if (toHex(root) !== checkpoint.root) {
    return false;
  }

  return deps.signer.verify(
    fromHex(checkpoint.root),
    fromHex(checkpoint.signature),
  );
}

// --- Internals --------------------------------------------------------------------

function distinctAccounts(posting: Posting): AccountRef[] {
  const seen = new Set<AccountRef>();
  const order: AccountRef[] = [];
  for (const leg of posting.legs) {
    if (!seen.has(leg.account)) {
      seen.add(leg.account);
      order.push(leg.account);
    }
  }
  return order;
}

// RFC 6962 domain tags (https://datatracker.ietf.org/doc/rfc6962/): a one-byte prefix keeps a leaf's
// preimage out of the internal-node domain, so no leaf can be reinterpreted as an interior pair —
// the second-preimage defense.
const MERKLE_LEAF = 0x00;
const MERKLE_NODE = 0x01;

// A leaf hashes the 0x00 tag then "account:head" as UTF-8. An account id may itself contain ":",
// but a head hash is pure hex, so the final ":" always separates account from head.
function leafPreimage(account: AccountRef, head: string): Uint8Array {
  const body = ENCODER.encode(`${account}:${head}`);
  const out = new Uint8Array(1 + body.length);
  out[0] = MERKLE_LEAF;
  out.set(body, 1);
  return out;
}

// On an odd count the last unpaired hash carries up unchanged.
async function combineLevel(
  digest: Digest,
  level: ReadonlyArray<Uint8Array>,
): Promise<Uint8Array[]> {
  const next: Uint8Array[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i]!;
    const right = level[i + 1];
    next.push(right ? await digest.hash(nodePreimage(left, right)) : left);
  }
  return next;
}

// The 0x01 tag, then the child hashes left then right. Both children are the same fixed length, so
// the split needs no separator.
function nodePreimage(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + left.length + right.length);
  out[0] = MERKLE_NODE;
  out.set(left, 1);
  out.set(right, 1 + left.length);
  return out;
}

// The v2 domain tags. New values rather than reusing 0x00/0x01, so a v2 preimage can never
// collide with a v1 preimage of the same account and head: the two constructions hash into
// disjoint domains, and old checkpoints keep verifying under the old tags forever.
const MERKLE_SUM_LEAF = 0x02;
const MERKLE_SUM_NODE = 0x03;

// The 0x02 tag, "account:head:" as UTF-8, then the sum as 8 big-endian bytes — fixed-width binary,
// not decimal text, so the same sum is the same bytes on every runtime.
function sumLeafPreimage(
  account: AccountRef,
  head: string,
  sum: bigint,
): Uint8Array {
  const body = ENCODER.encode(`${account}:${head}:`);
  const out = new Uint8Array(1 + body.length + 8);
  out[0] = MERKLE_SUM_LEAF;
  out.set(body, 1);
  out.set(toInt64BE(sum), 1 + body.length);
  return out;
}

function sumNodePreimage(
  left: { hash: Uint8Array; sum: bigint },
  right: { hash: Uint8Array; sum: bigint },
): Uint8Array {
  const out = new Uint8Array(1 + left.hash.length + right.hash.length + 8);
  out[0] = MERKLE_SUM_NODE;
  out.set(left.hash, 1);
  out.set(right.hash, 1 + left.hash.length);
  out.set(
    toInt64BE(left.sum + right.sum),
    1 + left.hash.length + right.hash.length,
  );
  return out;
}

function sumRootPayload(root: { hash: Uint8Array; sum: bigint }): Uint8Array {
  const out = new Uint8Array(root.hash.length + 8);
  out.set(root.hash, 0);
  out.set(toInt64BE(root.sum), root.hash.length);
  return out;
}

// Loading all at once is fine: one pair per account, and a checkpoint covers all of them anyway.
async function collectHeadPairs(
  ledger: Ledger,
): Promise<ReadonlyArray<readonly [AccountRef, string]>> {
  const pairs: Array<readonly [AccountRef, string]> = [];
  for await (const pair of ledger.heads()) {
    pairs.push(pair);
  }
  return pairs;
}

// Loading all at once is fine for the same reason. The store reads each (head, sum) pair in one
// statement (see Ledger.headSums), so no concurrent posting can tear a head from its sum.
async function collectHeadSums(
  ledger: Ledger,
  options?: CallOptions,
): Promise<ReadonlyArray<readonly [AccountRef, string, bigint]>> {
  const leaves: Array<readonly [AccountRef, string, bigint]> = [];
  for await (const leaf of ledger.headSums(options)) {
    leaves.push(leaf);
  }
  return leaves;
}

const ENCODER: TextEncoder = new TextEncoder();
