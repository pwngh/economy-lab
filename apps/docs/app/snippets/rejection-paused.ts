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

// ECONOMY_PAUSED, inside a live maintenance window: the user's discretionary write waits, the
// system's settlement does not, and the detail says when writes resume.
export async function run(): Promise<SnippetReport> {
  const resumesAt = Date.now() + 3_600_000; // the window closes in an hour
  const economy = createEconomy(
    memoryPorts({
      signingKey: 'docs-signing-key',
      config: { pauseStartMs: Date.now() - 1_000, pauseEndMs: resumesAt },
    }),
  );
  const funded = await economy.submit(
    topUp({
      idempotencyKey: 'idem_fund',
      actor: systemActor('payments'),
      userId: 'usr_p',
      amount: credits(100),
      source: 'card',
    }),
  );
  const paused = await economy.submit(
    spend({
      idempotencyKey: 'idem_try',
      actor: userActor('usr_p'),
      orderId: 'ord_p1',
      buyerId: 'usr_p',
      sku: 'Poster',
      price: credits(50),
      recipients: [{ sellerId: 'usr_s', shareBps: 10_000 }],
    }),
  );
  await economy.close();

  const minutes =
    paused.status === 'rejected' &&
    paused.detail.reason === 'ECONOMY_PAUSED' &&
    paused.detail.resumesAt !== null
      ? Math.round((paused.detail.resumesAt - Date.now()) / 60_000)
      : null;
  return {
    lines: [
      `system top-up in the window: ${funded.status} — settlement is never paused`,
      paused.status === 'rejected'
        ? `user spend in the window:    rejected (${paused.detail.reason})${minutes === null ? '' : ` — resumes in ~${minutes} min`}`
        : `user spend in the window:    ${paused.status}`,
    ],
    consolePath: '/controls',
  };
}
