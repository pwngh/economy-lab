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
 * One step in an account's hash chain. Each account's postings are linked together by
 * hashing each posting onto the hash of the one before it; the most recent hash is called
 * that account's "head". This link records the new head after a posting, together with the
 * head it followed. Each account has its own separate chain of these links.
 */
export type ChainLink = {
  account: AccountRef;

  // The account's head hash BEFORE this posting, as lowercase hex. For an account's very
  // first posting this is the genesis value (64 zeros), meaning "nothing came before".
  prevHash: string;

  // The account's head hash AFTER this posting, as lowercase hex.
  hash: string;
};

// The hash that stands in for "no previous posting", as lowercase hex: 32 zero bytes
// written out as 64 zero characters. Matches GENESIS in ledger.ts.
let GENESIS_HEX = '0'.repeat(64);

/**
 * A description of the first broken link the prover finds in an account's chain. The
 * prover returns this rich record (rather than just true/false) so a caller can see
 * exactly which posting failed and how.
 */
export type ChainBreak = {
  account: AccountRef;

  txnId: string;

  // What went wrong:
  // - 'broken-link': this posting's stored "previous head" does not match the head we
  //   reached by walking the chain so far, so the chain is not continuous.
  // - 'tampered-hash': re-hashing this posting's stored entries and metadata no longer
  //   produces the head hash that was recorded, so its contents were changed after the fact.
  reason: 'broken-link' | 'tampered-hash';

  // The hash we expected: the head reached by walking the chain (for 'broken-link') or the
  // freshly recomputed hash (for 'tampered-hash').
  expected: string;

  // The hash actually stored that failed to match `expected`.
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
 * Compute the new head hash for each account a posting touches. This is what the write
 * path calls when appending a posting.
 *
 * A posting has many entries (called legs), and several can name the same account; this
 * produces exactly one new link per distinct account, in the order the accounts first
 * appear. Because each account hashes only its own entries onto its own prior head,
 * different users never share a chain.
 *
 * `prevHeadOf` returns an account's current head hash, or undefined if the account has
 * never been posted to before; either undefined or the genesis value means the new link
 * starts from genesis ("nothing came before").
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
 * Re-check every account's chain: walk each account's postings from the start, recompute
 * the head hash at each step, and stop at the first thing that doesn't add up.
 *
 * Accounts are checked in a fixed order (by comparing their id strings character by
 * character), so the same tampering is always reported the same way regardless of which
 * runtime or database returns the accounts in which order. The recompute uses the very
 * same hashing the write path used, so an untampered ledger always reproduces its stored
 * hashes exactly.
 */
export async function proveChain(
  deps: { ledger: Ledger; digest: Digest },
  options?: Options,
): Promise<ChainReport> {
  // Read every account's head, sorted by account id (character by character, the same on every
  // machine), so proveChain checks accounts in the same sequence everywhere.
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

// Walk one account's postings in order and check each link. `prev` tracks the head hash
// reached so far (the genesis value before the first posting). Two ways a link can fail:
// its stored "previous head" doesn't match `prev` (the chain isn't continuous), or
// re-hashing its contents doesn't reproduce its stored hash (its contents were changed).
// Returns the first failure, or null if the whole account checks out.
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

// Re-hash one stored posting exactly the way the write path did: feed its stored previous
// head (decoded from hex back to bytes) plus its entries and metadata through the same
// hash function. The result should equal the head hash recorded for that posting; if any
// entry was altered after the fact, it won't.
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
 * Reduce every account's head hash down to one single hash that stands for all of them at
 * once. This is a Merkle root: hash each account's head into a "leaf", then repeatedly
 * hash leaves together in pairs until only one hash is left. That final hash changes if
 * any single head changes, so signing it (see `recordCheckpoint`) vouches for every
 * account's chain in one signature.
 *
 * Two rules make the result identical on every machine. First, the leaves are sorted by
 * comparing account id strings character by character (a fixed order, unlike a
 * locale-sensitive sort). Second, the building blocks are pinned: each leaf is the hash of
 * `account + ":" + head`, and each pair of hashes is combined by hashing the two joined
 * left-then-right (so swapping the order would change the result). With no accounts at
 * all, the root is the genesis value (32 zero bytes), so even a brand-new ledger has a
 * stable hash to sign.
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
 * Take a tamper-evident snapshot of the whole ledger right now: prove the chain re-derives,
 * then collect every account's head hash, reduce them to one Merkle root (see `merkleRoot`),
 * sign that root, and save the signed snapshot (a "checkpoint").
 *
 * The proof must come first: signing the root attests that the ledger is intact, so it would
 * be a false attestation to sign over a chain whose stored hashes no longer re-derive from
 * their postings. So before building anything, `proveChain` re-walks every account; if it
 * finds a break, this throws a non-retryable CHAIN_BROKEN fault and persists no checkpoint
 * (the caller treats a non-retryable fault as a dead end: it does not retry, and sets the
 * job aside for an operator to investigate rather than failing silently).
 *
 * The save goes through the checkpoint store, which is deliberately separate from the
 * database transaction that posts money. So if a money operation is rolled back, an
 * already-recorded checkpoint is not undone with it.
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
 * Check a saved checkpoint against the ledger as it stands now. Recompute the Merkle root
 * over the current account heads and compare it to the one in the checkpoint, then confirm
 * the checkpoint's signature really covers that root.
 *
 * The signature check accepts the current signing key plus any still-valid older keys, so
 * a checkpoint signed before a key rotation keeps verifying afterward.
 *
 * Returns false on a normal "doesn't match" outcome: the recomputed root differs (the
 * ledger has changed or been tampered with), the live head count dropped below the count
 * recorded in the checkpoint (accounts were truncated or deleted), or the signature isn't
 * authentic. It throws
 * only if the stored hex itself is malformed, which means the saved row is corrupt rather
 * than that verification simply failed.
 *
 * The head-count check exists to catch deleted accounts. The root is computed over whatever
 * heads exist now, so if accounts vanished the root simply reflects the smaller set and a
 * root-only check would still match its own (shrunken) input. Comparing the live head count
 * against the count recorded in the checkpoint catches that deletion — a healthy ledger only
 * ever grows, so fewer heads than were recorded is a tamper signal, while equal or more is fine.
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
  // Decode the stored hex back to bytes so the signature is checked over the exact same
  // root bytes that recordCheckpoint signed.
  return deps.signer.verify(
    fromHex(checkpoint.root),
    fromHex(checkpoint.signature),
  );
}

// --- Internals --------------------------------------------------------------------

// List the accounts a posting touches, each once, in the order they first appear in the
// posting's entries (legs). One posting can have several entries on the same account; this
// collapses those so each account advances its chain by a single step, not one per entry.
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

// Build the bytes that get hashed into one Merkle leaf: the text "account:head" encoded as
// UTF-8. There's no length marker between the two parts, but they still can't run together
// ambiguously, because an account id uses ":" only inside itself and a head hash is pure
// hex digits, so the joining ":" is always the one that splits account from head.
function leafPreimage(account: AccountRef, head: string): Uint8Array {
  return ENCODER.encode(`${account}:${head}`);
}

// Take one row of hashes in the Merkle tree and produce the row above it: hash each
// adjacent pair together into a single hash. If the row has an odd count, the last,
// unpaired hash is carried up unchanged. Each pair is hashed as left-bytes followed by
// right-bytes, so order matters and a swapped pair would change the final root.
async function combineLevel(
  digest: Digest,
  level: ReadonlyArray<Uint8Array>,
): Promise<Uint8Array[]> {
  let next: Uint8Array[] = [];
  for (let i = 0; i < level.length; i += 2) {
    let left = level[i]!;
    let right = level[i + 1];
    next.push(right ? await digest.hash(concat(left, right)) : left);
  }
  return next;
}

// Join two hashes end to end (left, then right) into one byte array for the pair-hash
// above. Both inputs are hashes of the same fixed length, so there's no ambiguity about
// where one ends and the other begins.
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  let out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

// Drain the ledger's stream of (account, head) pairs into a plain array. Loading them all
// at once is fine here: the number of pairs is just the number of accounts, and a
// checkpoint is meant to cover all of them anyway.
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
