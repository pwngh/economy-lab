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

// The velocity ceiling is construction-time config, so this block builds its own small
// economy with a 300-credit window. Inflow and outflow fill separate windows: the 200
// funded counts against inflow only, the first 160 spent fits the outflow window, and
// 160 more crosses it — declined as RISK_DENIED with the window's own figures.
export async function run(): Promise<SnippetReport> {
  const economy = createEconomy(
    memoryPorts({
      signingKey: 'docs-signing-key',
      config: { velocityLimitMinor: 30_000n }, // 300 credits per window, both classes
    }),
  );
  await economy.submit(
    topUp({
      idempotencyKey: 'idem_fund',
      actor: systemActor('docs'),
      userId: 'usr_v',
      amount: credits(200), // fills the inflow window, not the spend one
      source: 'card',
    }),
  );

  const PRICE = 160; // credits per spend — the second one crosses the 300 ceiling
  const buy = (n: number) =>
    spend({
      idempotencyKey: `ord_v${n}`,
      actor: userActor('usr_v'),
      orderId: `ord_v${n}`,
      buyerId: 'usr_v',
      sku: 'Velocity Test Pass',
      price: credits(PRICE),
      recipients: [{ sellerId: 'usr_s', shareBps: 10_000 }],
    });

  const within = await economy.submit(buy(1));
  const past = await economy.submit(buy(2));
  await economy.close();

  return {
    lines: [
      'ceiling armed at construction: 300 credits per window',
      `spend of ${PRICE}: ${within.status} — ${PRICE} of 300 out this window`,
      past.status === 'rejected' && past.detail.reason === 'RISK_DENIED'
        ? `${PRICE} more: ${past.status} (${past.detail.reason}) — the ` +
          `${past.detail.window} window at its ${past.detail.limitMinor / 100n}-credit limit`
        : `${PRICE} more: ${past.status}`,
    ],
    consolePath: '/controls',
  };
}
