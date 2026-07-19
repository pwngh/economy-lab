import { credits, spend, spendable, systemActor, topUp, userActor } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// Six spends race a wallet that only covers two — genuinely concurrent, one
// Promise.all. The funds gate is the only limiter: it commits what the balance covers
// and refuses the rest, so the balance can never go negative. The wallet is a fresh
// throwaway, so every run races the same thin balance.
export async function run(economy: Economy): Promise<SnippetReport> {
  const buyerId = `usr_thin_${crypto.randomUUID().slice(0, 6)}`;
  await economy.submit(
    topUp({
      idempotencyKey: `idem_${buyerId}`,
      actor: systemActor('docs'),
      userId: buyerId,
      amount: credits(300),
      source: 'card',
    }),
  );

  const attempts = await Promise.all(
    Array.from({ length: 6 }, (_, i) => {
      const orderId = `ord_${buyerId}_${i}`;
      return economy.submit(
        spend({
          idempotencyKey: orderId,
          actor: userActor(buyerId),
          orderId,
          buyerId,
          sku: 'Docs Drain Listing',
          price: credits(150), // each
          recipients: [{ sellerId: 'usr_nova', shareBps: 10_000 }],
        }),
      );
    }),
  );

  const committed = attempts.filter((o) => o.status === 'committed').length;
  const refused = attempts.filter(
    (o) => o.status === 'rejected' && o.detail.reason === 'INSUFFICIENT_FUNDS',
  ).length;
  const left = await economy.read.balance(spendable(buyerId));

  return {
    lines: [
      `attempts: ${attempts.length} — all in flight at once`,
      `committed: ${committed} · refused INSUFFICIENT_FUNDS: ${refused}`,
      `left in the wallet: ${left.minor / 100n} credits — never below zero`,
    ],
  };
}
