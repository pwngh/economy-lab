import { credits, spend, systemActor, topUp, userActor } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// The violation was the spend's actor: a `user` principal may only act on their own
// accounts, and the seller was submitting the buyer's spend. The buyer submits their
// own order — that's the fix, one line.
export async function run(economy: Economy): Promise<SnippetReport> {
  const buyerId = `usr_shop_${crypto.randomUUID().slice(0, 6)}`;

  await economy.submit(
    topUp({
      idempotencyKey: `idem_${buyerId}`,
      actor: systemActor('billing'), // the platform's billing service tops up — fine
      userId: buyerId,
      amount: credits(150),
      source: 'card',
    }),
  );

  const order = await economy.submit(
    spend({
      idempotencyKey: `ord_${buyerId}`,
      actor: userActor(buyerId), // the buyer acts on their own wallet
      orderId: `ord_${buyerId}`,
      buyerId,
      sku: 'Gallery Print',
      price: credits(100),
      recipients: [{ sellerId: 'usr_nova', shareBps: 10_000 }],
    }),
  );

  return {
    lines: [
      `order: ${order.status}${order.status === 'committed' ? ` → ${order.transaction.id}` : ''}`,
      'both submits ran as principals the engine accepts',
    ],
    txnId: order.status === 'committed' ? order.transaction.id : undefined,
  };
}
