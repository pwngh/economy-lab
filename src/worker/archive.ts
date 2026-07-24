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

// Moves the oldest postings to a host-provided cold store (the ArchiveSink) and deletes them
// from hot storage without weakening a proof: the mover signs its own progress — per-account
// archive heads sealed under a Merkle sum-root — so the pruned edge stays verifiable at every
// instant, including after a crash mid-page. Only history a signed checkpoint already covers
// moves, gated by `checkpointOlderThanMs`: a strict prefix in commit order, re-derived from
// stored content and checked against the signed heads before anything is copied or deleted.

import {
  archivePayload,
  merkleSumRoot,
  reproveLinks,
  sumRootPayload,
  verifyArchiveHeads,
} from '#src/chain.ts';
import { GENESIS_HEX } from '#src/ledger.ts';

export { verifyArchiveHeads } from '#src/chain.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { toHex, fromHex } from '#src/bytes.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { StoredLink } from '#src/ports.ts';
import type {
  ArchivedPosting,
  ArchiveHead,
  ArchiveSink,
  ArchiveState,
  CallOptions,
  Checkpoint,
  Store,
} from '#src/ports.ts';
import type { WorkerCtx } from '#src/contract.ts';

export interface ArchiveSweepInput {
  /** The cold store pages are copied into before any delete. */
  sink: ArchiveSink;
  /**
   * Only history sealed by a checkpoint at least this old moves. Must exceed every refund and
   * dispute window the deployment honors: archived history reads as absent, and money paths
   * that need it reject rather than move.
   */
  checkpointOlderThanMs: number;
  /** Postings per page (one sink put + one prune transaction each). */
  limit: number;
  now: number;
}

export interface ArchiveSummary {
  /** Postings moved this run. */
  moved: number;
  /** The watermark after this run; null when nothing has ever been archived. */
  throughSeq: number | null;
  /** True when the run consumed the whole eligible prefix. */
  finished: boolean;
  /** Set when the store lacks the archival surfaces. */
  skipped?: true;
  /** The stated fact behind a skipped or early-stopped run. */
  reason?: string;
}

type ArchiveSurfaces = {
  archivePage: NonNullable<Store['ledger']['archivePage']>;
  prune: NonNullable<Store['ledger']['prune']>;
  archiveState: NonNullable<Store['checkpoints']['archiveState']>;
  archiveHeads: NonNullable<Store['checkpoints']['archiveHeads']>;
  putArchiveBoundary: NonNullable<Store['checkpoints']['putArchiveBoundary']>;
  sealHeads: NonNullable<Store['checkpoints']['sealHeads']>;
};

function surfacesOf(store: Store): ArchiveSurfaces | null {
  const { ledger, checkpoints } = store;
  if (
    ledger.archivePage === undefined ||
    ledger.prune === undefined ||
    checkpoints.archiveState === undefined ||
    checkpoints.archiveHeads === undefined ||
    checkpoints.putArchiveBoundary === undefined ||
    checkpoints.sealHeads === undefined
  ) {
    return null;
  }
  return {
    archivePage: ledger.archivePage.bind(ledger),
    prune: ledger.prune.bind(ledger),
    archiveState: checkpoints.archiveState.bind(checkpoints),
    archiveHeads: checkpoints.archiveHeads.bind(checkpoints),
    putArchiveBoundary: checkpoints.putArchiveBoundary.bind(checkpoints),
    sealHeads: checkpoints.sealHeads.bind(checkpoints),
  };
}

// Authenticates the seal-head snapshot against the signed checkpoint, exactly as the
// incremental seal does: recompute the sum-root over the snapshot and verify the signature.
// The snapshot lives in the same database an attacker who can rewrite the ledger controls, so
// nothing here is trusted until the signature says so.
async function authenticateSeal(
  ctx: Pick<WorkerCtx, 'digest' | 'signer'>,
  surfaces: ArchiveSurfaces,
  checkpoint: Checkpoint,
  options?: CallOptions,
): Promise<void> {
  const leaves = await surfaces.sealHeads(options);
  const root = await merkleSumRoot(ctx.digest, leaves);
  const ok =
    toHex(root.hash) === checkpoint.root &&
    leaves.length === checkpoint.count &&
    (await ctx.signer.verify(
      sumRootPayload(root),
      fromHex(checkpoint.signature),
    ));
  if (!ok) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'The seal-head snapshot failed authentication against the signed checkpoint; refusing to archive under an unverified seal.',
      { retryable: false, detail: { checkpointId: checkpoint.id } },
    );
  }
}

