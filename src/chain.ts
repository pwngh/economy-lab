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
 * One step in an account's hash chain: the new head after a posting and the head it followed.
 * Each account has its own chain, and its latest head summarizes its whole history.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 * tamper-evidence construction these links and checkpoints implement.
 */
export type ChainLink = {
  account: AccountRef;

  // Head hash before this posting, lowercase hex. For an account's first posting this is the
  // genesis value (64 zeros).
  prevHash: string;

  // Head hash after this posting, lowercase hex.
  hash: string;
};

// The "no previous posting" hash in lowercase hex: 32 zero bytes written as 64 zero chars. This
// matches GENESIS in ledger.ts.
let GENESIS_HEX = '0'.repeat(64);

/**
 * The first broken link the prover finds in an account's chain. Returned instead of a bare
 * boolean so a caller can see which posting failed and how.
 */
export type ChainBreak = {
  account: AccountRef;

  txnId: string;

  // 'broken-link' means the stored "previous head" does not match the head reached by walking the
  // chain so far, so the chain is not continuous. 'tampered-hash' means re-hashing the stored
  // entries and metadata no longer produces the recorded head hash, so the contents were changed
  // after the fact.
  reason: 'broken-link' | 'tampered-hash';

  // The hash that should have been found. For 'broken-link' this is the head reached by walking the
  // chain. For 'tampered-hash' this is the recomputed hash.
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
 * Re-checks every account's chain. It walks each account's postings from genesis, recomputes each
 * head with the write path's hash function, and stops at the first mismatch. Accounts are checked in
 * a fixed order, sorted by id char by char, so a break is reported identically whatever order a
 * runtime or database returns accounts in.
 */
export async function proveChain(
  deps: { ledger: Ledger; digest: Digest },
  options?: Options,
): Promise<ChainReport> {
  // Read every account's head, sorted by account id char by char, so proveChain checks accounts in
  // the same sequence everywhere.
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

// Walks one account's postings in order and checks each link. `prev` is the head reached so far,
// which is the genesis value before the first posting. A link fails if its stored "previous head"
// does not match `prev`, meaning the chain is not continuous, or if re-hashing its contents does not
// reproduce its stored hash, meaning the contents changed. Returns the first failure, or null if the
// account checks out.
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

// Re-hashes one stored posting the way the write path did. It feeds the stored previous head, hex
// decoded back to bytes, plus the entries and metadata through the same hash function. The result
// should equal the recorded head hash. If any entry was altered, it will not.
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
 * Takes a tamper-evident snapshot, called a "checkpoint". It first proves the chain re-derives, then
 * signs the Merkle root over every head and saves it. Proof comes first. On a break this throws a
 * non-retryable CHAIN_BROKEN fault and persists nothing, so a signed root never attests to a tampered
 * ledger, and the caller sets the job aside for an operator rather than retrying. The save goes
 * through the checkpoint store, outside the money transaction, so a rolled-back operation cannot undo
 * an already-recorded checkpoint.
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
 * Checks a saved checkpoint against the current ledger. It recomputes the Merkle root over the
 * current heads, compares it to the stored root, then verifies the signature covers it. The
 * signature check accepts the current key plus still-valid rotated-out keys, so a checkpoint signed
 * before a key rotation keeps verifying.
 *
 * Returns false on a normal mismatch: a changed root, an inauthentic signature, or a live head count
 * below the recorded one. That last check matters because deleting accounts shrinks the set the root
 * covers, so a root-only comparison would still match its smaller input. A healthy ledger only grows,
 * so fewer heads than recorded is itself a tamper signal. Throws only when the stored hex is
 * malformed, which is a corrupt row rather than a failed verification.
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

// Returns the accounts a posting touches, each once, in the order they first appear in the legs.
// Several legs can name the same account, so collapsing them advances each account's chain one step
// rather than one step per leg.
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

// RFC 6962 domain tags (https://datatracker.ietf.org/doc/rfc6962/). Each tag is a one-byte prefix
// that keeps a leaf's preimage out of the internal-node domain, so no leaf can ever be reinterpreted
// as an interior left-then-right pair. This is the second-preimage defense. The two values only have
// to differ. Using 0x00 for leaves and 0x01 for nodes is the convention.
const MERKLE_LEAF = 0x00;
const MERKLE_NODE = 0x01;

// Builds the bytes hashed into one Merkle leaf: a 0x00 leaf tag, then "account:head" as UTF-8. The
// tag pairs with the node tag (0x01) so the leaf and node domains never overlap. The ":" splits the
// parts unambiguously even though an account id may itself contain ":". A head hash is pure hex, so
// the final ":" is always the one that separates account from head.
function leafPreimage(account: AccountRef, head: string): Uint8Array {
  let body = ENCODER.encode(`${account}:${head}`);
  let out = new Uint8Array(1 + body.length);
  out[0] = MERKLE_LEAF;
  out.set(body, 1);
  return out;
}

// Reduces one row of Merkle hashes to the row above it by hashing each adjacent pair into one hash.
// On an odd count the last unpaired hash carries up unchanged. Each pair is hashed left bytes then
// right bytes, so order matters and a swapped pair changes the root.
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

// Builds an internal-node preimage: a 0x01 node tag, then the two child hashes end to end, left then
// right. The tag pairs with the leaf's 0x00 (RFC 6962) so the two domains never overlap. Both
// children are the same fixed length, so the left and right split stays unambiguous and order
// matters: a swapped pair changes the hash. Odd levels carry the last child up untagged; see
// combineLevel.
function nodePreimage(left: Uint8Array, right: Uint8Array): Uint8Array {
  let out = new Uint8Array(1 + left.length + right.length);
  out[0] = MERKLE_NODE;
  out.set(left, 1);
  out.set(right, 1 + left.length);
  return out;
}

// Drains the ledger's stream of (account, head) pairs into an array. Loading all at once is fine
// because there is one pair per account, and a checkpoint covers all of them anyway.
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
