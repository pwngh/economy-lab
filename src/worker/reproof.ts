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

import { reproveLinks } from '#src/chain.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

/**
 * One rolling re-proof tick. `checked` links re-derived this tick; `cursor` is where the walk
 * stands (null between rotations); `rotatedAt` is when the last complete pass finished — the
 * verified-through watermark: every link recorded before it has been re-hashed since, younger
 * links are vouched by seals and balance checks only. `skipped` when the store carries no
 * reproof state surface.
 */
export type ReproofSummary = {
  checked: number;
  cursor: number | null;
  rotatedAt: number | null;
  skipped: boolean;
};

/**
 * Re-derives a budget-bounded page of stored chain links from their own content and advances a
 * persistent cursor, wrapping around forever — the job that bounds how long an in-place edit of
 * old rows can sit unnoticed. The seals prove dirty tails and topology; verified reads protect
 * every money-deriving handler immediately; this sweep closes the rest (cold accounts, metadata,
 * anything no handler happens to touch) on an explicit cadence instead of never. A broken link
 * throws non-retryable CHAIN_BROKEN and leaves the cursor where it stands, so every later tick
 * re-reports the same break until an operator intervenes.
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
  const broken = await reproveLinks(ctx.digest, page.links);
  if (broken !== null) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'A stored chain link failed to re-derive from its own content; stored history was edited in place.',
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

// The watermark gauge: a horizon age that only grows means rotations stopped keeping up with
// history and the budget needs raising. Telemetry only — a broken gauge is not a broken sweep.
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