/**
 * One archival run: verify, copy, delete, in pages, resumable. Returns a summary of what moved
 * and why it stopped; refuses loudly (CHAIN_BROKEN) rather than move anything unverified.
 */
export async function archiveSealedPrefix(
  store: Store,
  ctx: WorkerCtx,
  input: ArchiveSweepInput,
  options?: CallOptions,
): Promise<ArchiveSummary> {
  const surfaces = surfacesOf(store);
  if (surfaces === null) {
    return {
      moved: 0,
      throughSeq: null,
      finished: false,
      skipped: true,
      reason: 'the store lacks the archival surfaces',
    };
  }
  const gate = await eligibleCheckpoint(store, input, options);
  if ('summary' in gate) {
    return gate.summary;
  }
  const checkpoint = gate.checkpoint;
  await authenticateSeal(ctx, surfaces, checkpoint, options);
  const { prior, heads } = await resumeBoundary(ctx, surfaces, options);

  const summary: ArchiveSummary = {
    moved: 0,
    throughSeq: prior?.throughSeq ?? null,
    finished: false,
  };
  let cursor = prior?.cursor ?? prior?.throughSeq ?? null;
  for (;;) {
    const page = await surfaces.archivePage(cursor, input.limit, options);
    const eligible = sealedPrefix(page.postings, checkpoint.at);
    if (eligible.length === 0) {
      summary.finished = true;
      return summary;
    }

    await verifyPage(ctx, eligible, heads);
    // Copy before delete; the sink's idempotency absorbs a crashed re-send.
    await input.sink.put(eligible, options);
    const partial =
      page.cursor === null || eligible.length < page.postings.length;
    const last = eligible[eligible.length - 1]!;
    await sealAndPrune(store, ctx, {
      surfaces,
      heads,
      eligible,
      state: {
        throughSeq: last.seq,
        cursor: partial ? null : last.seq,
        checkpointId: checkpoint.id,
        at: input.now,
      },
      options,
    });

    summary.moved += eligible.length;
    summary.throughSeq = last.seq;
    ctx.meter.count('worker.archive.moved', eligible.length);
    if (partial) {
      summary.finished = true;
      ctx.logger.log('info', 'worker.archive.finished', {
        throughSeq: last.seq,
        moved: summary.moved,
      });
      return summary;
    }
    cursor = last.seq;
  }
}

function sealedPrefix(
  postings: ReadonlyArray<ArchivedPosting>,
  sealAt: number,
): ArchivedPosting[] {
  const eligible: ArchivedPosting[] = [];
  for (const posting of postings) {
    if (posting.postedAt > sealAt) {
      break;
    }
    eligible.push(posting);
  }
  return eligible;
}

// The retention gate: only a v2 sum-carrying checkpoint older than retention authorizes a run.
async function eligibleCheckpoint(
  store: Store,
  input: ArchiveSweepInput,
  options?: CallOptions,
): Promise<{ checkpoint: Checkpoint } | { summary: ArchiveSummary }> {
  const checkpoint = await store.checkpoints.latest(options);
  if (checkpoint === null || checkpoint.v !== 2) {
    return {
      summary: {
        moved: 0,
        throughSeq: null,
        finished: false,
        skipped: true,
        reason: 'no v2 sum-carrying checkpoint to archive under',
      },
    };
  }
  if (input.now - checkpoint.at < input.checkpointOlderThanMs) {
    return {
      summary: {
        moved: 0,
        throughSeq: null,
        finished: true,
        reason: `the latest checkpoint is ${input.now - checkpoint.at}ms old; archival waits for one older than the checkpointOlderThanMs bound (${input.checkpointOlderThanMs}ms)`,
      },
    };
  }
  return { checkpoint };
}

