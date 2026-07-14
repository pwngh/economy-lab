/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The try-to-break-it tally, carried across a post-redirect-get in its own one-shot slot — kept out
 * of the app-wide Flash union, which is for generic messages, not one page's scoreboard. The market
 * burst action sets it; the market loader takes it once and hands it to the break-harness card.
 */

export interface RaceTally {
  mode: 'order' | 'drain';
  attempts: number;
  committed: number;
  duplicates: number;
  insufficient: number;
  other: number;
  movedCredits: number;
}

let pending: RaceTally | null = null;

export function setRaceTally(tally: RaceTally): void {
  pending = tally;
}

// Read-and-clear, called by the market loader; the clear is what makes the tally one-shot.
export function takeRaceTally(): RaceTally | null {
  const tally = pending;
  pending = null;
  return tally;
}
