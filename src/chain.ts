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

import { chainHash } from '#src/ledger.ts';
import { toHex, fromHex, byCodeUnit } from '#src/bytes.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';

import type { AccountRef } from '#src/accounts.ts';
import type {
  Checkpoint,
  CheckpointStore,
  Digest,
  Ids,
  Clock,
  Ledger,
  Options,
  Posting,
  Signer,
  StoredLink,
} from '#src/ports.ts';

/**
 * One step in an account's hash chain. Each posting is hashed onto the hash of the previous
 * one; the latest hash is the account's "head". This records the new head after a posting and
 * the head it followed. Each account has its own chain.
 */
export type ChainLink = {
  account: AccountRef;

  // Head hash before this posting, lowercase hex. For an account's first posting this is the
  // genesis value (64 zeros).
  prevHash: string;

  // Head hash after this posting, lowercase hex.
  hash: string;
};

// "No previous posting" hash, lowercase hex: 32 zero bytes as 64 zero chars. Matches GENESIS
// in ledger.ts.
let GENESIS_HEX = '0'.repeat(64);

/**
 * The first broken link the prover finds in an account's chain. Returned instead of a bare
 * boolean so a caller can see which posting failed and how.
 */
export type ChainBreak = {
  account: AccountRef;

  txnId: string;

  // - 'broken-link': stored "previous head" doesn't match the head reached by walking the
  //   chain so far; the chain isn't continuous.
  // - 'tampered-hash': re-hashing the stored entries and metadata no longer produces the
  //   recorded head hash; contents were changed after the fact.
  reason: 'broken-link' | 'tampered-hash';

  // Expected hash: the head reached by walking the chain ('broken-link') or the recomputed
  // hash ('tampered-hash').
  expected: string;

  // The stored hash that failed to match `expected`.
  actual: string;
};

/** The result of checking every account's chain. */
export type ChainReport = {
  // True when no break was found.
  intact: boolean;

  // The first break found, or null when the chains are intact.
  firstBreak: ChainBreak | null;

  // How many account chains were checked.
  count: number;
};

/**
 * Compute the new head hash for each account a posting touches. Called by the write path when
 * appending a posting.
 *
 * A posting has many entries (legs), several of which can name the same account; this produces
 * one link per distinct account, in the order accounts first appear. Each account hashes only
 * its own entries onto its own prior head, so chains never mix across accounts.
 *
 * `prevHeadOf` returns an account's current head, or undefined if never posted to. Undefined or
 * the genesis value means the new link starts from genesis.
 */
