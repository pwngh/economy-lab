import { credits, encodeAmount, spend, userActor } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// A rejection is data, not an exception: the reason code verbatim, plus the typed
// figures it carries — here the funds gate reporting what was required against what was
// available.
export async function run(economy: Economy): Promise<SnippetReport> {
  const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
  const outcome = await economy.submit(
    spend({
      idempotencyKey: orderId,
      actor: userActor('usr_newcomer'),
      orderId,
      buyerId: 'usr_newcomer', // an empty wallet
      sku: 'First Purchase',
      price: credits(250),
      recipients: [{ sellerId: 'usr_nova', shareBps: 10_000 }],
    }),
  );

  if (outcome.status !== 'rejected') {
    return {
      lines: [`status: ${outcome.status} — the newcomer has funds now; reset the economy to rerun`],
      consolePath: '/market',
    };
  }

  return {
    lines: [
      `status: ${outcome.status}`,
      `reason: ${outcome.reason}`,
      `required: ${outcome.detail?.required ? encodeAmount(outcome.detail.required) : '—'} · ` +
        `available: ${outcome.detail?.available ? encodeAmount(outcome.detail.available) : '—'}`,
    ],
    consolePath: '/market',
  };
}
