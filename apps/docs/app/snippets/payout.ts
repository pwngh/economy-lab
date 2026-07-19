import { credits, requestPayout, userActor } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// A payout request reserves part of the seller's earned balance and opens a saga in
// RESERVED. From there the worker owns it: submit to the provider when due, settle or
// reverse.
export async function run(economy: Economy): Promise<SnippetReport> {
  const request = await economy.submit(
    requestPayout({
      idempotencyKey: `idem_${crypto.randomUUID().slice(0, 8)}`,
      actor: userActor('usr_nova'),
      userId: 'usr_nova',
      amount: credits(40), // drawn from earned revenue
    }),
  );

  if (request.status !== 'committed') {
    return {
      lines: [
        `requestPayout: ${request.status}` +
          `${request.status === 'rejected' ? ` (${request.detail.reason})` : ''} — a gate answered first`,
      ],
      consolePath: '/payouts',
    };
  }

  // The transaction meta names the saga this request opened, parked until the worker's sweep.
  const sagaId = request.transaction.meta.sagaId as string;
  const saga = await economy.read.saga(sagaId);

  const held = 'the reserve holds the credits until the worker submits';
  return {
    lines: [
      `requestPayout: committed → ${request.transaction.id}`,
      `saga ${saga?.id ?? '—'}: ${saga?.state ?? '—'} — ${held}`,
    ],
    consolePath: '/payouts',
  };
}
