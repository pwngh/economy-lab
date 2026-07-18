import {
  createEconomy,
  credits,
  encodeAmount,
  spendable,
  systemActor,
  topUp,
} from '@pwngh/economy-lab';

import type { SnippetReport } from './context.ts';

// A scheduled top-up is any timer plus an idempotency key minted from the period. The key is
// what makes the schedule safe: a cron that fires twice, a retried job, a redeployed worker —
// same period, same key, at most one grant.
export async function run(): Promise<SnippetReport> {
  const economy = await createEconomy();
  const monthly = (period: string) =>
    economy.submit(
      topUp({
        idempotencyKey: `allowance_usr_kid_${period}`, // the period IS the key
        actor: systemActor('allowance'),
        userId: 'usr_kid',
        amount: credits(50),
        source: 'allowance',
      }),
    );

  const july = await monthly('2026-07');
  const julyAgain = await monthly('2026-07'); // the timer double-fired
  const august = await monthly('2026-08');
  const balance = await economy.read.balance(spendable('usr_kid'));
  await economy.close();

  return {
    lines: [
      `2026-07 fired:    ${july.status}`,
      `2026-07 re-fired: ${julyAgain.status} — the key absorbed the retry`,
      `2026-08 fired:    ${august.status}`,
      `two months, one retry, balance: ${encodeAmount(balance)}`,
    ],
    consolePath: '/market',
  };
}
