import {
  createEconomy,
  credits,
  encodeAmount,
  grantPromo,
  promo,
  spend,
  spendable,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';

import type { SnippetReport } from './context.ts';

// A promo grant is marketing money with a deadline: it lands in the promo balance, spends
// first when the user buys, and the worker's promos sweep claws back whatever is left once
// expiresAt passes. The grant and the promo-first draw are the recipe; the expiry needs no code.
export async function run(): Promise<SnippetReport> {
  const economy = await createEconomy();
  await economy.submit(
    topUp({
      idempotencyKey: 'idem_fund',
      actor: systemActor('payments'),
      userId: 'usr_p',
      amount: credits(100),
      source: 'card',
    }),
  );
  await economy.submit(
    grantPromo({
      idempotencyKey: 'promo_launch_usr_p',
      actor: systemActor('marketing'),
      userId: 'usr_p',
      amount: credits(200),
      expiresAt: Date.now() + 30 * 86_400_000, // the claw-back deadline
    }),
  );
  await economy.submit(
    spend({
      idempotencyKey: 'idem_buy',
      actor: userActor('usr_p'),
      orderId: 'ord_p1',
      buyerId: 'usr_p',
      sku: 'Starter Pack',
      price: credits(150),
      recipients: [{ sellerId: 'usr_s', shareBps: 10_000 }],
    }),
  );
  const [promoLeft, cash] = await Promise.all([
    economy.read.balance(promo('usr_p')),
    economy.read.balance(spendable('usr_p')),
  ]);
  await economy.close();

  return {
    lines: [
      'granted 200 promo (expires in 30 days) on top of 100 topped up',
      'a 150 spend drew the promo balance first',
      `promo left: ${encodeAmount(promoLeft)} · spendable untouched: ${encodeAmount(cash)}`,
    ],
    consolePath: '/market',
  };
}
