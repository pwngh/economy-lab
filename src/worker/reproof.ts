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

import { loadArchiveBoundary, reproveLinks } from '#src/chain.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';

import type { ArchiveBoundary } from '#src/chain.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Store, StoredLink } from '#src/ports.ts';

/**
 * One rolling re-proof tick. `checked` counts the links re-derived this tick. `cursor` is where
 * the walk stands (null between rotations). `rotatedAt` is when the last complete pass finished,
 * and it is the verified-through watermark: every link recorded before it has been re-hashed
 * since, and younger links are vouched by seals and balance checks only. `skipped` is set when
 * the store carries no reproof state surface.
 */
export type ReproofSummary = {
  checked: number;
  cursor: number | null;
  rotatedAt: number | null;
  skipped: boolean;
};

/**
 * Re-derives a budget-bounded page of stored chain links from their own content, checks that they
 * still chain, and advances a persistent cursor, wrapping around forever. This job bounds how long
 * an edit or a deletion in old rows can sit unnoticed. Verified reads protect every money-deriving
 * handler immediately, and the seals cover every account whose head or leg sum moves. This sweep
 * closes the rest — cold accounts, metadata, a deleted link whose legs netted to nothing, anything
 * no handler happens to touch — on an explicit cadence instead of never. A break throws
 * non-retryable CHAIN_BROKEN and leaves the cursor where it stands, so every later tick re-reports
 * the same break until an operator intervenes.
 *
 * Continuity across a page edge costs one lineage read per account the page opens on, which is
 * why the page budget is the cost bound for this job and not just its duration.
 */
export async function reproveStoredChains(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
): Promise<ReproofSummary> {
  if (
    store.checkpoints.reproof === undefined ||
    store.checkpoints.putReproof === undefined
  ) {
    return { checked: 0, cursor: null, rotatedAt: null, skipped: true };
  }
  const state = (await store.checkpoints.reproof()) ?? {
    cursor: null,
    rotatedAt: null,
  };
  const page = await store.ledger.linksPage(state.cursor, input.limit);
  const broken = await reproveLinks(
    ctx.digest,
    page.links,
    resolvePrevAgainst(store, ctx),
  );
  if (broken !== null) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      broken.reason === 'broken-link'
        ? 'A stored chain link no longer follows the link before it; stored history was deleted or reordered.'
        : 'A stored chain link failed to re-derive from its own content; stored history was edited in place.',
      { retryable: false, detail: { ...broken } },
    );
  }
  const next = {
    cursor: page.cursor,
    rotatedAt: page.cursor === null ? input.now : state.rotatedAt,
  };
  await store.checkpoints.putReproof(next);
  observeHorizon(ctx, input.now, next.rotatedAt);
  return {
    checked: page.links.length,
    cursor: next.cursor,
    rotatedAt: next.rotatedAt,
    skipped: false,
  };
}

// Answers for the predecessor of an account's first link in a page, which sits outside the page.
// A live predecessor is the ordinary case: `sinceHash` streams the links recorded after the one
// carrying that hash, and an unknown hash streams nothing, so the first link back has to be the
// one asking. Archival is the other legitimate case — the prune deletes a strict prefix and the
// remaining chain hangs off the signed anchor — and the boundary is loaded only when a hash fails
// to resolve, so an unarchived store never pays for it. Everything else is a link that was
// deleted or reordered out from under its child.
//
// The first link back must BE this one, not merely exist. Existence is what a deletion violates;
// identity is what a fork violates, and a fork whose two links straddle a page edge is caught
// nowhere else. No engine here can hold that state — both SQL engines refuse a second link at one
// prev_hash, and memory derives prev_hash from the head it already holds, so no caller can hand it
// a second — which leaves the fork half correct and unexercised on purpose.
// test/conformance/invariants.adversarial.test.ts is what keeps that refusal true.
function resolvePrevAgainst(
  store: Store,
  ctx: WorkerCtx,
): (link: { account: AccountRef } & StoredLink) => Promise<boolean> {
  let boundary: Promise<ArchiveBoundary | null> | undefined;
  return async (link) => {
    for await (const next of store.ledger.lineage(link.account, {
      sinceHash: link.prevHash,
    })) {
      return next.hash === link.hash;
    }
    boundary ??= loadArchiveBoundary(store.checkpoints, {
      digest: ctx.digest,
      signer: ctx.signer,
    });
    return (await boundary)?.anchors.get(link.account) === link.prevHash;
  };
}

// This is the watermark gauge. A horizon age that only grows means rotations stopped keeping up
// with history and the budget needs raising. It is telemetry only, so a broken gauge is not a
// broken sweep.
function observeHorizon(
  ctx: WorkerCtx,
  now: number,
  rotatedAt: number | null,
): void {
  try {
    if (rotatedAt !== null) {
      ctx.meter.observe('worker.reproof.horizon_age_ms', now - rotatedAt);
    }
  } catch {
    // Telemetry only.
  }
}
