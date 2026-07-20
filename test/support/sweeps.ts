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

import { credit, debit } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';

import type { Dispatcher, Posting } from '#src/ports.ts';
import type { ReconcileFeed, SweepRequest } from '#src/worker/index.ts';

export function emptyFeed(): ReconcileFeed {
  return { pull: async () => ({ processor: [], ledger: [] }) };
}

export function nullDispatcher(): Dispatcher {
  return async () => {};
}

export function sweepInput(overrides?: Partial<SweepRequest>): SweepRequest {
  return {
    now: 1_000,
    limit: 10,
    dispatcher: nullDispatcher(),
    feed: emptyFeed(),
    windows: [{ from: 0, to: 1_000 }],
    ...overrides,
  };
}

// Two legs on distinct accounts, so advanceHeads produces two chain links to assert on.
export function balancedPosting(txnId: string, user: string): Posting {
  const amount = toAmount('CREDIT', 500n);
  return {
    txnId,
    legs: [credit(spendable(user), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { kind: 'test', source: 'card' },
  };
}