// Resume state: the signed archive heads are the continuity baseline, so they authenticate
// before anything trusts them — an unauthenticated boundary row is an anchor an attacker can
// move.
async function resumeBoundary(
  ctx: WorkerCtx,
  surfaces: ArchiveSurfaces,
  options?: CallOptions,
): Promise<{
  prior: ArchiveState | null;
  heads: Map<AccountRef, { head: string; sum: bigint }>;
}> {
  const prior = await surfaces.archiveState(options);
  const heads = new Map<AccountRef, { head: string; sum: bigint }>();
  if (prior !== null) {
    const rows = await surfaces.archiveHeads(options);
    if (!(await verifyArchiveHeads(ctx, rows, prior))) {
      throw fault(
        ERROR_CODES.CHAIN_BROKEN,
        'The archive heads failed authentication against their signed root; refusing to archive over a tampered boundary.',
        { retryable: false },
      );
    }
    for (const row of rows) {
      heads.set(row.account, { head: row.head, sum: row.sum });
    }
  }
  return { prior, heads };
}

// The load-bearing verify: every link re-derives from stored content and chains onto the
// signed archive head (or genesis) in strict order — an edit, a gap, or a moved boundary
// refuses here, before anything is copied or deleted. Advances `heads` in place.
async function verifyPage(
  ctx: WorkerCtx,
  eligible: ReadonlyArray<ArchivedPosting>,
  heads: Map<AccountRef, { head: string; sum: bigint }>,
): Promise<void> {
  const links: Array<{ account: AccountRef } & StoredLink> = [];
  for (const posting of eligible) {
    for (const link of posting.links) {
      links.push({
        account: link.account,
        txnId: posting.txnId,
        legs: posting.legs,
        meta: posting.meta,
        prevHash: link.prevHash,
        hash: link.hash,
      });
      const expected = heads.get(link.account)?.head ?? GENESIS_HEX;
      if (link.prevHash !== expected) {
        throw fault(
          ERROR_CODES.CHAIN_BROKEN,
          'An archival page does not extend the signed archive boundary; refusing to move discontinuous history.',
          {
            retryable: false,
            detail: { account: link.account, txnId: posting.txnId },
          },
        );
      }
      const sum = heads.get(link.account)?.sum ?? 0n;
      const legTotal = posting.legs
        .filter((leg) => leg.account === link.account)
        .reduce((total, leg) => total + leg.amount.minor, 0n);
      heads.set(link.account, { head: link.hash, sum: sum + legTotal });
    }
  }
  const broken = await reproveLinks(ctx.digest, links);
  if (broken !== null) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'An archival page failed to re-derive from its own content; refusing to move edited history.',
      { retryable: false, detail: { ...broken } },
    );
  }
}

// Sign the advanced boundary, persist it, then prune — in that order: a crash between the two
// leaves the boundary postings present but already vouched by the new signature, which the
// prover accepts (the signed head appears inside the remaining walk's prefix). The reverse
// order would leave deleted history with an unsigned boundary.
async function sealAndPrune(
  store: Store,
  ctx: WorkerCtx,
  args: {
    surfaces: ArchiveSurfaces;
    heads: Map<AccountRef, { head: string; sum: bigint }>;
    eligible: ReadonlyArray<ArchivedPosting>;
    state: Omit<ArchiveState, 'root' | 'signature'>;
    options?: CallOptions;
  },
): Promise<void> {
  const headRows: ArchiveHead[] = [...args.heads].map(([account, row]) => ({
    account,
    head: row.head,
    sum: row.sum,
  }));
  const root = await merkleSumRoot(
    ctx.digest,
    headRows.map((row) => [row.account, row.head, row.sum] as const),
  );
  // Whole postings net to zero, so the archived prefix must too — a nonzero sum means the
  // mover itself is broken, and nothing gets deleted under a broken mover.
  if (root.sum !== 0n) {
    throw fault(
      ERROR_CODES.LEDGER_UNBALANCED,
      'The archive-head sums do not net to zero; refusing to prune under an unbalanced boundary.',
      { retryable: false, detail: { sum: root.sum.toString() } },
    );
  }
  const signature = toHex(await ctx.signer.sign(archivePayload(root)));
  await args.surfaces.putArchiveBoundary(
    { ...args.state, root: toHex(root.hash), signature },
    headRows,
    args.options,
  );
  await store.transaction(
    (unit) => unit.ledger.prune!(args.eligible.map((posting) => posting.txnId)),
    args.options,
  );
}
