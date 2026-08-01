import {
  createEconomy,
  createWorker,
  credits,
  encodeAmount,
  grantPromo,
  memoryPorts,
  promo,
  spend,
  spendable,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';

import type { SnippetReport } from './context.ts';

const DAY_MS = 86_400_000;

// A promo grant is marketing money with a deadline: it lands in the promo balance, spends
// first when the user buys, and the worker's promos sweep claws back whatever is left once
// expiresAt passes. The grant and the promo-first draw are the recipe; the expiry is one sweep.
export async function run(): Promise<SnippetReport> {
  // The dev velocity ceiling is sized for small demos; bundle-scale amounts need headroom.
  const ports = memoryPorts({
    signingKey: 'docs-signing-key',
    config: { velocityLimitMinor: 10_000_000n },
  });
  const economy = createEconomy(ports);
  await economy.submit(
    topUp({
      idempotencyKey: 'purchase_2026_07_usr_p',
      actor: systemActor('payments'),
      userId: 'usr_p',
      amount: credits(1_200), // the $10 bundle
      source: 'card',
    }),
  );
  await economy.submit(
    grantPromo({
      idempotencyKey: 'promo_launch_usr_p',
      actor: systemActor('marketing'),
      userId: 'usr_p',
      amount: credits(600),
      expiresAt: Date.now() + 30 * DAY_MS, // the claw-back deadline
    }),
  );
  await economy.submit(
    spend({
      idempotencyKey: 'spend_ord_p1',
      actor: userActor('usr_p'),
      orderId: 'ord_p1',
      buyerId: 'usr_p',
      sku: 'Starter Pack',
      price: credits(480),
      recipients: [{ sellerId: 'usr_s', shareBps: 10_000 }],
    }),
  );
  const [promoLeft, cash] = await Promise.all([
    economy.read.balance(promo('usr_p')),
    economy.read.balance(spendable('usr_p')),
  ]);

  // The failure mode of hand-rolled promos — forgetting the reclaim — has no code to forget
  // here: one promos sweep past the deadline reverses the unspent remainder.
  const worker = createWorker(ports, economy);
  await worker.sweep({ only: ['promos'], now: Date.now() + 31 * DAY_MS });
  const afterExpiry = await economy.read.balance(promo('usr_p'));
  await economy.close();

  return {
    lines: [
      'granted 600 promo (expires in 30 days) on top of a 1,200 top-up',
      'a 480 spend drew the promo balance first',
      `promo left: ${encodeAmount(promoLeft)} · spendable untouched: ${encodeAmount(cash)}`,
      `after the promos sweep at day 31: ${encodeAmount(afterExpiry)} — the remainder went home`,
    ],
    consolePath: '/market',
  };
}
