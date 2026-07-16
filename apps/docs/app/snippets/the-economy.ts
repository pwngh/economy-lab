import { credits, spendable, systemActor, topUp } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// The whole loop in one block: read the balance, submit a top-up, read it again. Edit
// the amount and run again — the outcome and the move both follow your number.
export async function run(economy: Economy): Promise<SnippetReport> {
  const account = spendable('usr_alice');
  const before = await economy.read.balance(account);

  const outcome = await economy.submit(
    topUp({
      idempotencyKey: `ord_${crypto.randomUUID().slice(0, 8)}`,
      actor: systemActor('billing'),
      userId: 'usr_alice',
      amount: credits(50),
      source: 'stripe',
    }),
  );

  const after = await economy.read.balance(account);
  const moved = (after.minor - before.minor) / 100n;

  return {
    lines: [
      `outcome: ${outcome.status}` +
        `${outcome.status === 'committed' ? ` → ${outcome.transaction.id}` : ''}`,
      `usr_alice spendable: ${before.minor / 100n} → ${after.minor / 100n} credits (moved ${moved})`,
    ],
    txnId: outcome.status === 'committed' ? outcome.transaction.id : undefined,
  };
}
