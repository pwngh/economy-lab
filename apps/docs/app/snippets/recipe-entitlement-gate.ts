import {
  createEconomy,
  credits,
  memoryPorts,
  refund,
  spend,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';

import type { SnippetReport } from './context.ts';

// Ownership is a record, not a balance: the spend that sells a SKU grants it in the same
// transaction, and `read.entitled` is the gate the rest of your service asks before it unlocks
// anything. Money coming back takes the access with it — a refund revokes the same record.
export async function run(): Promise<SnippetReport> {
  const economy = createEconomy(memoryPorts({ signingKey: 'docs-signing-key' }));
  await economy.submit(
    topUp({
      idempotencyKey: 'purchase_2026_07_usr_g',
      actor: systemActor('payments'),
      userId: 'usr_g',
      amount: credits(600), // the $5 bundle
      source: 'card',
    }),
  );

  const before = await economy.read.entitled('usr_g', 'wrld_cape');
  await economy.submit(
    spend({
      idempotencyKey: 'spend_ord_g1',
      actor: userActor('usr_g'),
      orderId: 'ord_g1',
      buyerId: 'usr_g',
      sku: 'wrld_cape',
      price: credits(480),
      recipients: [{ sellerId: 'usr_s', shareBps: 10_000 }],
    }),
  );
  const after = await economy.read.entitled('usr_g', 'wrld_cape');

  // The failure mode: the money comes back. The refund revokes the entitlement in the same
  // transaction that returns the credits, so the gate closes everywhere at once.
  await economy.submit(
    refund({
      idempotencyKey: 'refund_ord_g1',
      actor: systemActor('support'),
      orderId: 'ord_g1',
      reason: 'buyer request',
    }),
  );
  const afterRefund = await economy.read.entitled('usr_g', 'wrld_cape');
  await economy.close();

  return {
    lines: [
      `entitled('usr_g', 'wrld_cape') before the purchase: ${before}`,
      'spend committed — the same transaction granted the SKU',
      `entitled('usr_g', 'wrld_cape') after: ${after}`,
      `after the refund: ${afterRefund} — the money left and took the access with it`,
    ],
    consolePath: '/market',
  };
}
