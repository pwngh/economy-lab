import {
  adjust,
  createEconomy,
  credits,
  earned,
  memoryPorts,
  operatorActor,
  requestPayout,
  userActor,
} from '@pwngh/economy-lab';
import { encodeAmounts } from '@pwngh/economy-lab/store-kit';

import type { Outcome } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// The three payout gates, tripped in order on a purpose-built economy: a 100-credit minimum, a
// 7-day gap between requests, and a payee directory that has cleared only one seller.
export async function run(): Promise<SnippetReport> {
  const economy = createEconomy({
    ...memoryPorts({
      signingKey: 'docs-signing-key',
      config: {
        payoutMinimumEarnedMinor: 10_000n, // 100 credits
        payoutMinIntervalMs: 7 * 86_400_000,
      },
    }),
    payees: {
      status: async (userId) => ({ state: userId === 'usr_cleared' ? 'CLEARED' : 'PENDING' }),
    },
  });
  await economy.submit(
    adjust({
      idempotencyKey: 'idem_seed',
      actor: operatorActor('op_docs'),
      account: earned('usr_cleared'),
      amount: credits(200),
      reason: 'docs: seed earnings',
    }),
  );

  const request = (userId: string, amount: number, key: string) =>
    economy.submit(
      requestPayout({
        idempotencyKey: key,
        actor: userActor(userId),
        userId,
        amount: credits(amount),
      }),
    );

  const tooSmall = await request('usr_cleared', 50, 'idem_small'); // under the 100 minimum
  await request('usr_cleared', 150, 'idem_ok'); // 150 clears every gate
  const tooSoon = await request('usr_cleared', 150, 'idem_again'); // clears the minimum, inside the 7-day gap
  const unverified = await request('usr_pending', 150, 'idem_pending');
  await economy.close();

  const report = (label: string, o: Outcome) =>
    o.status === 'rejected'
      ? `${label}: ${o.detail.reason} — detail ${JSON.stringify(encodeAmounts(o.detail))}`
      : `${label}: ${o.status}`;
  return {
    lines: [
      report('50 against the 100 minimum', tooSmall),
      report('a second ask, day one    ', tooSoon),
      report('an uncleared payee       ', unverified),
    ],
    consolePath: '/payouts',
  };
}
