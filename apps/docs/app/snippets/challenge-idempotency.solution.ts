import { credits, spend, systemActor, topUp, userActor } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// The fix: the order's identity is minted once, from the cart, and every attempt reuses
// it. The first attempt commits; the retry replays that recorded outcome as `duplicate`
// — same transaction, nothing new posted.
export async function run(economy: Economy): Promise<SnippetReport> {
  const buyerId = `usr_retry_${crypto.randomUUID().slice(0, 6)}`;
  await economy.submit(
    topUp({
      idempotencyKey: `idem_${buyerId}`,
      actor: systemActor('docs'),
      userId: buyerId,
      amount: credits(200),
      source: 'card',
    }),
  );

  const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`; // minted once
  const attempt = () =>
    economy.submit(
      spend({
        idempotencyKey: orderId, // every attempt shares the order's key
        actor: userActor(buyerId),
        orderId,
        buyerId,
        sku: 'Starter Pack',
        price: credits(100),
        recipients: [{ sellerId: 'usr_nova', shareBps: 10_000 }],
      }),
    );

  const first = await attempt();
  const retry = await attempt(); // the response was lost — send it again

  const committed = [first, retry].filter((o) => o.status === 'committed').length;
  const verdict = committed === 1 ? 'one cart, one charge' : 'the buyer paid twice for one cart';
  return {
    lines: [
      `first: ${first.status} · retry: ${retry.status}`,
      `committed: ${committed} — ${verdict}`,
    ],
  };
}
