import { credits, spend, spendable, userActor } from '@pwngh/economy-lab';
import { balanceDelta } from '@pwngh/economy-lab/store-kit';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// One committed sale, read leg by leg: the lines always net to zero, and balanceDelta
// turns the buyer's line back into the change they saw. Edit the price — the legs
// rebalance around your number, every time.
export async function run(economy: Economy): Promise<SnippetReport> {
  const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
  const outcome = await economy.submit(
    spend({
      idempotencyKey: orderId,
      actor: userActor('usr_alice'),
      orderId,
      buyerId: 'usr_alice',
      sku: 'Ledger Demo Pass',
      price: credits(10),
      recipients: [{ sellerId: 'usr_nova', shareBps: 10_000 }],
    }),
  );

  if (outcome.status !== 'rejected') {
    const legs = outcome.transaction.legs;
    const sum = legs.reduce((total, leg) => total + leg.amount.minor, 0n);
    const buyerLeg = legs.find((leg) => leg.account === spendable('usr_alice'));
    return {
      lines: [
        `${legs.length} legs, summing to ${sum}n — the posting balances`,
        buyerLeg
          ? `buyer's leg via balanceDelta: ${balanceDelta(buyerLeg).minor / 100n} credits`
          : 'no buyer leg found',
      ],
      txnId: outcome.transaction.id,
    };
  }
  return { lines: [`spend: rejected (${outcome.detail.reason}) — no posting to read`] };
}
