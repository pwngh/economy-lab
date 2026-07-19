import {
  cancelSubscription,
  createEconomy,
  credits,
  memoryPorts,
  refund,
  revokeEntitlement,
  spend,
  subscribe,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';

import type { Outcome } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// The record-keyed declines, produced in one sitting against a private little economy: each
// answer is the code plus the record it couldn't find or refuses to double-book.
export async function run(): Promise<SnippetReport> {
  const economy = createEconomy(memoryPorts({ signingKey: 'docs-signing-key' }));
  const buyer = userActor('usr_r');
  await economy.submit(
    topUp({
      idempotencyKey: 'idem_fund',
      actor: systemActor('docs'),
      userId: 'usr_r',
      amount: credits(1_000),
      source: 'card',
    }),
  );

  const order = (idempotencyKey: string) =>
    spend({
      idempotencyKey,
      actor: buyer,
      orderId: 'ord_r1',
      buyerId: 'usr_r',
      sku: 'Poster',
      price: credits(100),
      recipients: [{ sellerId: 'usr_s', shareBps: 10_000 }],
    });
  await economy.submit(order('idem_first')); // commits and records the sale
  const dupOrder = await economy.submit(order('idem_lost_the_key'));

  const ghostRefund = await economy.submit(
    refund({ idempotencyKey: 'idem_gr', actor: systemActor('docs'), orderId: 'ord_ghost' }),
  );
  const ghostCancel = await economy.submit(
    cancelSubscription({ idempotencyKey: 'idem_gc', actor: buyer, subscriptionId: 'sub_ghost' }),
  );

  const club = (idempotencyKey: string) =>
    subscribe({
      idempotencyKey,
      actor: buyer,
      userId: 'usr_r',
      sellerId: 'usr_s',
      sku: 'Club',
      price: credits(300),
      periodMs: 2_592_000_000,
    });
  await economy.submit(club('idem_join')); // the one active subscription
  const twice = await economy.submit(club('idem_join_again'));

  const unowned = await economy.submit(
    revokeEntitlement({
      idempotencyKey: 'idem_rv',
      actor: systemActor('docs'),
      userId: 'usr_r',
      sku: 'sku_never_granted',
    }),
  );
  await economy.close();

  const reason = (o: Outcome) => (o.status === 'rejected' ? o.detail.reason : o.status);
  const detail = (o: Outcome) => JSON.stringify(o.status === 'rejected' ? o.detail : {});
  return {
    lines: [
      `same order, new key: ${reason(dupOrder)} — detail ${detail(dupOrder)}`,
      `refund of no sale:   ${reason(ghostRefund)} — detail ${detail(ghostRefund)}`,
      `cancel of no sub:    ${reason(ghostCancel)} — detail ${detail(ghostCancel)}`,
      `subscribe twice:     ${reason(twice)} — detail ${detail(twice)}`,
      `revoke unowned sku:  ${reason(unowned)} — detail ${detail(unowned)}`,
    ],
    consolePath: '/market',
  };
}
