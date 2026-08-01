import {
  SYSTEM,
  createEconomy,
  credits,
  earned,
  encodeAmount,
  memoryPorts,
  refund,
  spend,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';

import type { SnippetReport } from './context.ts';

// One spend, two sellers: the platform fee comes off the top, each recipient takes their
// basis points of the net, and any rounding leftover stays with the house — the shares must
// sum to exactly 10,000 so no remainder goes unclaimed. One refund unwinds every share.
export async function run(): Promise<SnippetReport> {
  // The dev velocity ceiling is sized for small demos; bundle-scale amounts need headroom.
  const economy = createEconomy(
    memoryPorts({
      signingKey: 'docs-signing-key',
      config: { velocityLimitMinor: 10_000_000n },
    }),
  );
  await economy.submit(
    topUp({
      idempotencyKey: 'purchase_2026_07_usr_b',
      actor: systemActor('payments'),
      userId: 'usr_b',
      amount: credits(1_200), // the $10 bundle
      source: 'card',
    }),
  );
  await economy.submit(
    spend({
      idempotencyKey: 'spend_ord_f1',
      actor: userActor('usr_b'),
      orderId: 'ord_f1',
      buyerId: 'usr_b',
      sku: 'Collab Piece',
      price: credits(1_200),
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

  // The failure mode: the buyer disputes the sale. One refund names the order and pulls
  // every share back — both sellers and the fee — in a single opposite posting.
  await economy.submit(
    refund({
      idempotencyKey: 'refund_ord_f1',
      actor: systemActor('support'),
      orderId: 'ord_f1',
      reason: 'buyer request',
    }),
  );
  const [artistAfter, animatorAfter, houseAfter] = await Promise.all([
    economy.read.balance(earned('usr_artist')),
    economy.read.balance(earned('usr_animator')),
    economy.read.balance(SYSTEM.REVENUE),
  ]);
  await economy.close();

  return {
    lines: [
      'a 1,200-credit sale, split 60/40 behind the default fee',
      `artist (6,000 bps):   ${encodeAmount(artist)}`,
      `animator (4,000 bps): ${encodeAmount(animator)}`,
      `house (fee + rounding leftover): ${encodeAmount(house)}`,
      `after the refund: artist ${encodeAmount(artistAfter)} · animator ${encodeAmount(animatorAfter)} · house ${encodeAmount(houseAfter)}`,
    ],
    consolePath: '/market',
  };
}
