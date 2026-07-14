import type { SnippetCtx, SnippetReport } from './context';

// One order id, submitted twice. Mint an id per order, reuse it on every retry: the first spend
// commits and posts a transaction; the replay is refused as DUPLICATE_ORDER, so the buyer is
// charged exactly once. Each run funds and places one fresh order, so run it as often as you like.
export async function run(eco: SnippetCtx): Promise<SnippetReport> {
  await eco.deposit({ userId: 'usr_alice', credits: 120 });

  const order = {
    buyerId: 'usr_alice',
    sellerId: 'usr_nova',
    listing: 'Docs Demo Pass',
    credits: 120,
    orderId: `ord_${crypto.randomUUID().slice(0, 8)}`,
  };

  const first = await eco.purchase(order);
  const again = await eco.purchase(order);

  return {
    lines: [
      `first:  ${first.status} → ${first.transaction?.id ?? '—'}`,
      `again:  ${again.status} (${again.reason ?? 'replayed'}) — nothing posted`,
    ],
    txnId: first.transaction?.id,
  };
}