export async function advanceHeads(
  digest: Digest,
  posting: Posting,
  prevHeadOf: (account: AccountRef) => string | undefined,
): Promise<ChainLink[]> {
  let links: ChainLink[] = [];
  for (let account of distinctAccounts(posting)) {
    let prevHex = prevHeadOf(account) ?? GENESIS_HEX;
    let accountPrevHash =
      prevHex === GENESIS_HEX ? new Uint8Array(32) : fromHex(prevHex);
    let hash = await chainHash(digest, {
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
 * Re-check every account's chain: walk each account's postings from the start, recompute the
 * head hash at each step, stop at the first mismatch.
 *
 * Accounts are checked in a fixed order (by id string, char by char), so the same tampering is
 * reported the same way regardless of the order a runtime or database returns accounts. The
 * recompute uses the same hashing as the write path, so an untampered ledger reproduces its
 * stored hashes exactly.
 */
export async function proveChain(
  deps: { ledger: Ledger; digest: Digest },
  options?: Options,
): Promise<ChainReport> {
  // Read every account's head, sorted by account id (char by char), so proveChain checks
  // accounts in the same sequence everywhere.
  let heads = [...(await collectHeadPairs(deps.ledger))].sort((a, b) =>
    byCodeUnit(a[0], b[0]),
  );
  let count = heads.length;
  for (let [account] of heads) {
    let broken = await recomputeAccount(deps, account, options);
    if (broken) {
      return { intact: false, firstBreak: broken, count };
    }
  }
  return { intact: true, firstBreak: null, count };
}

// Walk one account's postings in order, check each link. `prev` is the head reached so far
// (genesis before the first posting). A link fails if its stored "previous head" doesn't match
// `prev` (not continuous) or re-hashing its contents doesn't reproduce its stored hash
// (contents changed). Returns the first failure, or null if the account checks out.
async function recomputeAccount(
  deps: { ledger: Ledger; digest: Digest },
  account: AccountRef,
  options?: Options,
): Promise<ChainBreak | null> {
  let prev = GENESIS_HEX;
  for await (let link of deps.ledger.lineage(account, options)) {
    if (link.prevHash !== prev) {
      return {
        account,
        txnId: link.txnId,
        reason: 'broken-link',
        expected: prev,
        actual: link.prevHash,
      };
    }
    let recomputed = await recomputeLink(deps.digest, account, link);
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

// Re-hash one stored posting the way the write path did: feed its stored previous head (hex
// decoded back to bytes) plus entries and metadata through the same hash function. The result
// should equal the recorded head hash; if any entry was altered, it won't.
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
 * Reduce every account's head into one hash, a Merkle root: hash each head into a leaf, then
 * hash leaves in pairs until one remains. The root changes if any head changes, so signing it
 * (see `recordCheckpoint`) covers every account's chain in one signature.
 *
 * Two rules pin the result across machines. Leaves are sorted by account id char by char (not
 * locale-sensitive). The building blocks are fixed: each leaf is the hash of a 0x00 tag plus
 * `account + ":" + head`, and each pair of children is hashed under a 0x01 tag joined
 * left-then-right, so swapping order changes the result. The two tags (RFC 6962) keep a leaf from
 * ever being reinterpreted as an internal node. With no accounts, the root is the genesis value
 * (32 zero bytes), so a new ledger still has a stable hash to sign.
 */
export async function merkleRoot(
  digest: Digest,
  heads: ReadonlyArray<readonly [AccountRef, string]>,
): Promise<Uint8Array> {
  let sorted = [...heads].sort((a, b) => byCodeUnit(a[0], b[0]));
  let level: Uint8Array[] = [];
  for (let [account, head] of sorted) {
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
 * Take a tamper-evident snapshot of the ledger now: prove the chain re-derives, collect every
 * account's head, reduce to one Merkle root (see `merkleRoot`), sign the root, and save the
 * signed snapshot (a "checkpoint").
 *
 * The proof comes first: a signed root attests the ledger is intact, so signing over a chain
 * that no longer re-derives would be a false attestation. `proveChain` re-walks every account;
 * on a break this throws a non-retryable CHAIN_BROKEN fault and persists no checkpoint. The
 * caller treats a non-retryable fault as a dead end: no retry, sets the job aside for an
 * operator.
 *
 * The save goes through the checkpoint store, kept separate from the database transaction that
 * posts money, so a rolled-back money operation doesn't undo an already-recorded checkpoint.
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
  options?: Options,
): Promise<Checkpoint> {
  let report = await proveChain(
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
  let heads = await collectHeadPairs(deps.ledger);
  let root = await merkleRoot(deps.digest, heads);
  let signature = await deps.signer.sign(root);
  let checkpoint: Checkpoint = {
    id: deps.ids.next('chk'),
    root: toHex(root),
    signature: toHex(signature),
    count: heads.length,
    at: deps.clock.now(),
  };
  await deps.checkpoints.put(checkpoint, options);
  return checkpoint;
}

/**
 * Check a saved checkpoint against the current ledger. Recompute the Merkle root over current
 * heads, compare to the checkpoint's root, then confirm the signature covers that root.
 *
 * The signature check accepts the current signing key plus any still-valid older keys, so a
 * checkpoint signed before a key rotation keeps verifying.
 *
 * Returns false on a normal mismatch: recomputed root differs (ledger changed or tampered),
 * live head count dropped below the recorded count (accounts truncated or deleted), or the
 * signature isn't authentic. Throws only if the stored hex is malformed, meaning the saved row
 * is corrupt rather than verification just failing.
 *
 * The head-count check catches deleted accounts. The root is computed over whatever heads exist
 * now, so if accounts vanished the root reflects the smaller set and a root-only check would
 * still match its shrunken input. A healthy ledger only grows, so fewer heads than recorded is a
 * tamper signal; equal or more is fine.
 */
export async function verifyCheckpoint(
  deps: { ledger: Ledger; digest: Digest; signer: Signer },
  checkpoint: Checkpoint,
): Promise<boolean> {
  let heads = await collectHeadPairs(deps.ledger);
  if (heads.length < checkpoint.count) {
    return false;
  }
  let root = await merkleRoot(deps.digest, heads);
  if (toHex(root) !== checkpoint.root) {
    return false;
  }
  // Decode stored hex back to bytes so the signature is checked over the same root bytes
  // recordCheckpoint signed.
  return deps.signer.verify(
    fromHex(checkpoint.root),
    fromHex(checkpoint.signature),
  );
}

// --- Internals --------------------------------------------------------------------

// Accounts a posting touches, each once, in the order they first appear in the legs. Several
// legs can name the same account; collapsing them advances each account's chain one step, not
// one per leg.
function distinctAccounts(posting: Posting): AccountRef[] {
  let seen = new Set<AccountRef>();
  let order: AccountRef[] = [];
  for (let leg of posting.legs) {
    if (!seen.has(leg.account)) {
      seen.add(leg.account);
      order.push(leg.account);
    }
  }
  return order;
}

// RFC 6962 domain tags: a one-byte prefix that keeps a leaf's preimage out of the internal-node
// domain, so no leaf can ever be reinterpreted as an interior left||right pair (second-preimage
// defense). The two values just have to differ; 0x00 for leaves and 0x01 for nodes is the convention.
const MERKLE_LEAF = 0x00;
const MERKLE_NODE = 0x01;

// Bytes hashed into one Merkle leaf: a 0x00 leaf tag, then "account:head" as UTF-8. The tag pairs
// with the node tag (0x01) so the leaf and node domains never overlap. The ":" still splits the
// parts unambiguously: an account id may contain ":" while a head hash is pure hex, so the joining
// ":" is the one that separates account from head.
function leafPreimage(account: AccountRef, head: string): Uint8Array {
  let body = ENCODER.encode(`${account}:${head}`);
  let out = new Uint8Array(1 + body.length);
  out[0] = MERKLE_LEAF;
  out.set(body, 1);
  return out;
}

// One row of Merkle hashes to the row above it: hash each adjacent pair into one hash. On an odd
// count the last unpaired hash carries up unchanged. Each pair is hashed left-bytes then
// right-bytes, so order matters; a swapped pair changes the root.
async function combineLevel(
  digest: Digest,
  level: ReadonlyArray<Uint8Array>,
): Promise<Uint8Array[]> {
  let next: Uint8Array[] = [];
  for (let i = 0; i < level.length; i += 2) {
    let left = level[i]!;
    let right = level[i + 1];
    next.push(right ? await digest.hash(nodePreimage(left, right)) : left);
  }
  return next;
}

// Internal-node preimage: a 0x01 node tag, then the two child hashes end to end (left, then right).
// The tag pairs with the leaf's 0x00 (RFC 6962) so the two domains never overlap. Both children are
// the same fixed length, so the left/right split stays unambiguous and order matters: a swapped pair
// changes the hash. (Odd levels carry the last child up untagged — see combineLevel.)
function nodePreimage(left: Uint8Array, right: Uint8Array): Uint8Array {
  let out = new Uint8Array(1 + left.length + right.length);
  out[0] = MERKLE_NODE;
  out.set(left, 1);
  out.set(right, 1 + left.length);
  return out;
}

// Drain the ledger's stream of (account, head) pairs into an array. Loading all at once is fine:
// one pair per account, and a checkpoint covers all of them anyway.
async function collectHeadPairs(
  ledger: Ledger,
): Promise<ReadonlyArray<readonly [AccountRef, string]>> {
  let pairs: Array<readonly [AccountRef, string]> = [];
  for await (let pair of ledger.heads()) {
    pairs.push(pair);
  }
  return pairs;
}

let ENCODER: TextEncoder = new TextEncoder();
