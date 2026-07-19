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

// FUNDS_IMMATURE, produced by giving card credit a three-day holding window: the money is
// there, it just hasn't cleared, and the detail says when it will have.
export async function run(): Promise<SnippetReport> {
  const economy = createEconomy(
    memoryPorts({
      signingKey: 'docs-signing-key',
      config: { maturityHorizonMs: { card: 3 * 86_400_000 } },
    }),
  );
  await economy.submit(
    topUp({
      idempotencyKey: 'idem_fund',
      actor: systemActor('docs'),
      userId: 'usr_m',
      amount: credits(100), // in the wallet, but held for three days
      source: 'card',
    }),
  );
  const outcome = await economy.submit(
    spend({
      idempotencyKey: 'idem_try',
      actor: userActor('usr_m'),
      orderId: 'ord_m1',
      buyerId: 'usr_m',
      sku: 'Poster',
      price: credits(50),
      recipients: [{ sellerId: 'usr_s', shareBps: 10_000 }],
    }),
  );
  await economy.close();

  if (outcome.status !== 'rejected' || outcome.detail.reason !== 'FUNDS_IMMATURE') {
    return { lines: [`status: ${outcome.status}`], consolePath: '/market' };
  }
  return {
    lines: [
      `status: rejected (${outcome.detail.reason})`,
      `detail: ${JSON.stringify(outcome.detail)} — clears ${new Date(outcome.detail.availableAt).toISOString()}`,
    ],
    consolePath: '/market',
  };
}
