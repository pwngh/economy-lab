import { credits, spend, systemActor, topUp, userActor } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// One operation, submitted twice. Mint the key once from the order and reuse it on
// every retry: the first spend commits and posts a transaction; the replay returns that
// same transaction as duplicate, so the buyer is charged exactly once. Each run funds
// and places one fresh order.
export async function run(economy: Economy): Promise<SnippetReport> {
  await economy.submit(
    topUp({
      idempotencyKey: `idem_${crypto.randomUUID().slice(0, 8)}`,
      actor: systemActor('docs'),
      userId: 'usr_alice',
      amount: credits(120),
      source: 'card',
    }),
  );

  const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
  const order = spend({
    idempotencyKey: orderId, // one key per order, minted once
    actor: userActor('usr_alice'),
    orderId,
    buyerId: 'usr_alice',
    sku: 'Docs Demo Pass',
    price: credits(120),
    recipients: [{ sellerId: 'usr_nova', shareBps: 10_000 }],
  });

  const first = await economy.submit(order);
  const again = await economy.submit(order);

  return {
    lines: [
      `first:  ${first.status} → ${first.status === 'committed' ? first.transaction.id : '—'}`,
      `again:  ${again.status} — same transaction, nothing new posted`,
    ],
    txnId: first.status === 'committed' ? first.transaction.id : undefined,
  };
}
