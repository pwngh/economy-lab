import {
  createEconomy,
  credits,
  memoryPorts,
  spend,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';

import type { SnippetReport } from './context.ts';

// Ownership is a record, not a balance: the spend that sells a SKU grants it in the same
// transaction, and `read.entitled` is the gate the rest of your service asks before it unlocks
// anything. No separate fulfillment step to lose.
export async function run(): Promise<SnippetReport> {
  const economy = createEconomy(memoryPorts({ signingKey: 'docs-signing-key' }));
  await economy.submit(
    topUp({
      idempotencyKey: 'idem_fund',
      actor: systemActor('payments'),
      userId: 'usr_g',
      amount: credits(100),
      source: 'card',
    }),
  );

  const before = await economy.read.entitled('usr_g', 'wrld_cape');
  await economy.submit(
    spend({
      idempotencyKey: 'idem_buy',
      actor: userActor('usr_g'),
      orderId: 'ord_g1',
      buyerId: 'usr_g',
      sku: 'wrld_cape',
      price: credits(40),
      recipients: [{ sellerId: 'usr_s', shareBps: 10_000 }],
    }),
  );
  const after = await economy.read.entitled('usr_g', 'wrld_cape');
  await economy.close();

  return {
    lines: [
      `entitled('usr_g', 'wrld_cape') before the purchase: ${before}`,
      'spend committed — the same transaction granted the SKU',
      `entitled('usr_g', 'wrld_cape') after: ${after}`,
    ],
    consolePath: '/market',
  };
}
