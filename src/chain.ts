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

import { GENESIS, GENESIS_HEX, chainHash } from '#src/ledger.ts';
import { toHex, fromHex, byCodeUnit, toInt64BE } from '#src/bytes.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';

import type { AccountRef } from '#src/accounts.ts';
import type {
  ArchiveHead,
  ArchiveState,
  Checkpoint,
  CheckpointStore,
  Digest,
  Ids,
  Clock,
  Ledger,
  CallOptions,
  Posting,
  SealHead,
  Signer,
  StoredLink,
} from '#src/ports.ts';

/**
 * One step in an account's hash chain. It holds the new head after a posting and the head it
 * followed. Each account has its own chain, and its latest head summarizes its whole history.
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
 * The first broken link the prover finds in an account's chain. The prover returns this instead
 * of a bare boolean so a caller can see which posting failed and how.
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
 * own prior head, so chains never cross. `prevHeadOf` returns an account's current head. An
 * undefined result or the genesis value starts a fresh chain.
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
 * head with the write path's hash function, and stops at the first mismatch. It checks accounts in
 * a fixed order, sorted by id char by char, so a break is reported identically whatever order a
 * runtime or database returns accounts in.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 *   re-derivation this proves and what a break means.
 */
export async function proveChain(
  deps: {
    ledger: Ledger;
    digest: Digest;
    /** The verified archival boundary. Absent or null means nothing has been archived. */
    boundary?: ArchiveBoundary | null;
  },
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

// `prev` is the head reached so far — the genesis value before the first posting. An account named by the
// verified archival boundary walks anchored instead. Its remaining chain can start at the
// signed archive head, which is the clean cut. It can start at genesis, the crash window where
// the boundary postings are signed but not yet deleted. After a crash between the boundary
// signature and the delete, it can start below the signed head. In that case the start floats,
// and the signed head must appear as a hash inside the walk. Content re-derivation applies to
// every link in every case. A named account whose signed head never appears is truncated or
// tampered and reports broken.
async function recomputeAccount(
  deps: {
    ledger: Ledger;
    digest: Digest;
    boundary?: ArchiveBoundary | null;
  },
  account: AccountRef,
  options?: CallOptions,
): Promise<ChainBreak | null> {
  const anchor = deps.boundary?.anchors.get(account);
  let prev = GENESIS_HEX;
  let anchorSeen = anchor === undefined;
  let first = true;
  for await (const link of deps.ledger.lineage(account, options)) {
    if (first && anchor !== undefined && link.prevHash === anchor) {
      prev = anchor;
      anchorSeen = true;
    }
    if (link.prevHash !== prev) {
      if (!first || anchor === undefined) {
        return {
          account,
          txnId: link.txnId,
          reason: 'broken-link',
          expected: prev,
          actual: link.prevHash,
        };
      }
      // This is the crash-window float. The walk vouches for the start only if the signed head shows up later.
      prev = link.prevHash;
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
    if (link.hash === anchor) {
      anchorSeen = true;
    }
    first = false;
  }
  if (!anchorSeen && !first) {
    return {
      account,
      txnId: '',
      reason: 'broken-link',
      expected: anchor!,
      actual: prev,
    };
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
 * Loads a posting and proves its stored content against its own chain links before returning it.
 * This is the read every handler that derives money from history must use. It recomputes each
 * touched account's link hash from the stored legs and metadata, both inside the preimage. An
 * in-place edit therefore faults CHAIN_BROKEN here instead of shaping a reversal. The zero-sum
 * check catches a leg deleted together with its link. One thing is deliberately left unproven:
 * an attacker who re-derives an account's whole chain moves its head. The next seal flags that
 * head as dirty and breaks on it, so that variant is bounded by seal cadence. Restoring the head
 * exactly requires a hash collision. Null on an unknown id, exactly like {@link Ledger.posting}.
 */
export async function verifiedPosting(
  deps: { ledger: Ledger; digest: Digest },
  txnId: string,
  options?: CallOptions,
): Promise<Posting | null> {
  const posting = await deps.ledger.posting(txnId, options);
  if (posting === null) {
    return null;
  }
  const links = new Map(
    (await deps.ledger.links(txnId, options)).map((link) => [
      link.account,
      link,
    ]),
  );
  for (const account of new Set(posting.legs.map((leg) => leg.account))) {
    const link = links.get(account);
    const recomputed =
      link === undefined
        ? null
        : await chainHash(deps.digest, {
            accountPrevHash: fromHex(link.prevHash),
            txnId,
            account,
            legs: posting.legs,
            meta: posting.meta,
          });
    if (recomputed === null || recomputed !== link!.hash) {
      throw fault(
        ERROR_CODES.CHAIN_BROKEN,
        'A stored posting failed to re-derive against its chain links; refusing to derive money from tampered history.',
        { retryable: false, detail: { txnId, account } },
      );
    }
  }
  assertZeroSum(posting);
  return posting;
}

// Every honestly posted entry nets to zero per currency. A nonzero total here means a leg was
// removed together with its account's link. That is the one in-place edit the per-link recompute
// alone cannot see.
function assertZeroSum(posting: Posting): void {
  const sums = new Map<string, bigint>();
  for (const leg of posting.legs) {
    sums.set(
      leg.amount.currency,
      (sums.get(leg.amount.currency) ?? 0n) + leg.amount.minor,
    );
  }
  for (const [currency, sum] of sums) {
    if (sum !== 0n) {
      throw fault(
        ERROR_CODES.CHAIN_BROKEN,
        'A stored posting no longer nets to zero; refusing to derive money from tampered history.',
        {
          retryable: false,
          detail: { txnId: posting.txnId, currency, sum: sum.toString() },
        },
      );
    }
  }
}

/**
 * Re-derives each link's hash from its stored content and checks that the links given chain —
 * the page check both the rolling re-proof and the archival mover run.
 *
 * Content and continuity are different failures and a page needs both: re-deriving a hash
 * catches an edit, and only continuity catches a deletion, because every link either side of a
 * deleted one still re-derives perfectly from its own content. Links arrive in commit order, so
 * consecutive links of one account must join, and that comparison is free. The first link of an
 * account in the page has its predecessor outside the page, and `resolvePrev` is what answers
 * for it: true when the named predecessor is this link's own, either in the live rows or as the
 * archive anchor a signed boundary cut the chain at. A caller that has already held those links
 * against its own anchor, as `worker/archive.ts` does, passes nothing and keeps the check in-page.
 */
export async function reproveLinks(
  digest: Digest,
  links: ReadonlyArray<{ account: AccountRef } & StoredLink>,
  resolvePrev?: (
    link: { account: AccountRef } & StoredLink,
  ) => Promise<boolean>,
): Promise<ChainBreak | null> {
  const tail = new Map<AccountRef, string>();
  for (const link of links) {
    const prev = tail.get(link.account);
    if (prev === undefined) {
      if (
        link.prevHash !== GENESIS_HEX &&
        resolvePrev !== undefined &&
        !(await resolvePrev(link))
      ) {
        return {
          account: link.account,
          txnId: link.txnId,
          reason: 'broken-link',
          expected: link.prevHash,
          actual: '',
        };
      }
    } else if (link.prevHash !== prev) {
      return {
        account: link.account,
        txnId: link.txnId,
        reason: 'broken-link',
        expected: prev,
        actual: link.prevHash,
      };
    }
    const recomputed = await recomputeLink(digest, link.account, link);
    if (recomputed !== link.hash) {
      return {
        account: link.account,
        txnId: link.txnId,
        reason: 'tampered-hash',
        expected: recomputed,
        actual: link.hash,
      };
    }
    tail.set(link.account, link.hash);
  }
  return null;
}

/**
 * Reduces every account's head into one Merkle root, so signing the root (see `recordCheckpoint`)
 * covers every chain in one signature. The root changes if any head changes. The root is
 * reproducible across machines. The leaves sort by account id, each level applies the RFC 6962
 * domain tags (`MERKLE_LEAF` and `MERKLE_NODE`), and each pair hashes left then right, so order
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
 * Reduces every account's (head, sum) pair into one sum-carrying Merkle root. Each node holds its
 * subtree's balance sum, and each node's hash commits to both child hashes plus that sum. The
 * root hash therefore fixes every head and every sum at once, and the root sum is as
 * tamper-evident as the root hash. `sum` per leaf is the account's raw signed leg total (debit
 * positive). That is why a consistent ledger's root sums to zero: legs net to zero per currency,
 * so they net to zero in total. The root is reproducible across machines the same way
 * `merkleRoot` is, with versioned domain tags and the sum encoded as fixed-width big-endian
 * bytes (`toInt64BE`), never as formatted text. With no
 * accounts the root is the genesis value of 32 zero bytes and a zero sum.
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
      // On an odd count the last unpaired node carries up unchanged (same rule as combineLevel), sum included.
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
 * Takes a tamper-evident snapshot, called a "checkpoint". It first proves the chain re-derives,
 * then signs the sum-carrying Merkle root (v2) over every head and saves it. The proof runs from
 * genesis, or covers only the dirty tails since the previous seal when the store carries that
 * seal's authenticated leaves. On a break this throws a
 * non-retryable CHAIN_BROKEN fault and persists nothing, and the caller sets the job aside for
 * an operator rather than retrying.
 *
 * What a signed root attests to on the incremental path is bounded, and this is the bound: the
 * previous signature covers each account's head and leg sum together, so the seal re-proves
 * every account whose head or sum has moved since — including one with no traffic at all, whose
 * sum can only have moved through an edit. An edit that moves neither, such as one to a
 * posting's metadata or a pair of leg edits cancelling inside one account, is not visible here
 * and is caught by the rolling re-proof (`worker/reproof.ts`) within one rotation. A full replay
 * from genesis, which every seal on a store without authenticated seal heads runs, has no such
 * bound.
 * It also refuses to sign when the collected sums do not net to zero, with a non-retryable
 * LEDGER_UNBALANCED fault. The chain hashes cover every leg, so an edit breaks CHAIN_BROKEN
 * first. A nonzero total with intact chains means the write path itself recorded unbalanced
 * money — exactly the enforcement bug this last-resort check exists to catch. The signature
 * covers the root hash and the root sum together, so no one can edit either stored field under
 * a valid signature. The save
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
  // A pruned ledger's live sums miss the archived history. The verified boundary folds it back
  // (mergeArchiveSums), so the sealed leaves always carry full-history sums and the root still
  // nets to zero. A boundary that fails its signature faults here, before anything signs.
  const boundary = await loadArchiveBoundary(deps.checkpoints, deps, options);
  const leaves = mergeArchiveSums(
    await collectHeadSums(deps.ledger, options),
    boundary,
  );

  // The incremental strategy works like this. When the store carries an authenticated snapshot
  // of the last seal's leaves, only the accounts whose heads moved since then need their chain
  // tails re-proved. The previous signature already vouches for everything else. Any doubt about
  // the snapshot falls back to the full from-genesis replay, so the seal is never weaker for
  // having the fast path.
  const plan = await planSeal(deps, leaves, options);
  const broken =
    plan.mode === 'incremental'
      ? await proveDirtyTails(
          { ledger: deps.ledger, digest: deps.digest, boundary },
          plan,
          options,
        )
      : (
          await proveChain(
            { ledger: deps.ledger, digest: deps.digest, boundary },
            options,
          )
        ).firstBreak;
  if (broken !== null) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'The hash chain failed to re-derive; refusing to sign a checkpoint over a tampered ledger.',
      { retryable: false, detail: { firstBreak: broken } },
    );
  }
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
  // This write runs after the checkpoint. A crash between the two then leaves a stale snapshot,
  // which fails the next seal's authentication and heals through the full-replay path. The
  // incremental path upserts only the dirty leaves. The full path replaces the whole table,
  // purging any stray row a corruption left behind.
  if (deps.checkpoints.putSealHeads !== undefined) {
    await deps.checkpoints.putSealHeads(
      plan.mode === 'incremental' ? plan.dirty : leaves,
      plan.mode === 'incremental' ? options : { ...options, replaceAll: true },
    );
  }
  return checkpoint;
}

// This records what planSeal decided: which leaves changed since the authenticated snapshot, and
// the sealed (head, sum) pair each dirty account's replay is held against. The pair is absent
// for an account new since the seal.
type SealPlan =
  | { mode: 'full' }
  | {
      mode: 'incremental';
      dirty: ReadonlyArray<SealHead>;
      since: ReadonlyMap<AccountRef, { head: string; sum: bigint }>;
    };

// Chooses the seal strategy. The snapshot lives in the same database an attacker who can rewrite
// the ledger controls. So the seal trusts nothing in it until its recomputed Merkle root and sum
// match the latest checkpoint and that checkpoint's signature verifies. A snapshot account
// missing from the live leaves is truncation and fails the seal loudly rather than falling back.
async function planSeal(
  deps: {
    checkpoints: CheckpointStore;
    digest: Digest;
    signer: Signer;
  },
  liveLeaves: ReadonlyArray<SealHead>,
  options?: CallOptions,
): Promise<SealPlan> {
  if (
    deps.checkpoints.sealHeads === undefined ||
    deps.checkpoints.putSealHeads === undefined
  ) {
    return { mode: 'full' };
  }
  const snapshot = await deps.checkpoints.sealHeads(options);
  const latest = await deps.checkpoints.latest(options);
  if (
    snapshot.length === 0 ||
    latest === null ||
    latest.v !== 2 ||
    latest.sum === null
  ) {
    return { mode: 'full' };
  }
  const root = await merkleSumRoot(deps.digest, snapshot);
  if (
    toHex(root.hash) !== latest.root ||
    root.sum.toString() !== latest.sum ||
    !(await deps.signer.verify(sumRootPayload(root), fromHex(latest.signature)))
  ) {
    return { mode: 'full' };
  }

  const since = new Map<AccountRef, { head: string; sum: bigint }>();
  for (const [account, head, sum] of snapshot) {
    since.set(account, { head, sum });
  }
  const live = new Set(liveLeaves.map(([account]) => account));
  for (const account of since.keys()) {
    if (!live.has(account)) {
      throw fault(
        ERROR_CODES.CHAIN_BROKEN,
        'A sealed account has vanished from the live heads; refusing to sign over a truncated ledger.',
        { retryable: false, detail: { account } },
      );
    }
  }
  // The previous signature covers each account's head and its leg sum together, so both have to
  // still hold for the account to count as vouched for. Diffing heads alone leaves an edit that
  // moved money on an account with no traffic since the seal looking clean.
  return {
    mode: 'incremental',
    dirty: liveLeaves.filter(([account, head, sum]) => {
      const sealed = since.get(account);
      return sealed === undefined || sealed.head !== head || sealed.sum !== sum;
    }),
    since,
  };
}

// Replays each dirty account's chain from its sealed head instead of genesis. The walk must pass
// through the head the leaves were read at. Reaching it proves the tail links continuously from
// sealed history to the head being signed. Links appended by concurrent postings beyond it are
// simply verified too. A walk that never reaches it means the tail is broken or truncated.
async function proveDirtyTails(
  deps: { ledger: Ledger; digest: Digest; boundary?: ArchiveBoundary | null },
  plan: Extract<SealPlan, { mode: 'incremental' }>,
  options?: CallOptions,
): Promise<ChainBreak | null> {
  for (const [account, liveHead] of plan.dirty) {
    const sealed = plan.since.get(account);
    // A leaf dirtied with its head still where the last seal left it: the stored legs moved
    // under a fixed head, which appending cannot do. There is no tail to walk, so this replays
    // the whole chain the way the full prover walks it — archive anchor, crash window and all —
    // and the break it returns names the edited link rather than the missing tail.
    if (sealed !== undefined && sealed.head === liveHead) {
      const broken = await recomputeAccount(deps, account, options);
      if (broken !== null) {
        return broken;
      }
      continue;
    }
    const sinceHash = sealed?.head;
    let walk = await walkTail(deps, {
      account,
      start: sinceHash ?? GENESIS_HEX,
      liveHead,
      links: deps.ledger.lineage(account, {
        ...options,
        ...(sinceHash === undefined ? {} : { sinceHash }),
      }),
    });
    if (walk.broken !== null) {
      return walk.broken;
    }
    if (!walk.reached && !walk.yielded && sinceHash !== undefined) {
      // The anchor row was archived away. Archival prunes a strict prefix, so the live
      // remainder must chain directly from the anchor hash; walk it from the start and
      // require exactly that.
      walk = await walkTail(deps, {
        account,
        start: sinceHash,
        liveHead,
        links: deps.ledger.lineage(account, options),
      });
      if (walk.broken !== null) {
        return walk.broken;
      }
    }
    if (!walk.reached) {
      return {
        account,
        txnId: '',
        reason: 'broken-link',
        expected: liveHead,
        actual: walk.prev,
      };
    }
  }
  return null;
}

// One dirty-tail walk: every link must chain from `prev` and re-derive its hash; `reached`
// records whether the walk arrived at the live head. `delta` sums the account's legs as far as
// that head and no further, so a posting landing mid-walk cannot inflate it past the head sum it
// will be held against.
async function walkTail(
  deps: { ledger: Ledger; digest: Digest },
  tail: {
    account: AccountRef;
    start: string;
    liveHead: string;
    links: AsyncIterable<StoredLink>;
  },
): Promise<{
  broken: ChainBreak | null;
  prev: string;
  reached: boolean;
  yielded: boolean;
  delta: bigint;
}> {
  const { account, start, liveHead, links } = tail;
  let prev = start;
  let reached = false;
  let yielded = false;
  let delta = 0n;
  for await (const link of links) {
    yielded = true;
    if (link.prevHash !== prev) {
      return {
        broken: {
          account,
          txnId: link.txnId,
          reason: 'broken-link',
          expected: prev,
          actual: link.prevHash,
        },
        prev,
        reached,
        yielded,
        delta,
      };
    }
    const recomputed = await recomputeLink(deps.digest, account, link);
    if (recomputed !== link.hash) {
      return {
        broken: {
          account,
          txnId: link.txnId,
          reason: 'tampered-hash',
          expected: recomputed,
          actual: link.hash,
        },
        prev,
        reached,
        yielded,
        delta,
      };
    }
    if (!reached) {
      for (const leg of link.legs) {
        if (leg.account === account) {
          delta += leg.amount.minor;
        }
      }
    }
    prev = link.hash;
    if (prev === liveHead) {
      reached = true;
    }
  }
  return { broken: null, prev, reached, yielded, delta };
}

/**
 * Checks a saved checkpoint against the current ledger. It recomputes the root the same way the
 * checkpoint's version sealed it (hash-only over heads for v1, sum-carrying over heads and sums
 * for v2), compares it to the stored root, then verifies the signature. The signature check
 * accepts still-valid rotated-out keys, so a checkpoint signed before a rotation keeps
 * verifying. Rows from before
 * versioning verify forever down the v1 path, byte for byte. Returns false on a normal mismatch.
 * A live head count below the recorded one is one such mismatch, since deleting accounts to
 * shrink the root's coverage is itself tampering. On v2 an edited stored sum is another,
 * since the signature covers the sum. Throws only on malformed stored hex, which is a corrupt
 * row, not a failed verification.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for why fewer
 * heads than recorded is itself a tamper signal.
 */
export async function verifyCheckpoint(
  deps: {
    ledger: Ledger;
    digest: Digest;
    signer: Signer;
    /** The verified archival boundary; a seal over an archived prefix covers merged sums. */
    boundary?: ArchiveBoundary | null;
  },
  checkpoint: Checkpoint,
): Promise<boolean> {
  if (checkpoint.v === 2) {
    const leaves = mergeArchiveSums(
      await collectHeadSums(deps.ledger),
      deps.boundary ?? null,
    );
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

/** What a sealed-history audit concluded. See {@link verifySealedHistory}. */
export type SealedVerdict = 'agrees' | 'diverged' | 'unverifiable';

/**
 * Audits stored history against a sealed checkpoint, tolerating growth. {@link verifyCheckpoint}
 * asks whether the ledger reproduces the sealed root *right now*, which is true only of a ledger
 * that has not moved since the seal; this asks the auditor's question instead — has anything the
 * seal already covered changed. Postings appended since are expected and read clean.
 *
 * The evidence is the sealed-head snapshot the incremental seal maintains. Every sealed account
 * must still be there, its chain must still run from the sealed head to the live one with each
 * tail link re-deriving its hash, and its sealed sum plus that tail's legs must equal its live
 * sum — which is what catches an in-place edit that leaves the recorded hashes alone.
 *
 * `unverifiable` is not a clean bill of health: it means the evidence to answer is absent — no
 * snapshot on this store, a row sealed under v1, or a snapshot left stale by a crash between the
 * two writes a seal makes. A caller that reports it as agreement has a silent auditor.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 * hash chain these leaves anchor.
 */
export async function verifySealedHistory(
  deps: {
    ledger: Ledger;
    checkpoints: CheckpointStore;
    digest: Digest;
    signer: Signer;
  },
  checkpoint: Checkpoint,
  options?: CallOptions,
): Promise<SealedVerdict> {
  if (checkpoint.v !== 2 || checkpoint.sum === null) {
    return 'unverifiable';
  }
  // The row is authenticated on its own first, so an edited checkpoint reads as tamper rather
  // than as the stale snapshot it would otherwise look like below.
  const signed = await deps.signer.verify(
    sumRootPayload({
      hash: fromHex(checkpoint.root),
      sum: BigInt(checkpoint.sum),
    }),
    fromHex(checkpoint.signature),
  );
  if (!signed) {
    return 'diverged';
  }
  if (deps.checkpoints.sealHeads === undefined) {
    return 'unverifiable';
  }
  const sealed = await deps.checkpoints.sealHeads(options);
  if (sealed.length === 0) {
    return 'unverifiable';
  }
  const root = await merkleSumRoot(deps.digest, sealed);
  // The snapshot is written after the checkpoint, so a crash between the two leaves it holding
  // the previous seal's leaves. It cannot answer for this row; the next seal rewrites it.
  if (
    toHex(root.hash) !== checkpoint.root ||
    root.sum !== BigInt(checkpoint.sum)
  ) {
    return 'unverifiable';
  }
  return reconcileSealedLeaves(deps, sealed, options);
}

// Holds every sealed leaf against the live ledger. The sealed sums already carry archived
// history (the seal merges the boundary before signing), so the live side merges it too.
async function reconcileSealedLeaves(
  deps: {
    ledger: Ledger;
    checkpoints: CheckpointStore;
    digest: Digest;
    signer: Signer;
  },
  sealed: ReadonlyArray<SealHead>,
  options?: CallOptions,
): Promise<SealedVerdict> {
  const boundary = await loadArchiveBoundary(deps.checkpoints, deps, options);
  const live = new Map<AccountRef, readonly [string, bigint]>();
  for (const [account, head, sum] of mergeArchiveSums(
    await collectHeadSums(deps.ledger, options),
    boundary,
  )) {
    live.set(account, [head, sum]);
  }

  for (const [account, sealedHead, sealedSum] of sealed) {
    const now = live.get(account);
    // Deleting a sealed account shrinks what the root covers, which is itself tampering.
    if (now === undefined) {
      return 'diverged';
    }
    const [liveHead, liveSum] = now;
    if (liveHead === sealedHead) {
      // A still head cannot have moved its own sum; an edit under the seal is the only way.
      if (liveSum !== sealedSum) {
        return 'diverged';
      }
      continue;
    }
    const appended = await walkFromSealedHead(
      deps,
      { account, sealedHead, liveHead },
      options,
    );
    if (appended === null || sealedSum + appended !== liveSum) {
      return 'diverged';
    }
  }
  return 'agrees';
}

// The account's leg delta from the sealed head to the live one, or null when that tail is
// broken, truncated, or never arrives at the head it should.
async function walkFromSealedHead(
  deps: { ledger: Ledger; digest: Digest },
  tail: { account: AccountRef; sealedHead: string; liveHead: string },
  options?: CallOptions,
): Promise<bigint | null> {
  const { account, sealedHead, liveHead } = tail;
  let walk = await walkTail(deps, {
    account,
    start: sealedHead,
    liveHead,
    links: deps.ledger.lineage(account, { ...options, sinceHash: sealedHead }),
  });
  if (walk.broken === null && !walk.reached && !walk.yielded) {
    // The anchor row was archived away, so the live remainder must chain straight from it —
    // the same fallback the incremental seal takes.
    walk = await walkTail(deps, {
      account,
      start: sealedHead,
      liveHead,
      links: deps.ledger.lineage(account, options),
    });
  }
  return walk.broken === null && walk.reached ? walk.delta : null;
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

// These are the RFC 6962 domain tags (https://datatracker.ietf.org/doc/rfc6962/). A one-byte
// prefix keeps a leaf's preimage out of the internal-node domain, so no leaf can be
// reinterpreted as an interior pair. That is the second-preimage defense.
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

// The preimage is the 0x01 tag, then the child hashes left then right. Both children are the same
// fixed length, so the split needs no separator.
function nodePreimage(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + left.length + right.length);
  out[0] = MERKLE_NODE;
  out.set(left, 1);
  out.set(right, 1 + left.length);
  return out;
}

// These are the v2 domain tags. They take new values rather than reusing 0x00/0x01, so a v2
// preimage can never collide with a v1 preimage of the same account and head. The two
// constructions hash into disjoint domains, and old checkpoints keep verifying under the old
// tags forever.
const MERKLE_SUM_LEAF = 0x02;
const MERKLE_SUM_NODE = 0x03;

// The preimage is the 0x02 tag, "account:head:" as UTF-8, then the sum as 8 big-endian bytes.
// Fixed-width binary, not decimal text, keeps the same sum the same bytes on every runtime.
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

// --- The archival boundary --------------------------------------------------------

/** Domain tag for archive-head signatures, so they can never pass as checkpoint signatures. */
const ARCHIVE_DOMAIN = new TextEncoder().encode('economy-lab:archive-heads:v1');

/** The archive-head signing payload: the domain tag then the v2 root encoding. */
export function archivePayload(root: {
  hash: Uint8Array;
  sum: bigint;
}): Uint8Array {
  const body = sumRootPayload(root);
  const out = new Uint8Array(ARCHIVE_DOMAIN.length + body.length);
  out.set(ARCHIVE_DOMAIN, 0);
  out.set(body, ARCHIVE_DOMAIN.length);
  return out;
}

export async function verifyArchiveHeads(
  deps: { digest: Digest; signer: Signer },
  heads: ReadonlyArray<ArchiveHead>,
  state: ArchiveState,
): Promise<boolean> {
  const root = await merkleSumRoot(
    deps.digest,
    heads.map((row) => [row.account, row.head, row.sum] as const),
  );
  if (toHex(root.hash) !== state.root) {
    return false;
  }
  return deps.signer.verify(archivePayload(root), fromHex(state.signature));
}

/**
 * The verified archival boundary the provers and the seal anchor on. It holds per-account
 * archived head hashes and raw leg sums. They are trusted only because their recomputed root
 * matches the signed
 * {@link ArchiveState}. Null when nothing has ever been archived.
 */
export type ArchiveBoundary = {
  anchors: ReadonlyMap<AccountRef, string>;
  rawSums: ReadonlyMap<AccountRef, bigint>;
  state: ArchiveState;
};

/**
 * Loads and authenticates the archival boundary. Faults CHAIN_BROKEN when the stored rows fail
 * their signature. An unauthenticated boundary is an anchor an attacker can move, so every
 * prover and seal refuses to proceed over one.
 */
export async function loadArchiveBoundary(
  checkpoints: CheckpointStore,
  deps: { digest: Digest; signer: Signer },
  options?: CallOptions,
): Promise<ArchiveBoundary | null> {
  if (
    checkpoints.archiveState === undefined ||
    checkpoints.archiveHeads === undefined
  ) {
    return null;
  }
  const state = await checkpoints.archiveState(options);
  if (state === null) {
    return null;
  }
  const rows = await checkpoints.archiveHeads(options);
  if (!(await verifyArchiveHeads(deps, rows, state))) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'The archive heads failed authentication against their signed root; refusing to prove or seal over a tampered boundary.',
      { retryable: false },
    );
  }
  const anchors = new Map<AccountRef, string>();
  const rawSums = new Map<AccountRef, bigint>();
  for (const row of rows) {
    anchors.set(row.account, row.head);
    rawSums.set(row.account, row.sum);
  }
  return { anchors, rawSums, state };
}

// Folds the archived raw sums back into the live leaves, so a seal over a pruned ledger still
// covers every account's full-history sum (and still nets to zero). Live accounts gain their
// archived portion. Fully-pruned accounts re-enter with the archived head as their true head.
function mergeArchiveSums(
  live: ReadonlyArray<readonly [AccountRef, string, bigint]>,
  boundary: ArchiveBoundary | null,
): ReadonlyArray<readonly [AccountRef, string, bigint]> {
  if (boundary === null) {
    return live;
  }
  const seen = new Set<AccountRef>();
  const merged: Array<readonly [AccountRef, string, bigint]> = live.map(
    ([account, head, sum]) => {
      seen.add(account);
      const archived = boundary.rawSums.get(account) ?? 0n;
      return [account, head, sum + archived] as const;
    },
  );
  for (const [account, sum] of boundary.rawSums) {
    if (!seen.has(account)) {
      merged.push([account, boundary.anchors.get(account)!, sum] as const);
    }
  }
  return merged;
}

/** The v2 signing payload: root hash then the 8-byte big-endian sum. Exported for the archival
 * mover, whose archive-head signatures reuse this encoding under their own domain tag. */
export function sumRootPayload(root: {
  hash: Uint8Array;
  sum: bigint;
}): Uint8Array {
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
