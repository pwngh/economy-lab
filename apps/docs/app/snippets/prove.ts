import { credits, spend, systemActor, topUp, userActor } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// Move real money, then ask the ledger to prove itself: the five invariant flags,
// re-checked over the state your operations just changed — the same report the
// console's Integrity page polls.
export async function run(economy: Economy): Promise<SnippetReport> {
  const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
  await economy.submit(
    topUp({
      idempotencyKey: `idem_${orderId}`,
      actor: systemActor('docs'),
      userId: 'usr_alice',
      amount: credits(250),
      source: 'card',
    }),
  );
  await economy.submit(
    spend({
      idempotencyKey: orderId,
      actor: userActor('usr_alice'),
      orderId,
      buyerId: 'usr_alice',
      sku: 'Proof Demo Pass',
      price: credits(250),
      recipients: [{ sellerId: 'usr_nova', shareBps: 10_000 }],
    }),
  );

  const p = await economy.read.prove();
  const allGreen = p.conserved && p.backed && p.noOverdraft && p.chainIntact && p.consistent;
  const mark = (ok: boolean) => (ok ? 'holds' : 'FAILED');

  return {
    lines: [
      `conserved: ${mark(p.conserved)} · backed: ${mark(p.backed)} · ` +
        `no overdraft: ${mark(p.noOverdraft)}`,
      `chain intact: ${mark(p.chainIntact)} · consistent: ${mark(p.consistent)}`,
      allGreen
        ? 'all five re-derived and holding after your operations'
        : 'a check failed — that would be a bug worth reporting',
    ],
    consolePath: '/integrity',
  };
}
