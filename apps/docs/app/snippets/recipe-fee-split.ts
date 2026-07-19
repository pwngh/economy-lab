import {
  SYSTEM,
  createEconomy,
  credits,
  earned,
  encodeAmount,
  memoryPorts,
  spend,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';

import type { SnippetReport } from './context.ts';

// One spend, two sellers: the platform fee comes off the top, each recipient takes their
// basis points of the net, and any rounding leftover stays with the house — the shares must
// sum to exactly 10,000 so no remainder goes unclaimed.
export async function run(): Promise<SnippetReport> {
  const economy = createEconomy(memoryPorts({ signingKey: 'docs-signing-key' }));
  await economy.submit(
    topUp({
      idempotencyKey: 'idem_fund',
      actor: systemActor('payments'),
      userId: 'usr_b',
      amount: credits(1_000),
      source: 'card',
    }),
  );
  await economy.submit(
    spend({
      idempotencyKey: 'idem_sale',
      actor: userActor('usr_b'),
      orderId: 'ord_f1',
      buyerId: 'usr_b',
      sku: 'Collab Piece',
      price: credits(1_000),
      recipients: [
        { sellerId: 'usr_artist', shareBps: 6_000 },
        { sellerId: 'usr_animator', shareBps: 4_000 },
      ],
    }),
  );
  const [artist, animator, house] = await Promise.all([
    economy.read.balance(earned('usr_artist')),
    economy.read.balance(earned('usr_animator')),
    economy.read.balance(SYSTEM.REVENUE),
  ]);
  await economy.close();

  return {
    lines: [
      'a 1,000-credit sale, split 60/40 behind the default fee',
      `artist (6,000 bps):   ${encodeAmount(artist)}`,
      `animator (4,000 bps): ${encodeAmount(animator)}`,
      `house (fee + rounding leftover): ${encodeAmount(house)}`,
    ],
    consolePath: '/market',
  };
}
