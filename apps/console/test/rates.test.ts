/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The governed rate desk: locked by default, unlockable only when no payout is in flight (which
 * pauses everyday writes), bounded on what may be set, and re-lockable to resume.
 */

import { expect, it } from 'vitest';

import { buildEngine } from '../app/economy';

it('reprices only when quiesced, within bounds, and pauses then resumes', async () => {
  const eco = await buildEngine();

  const board0 = await eco.rateBoard();
  expect(board0.locked).toBe(true);
  // The seed leaves payouts in flight, so repricing is blocked.
  expect(board0.inFlightPayouts).toBeGreaterThan(0);
  expect(eco.setRates({ buyPerThousand: 10, parPerThousand: 5 }).ok).toBe(
    false,
  );
  expect((await eco.unlockRates()).ok).toBe(false);

  // Quiesce: settle the submitted payouts and reverse the reserved ones.
  await eco.settleSubmitted();
  for (const p of (await eco.payouts({ offset: 0, limit: 50 })).rows) {
    if (p.state === 'RESERVED') {
      await eco.reversePayout({
        sagaId: p.id,
        userId: p.userId,
        reason: 'quiesce for reprice',
      });
    }
  }
  expect((await eco.rateBoard()).inFlightPayouts).toBe(0);

  // Now the desk unlocks and everyday writes pause.
  expect((await eco.unlockRates()).ok).toBe(true);
  const open = await eco.rateBoard();
  expect(open.locked).toBe(false);
  expect(open.paused).toBe(true);

  // Bounds: buy below par, spread over the cap, and par over the ceiling are all refused.
  expect(eco.setRates({ buyPerThousand: 4, parPerThousand: 5 }).ok).toBe(false);
  expect(eco.setRates({ buyPerThousand: 25, parPerThousand: 5 }).ok).toBe(
    false,
  );
  expect(eco.setRates({ buyPerThousand: 200, parPerThousand: 100 }).ok).toBe(
    false,
  );

  // In-band: accepted, and the board reflects it.
  expect(eco.setRates({ buyPerThousand: 20, parPerThousand: 10 }).ok).toBe(
    true,
  );
  const set = await eco.rateBoard();
  expect(set.buyPerThousand).toBeCloseTo(20, 2);
  expect(set.parPerThousand).toBeCloseTo(10, 2);
  expect(set.payoutPerThousand).toBeCloseTo(10, 2);

  // Re-lock resumes everyday writes, and a reset restores the default, re-locked desk.
  expect((await eco.lockRates()).ok).toBe(true);
  const relocked = await eco.rateBoard();
  expect(relocked.locked).toBe(true);
  expect(relocked.paused).toBe(false);

  await eco.reset();
  const afterReset = await eco.rateBoard();
  expect(afterReset.locked).toBe(true);
  expect(afterReset.buyPerThousand).toBeCloseTo(board0.buyPerThousand, 2);
});
