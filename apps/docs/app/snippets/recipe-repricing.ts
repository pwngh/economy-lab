import {
  DEV_RATES,
  createEconomy,
  credits,
  memoryPorts,
  operatorActor,
  requestPayout,
  reversePayout,
  spend,
  systemActor,
  topUp,
  userActor,
} from '@pwngh/economy-lab';
import { configuredRates } from '@pwngh/economy-lab/adapters';

import type { Ports, RatesConfig } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// Rates freeze into an economy at construction, and construction asserts buy >= par. So a
// reprice is a rebuild over the SAME store with a fresh rate table: cheap (the store carries all
// the state), atomic (no reader ever sees a torn rate — each table hands out frozen Rate objects
// whose rateId embeds the value), and re-asserted (a bad table refuses to build).
export async function run(): Promise<SnippetReport> {
  // The demo raises the dev velocity ceiling so a payout-scale month of sales fits one window.
  let ports: Ports = memoryPorts({
    signingKey: 'docs-signing-key',
    config: { velocityLimitMinor: 10_000_000n },
  });
  let economy = createEconomy(ports);

  // A seller with a payout in flight — the exact state a reprice must not run over.
  await economy.submit(
    topUp({
      idempotencyKey: 'purchase_2026_07_usr_fan',
      actor: systemActor('payments'),
      userId: 'usr_fan',
      amount: credits(30_000),
      source: 'card',
    }),
  );
  await economy.submit(
    spend({
      idempotencyKey: 'spend_ord_rp1',
      actor: userActor('usr_fan'),
      orderId: 'ord_rp1',
      buyerId: 'usr_fan',
      sku: 'Gallery World',
      price: credits(25_000),
      recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
    }),
  );
  const request = await economy.submit(
    requestPayout({
      idempotencyKey: 'payout_2026_07_usr_creator',
      actor: userActor('usr_creator'),
      userId: 'usr_creator',
      amount: credits(20_000), // ≈ $100 at the payout rate
    }),
  );
  if (request.status !== 'committed') {
    return { lines: [`setup payout: ${request.status}`], consolePath: '/controls' };
  }

  // Quiesce first: a payout in flight was reserved at the old rate and would settle at the new.
  const inFlight = async (): Promise<number> => {
    let count = 0;
    for await (const saga of economy.read.payouts({
      states: ['REQUESTED', 'RESERVED', 'SUBMITTED'],
    })) {
      void saga;
      count += 1;
    }
    return count;
  };
  const beforeQuiesce = await inFlight();

  // Drain it: settle what the rail already took, unwind what it has not. This one is still
  // RESERVED, so the operator unwind returns the reserve to the seller's earned balance.
  await economy.submit(
    reversePayout({
      idempotencyKey: 'unwind_reprice_usr_creator',
      actor: operatorActor('op_7'),
      userId: 'usr_creator',
      sagaId: request.transaction.meta.sagaId as string,
      reason: 'reprice quiesce',
    }),
  );
  const afterQuiesce = await inFlight();

  const before = ports.rates.buy('CREDIT');

  // The reprice: a new table in a new bag, rebuilt over the same store.
  const next: RatesConfig = { ...DEV_RATES, buyRate: 9000n };
  ports = { ...ports, rates: configuredRates(next) };
  economy = createEconomy(ports);
  const after = ports.rates.buy('CREDIT');

  return {
    lines: [
      `payouts in flight before repricing: ${beforeQuiesce} — drain before the rebuild`,
      `after the unwind: ${afterQuiesce} in flight — safe to proceed`,
      `buy rate before: ${before.rateId}`,
      `buy rate after:  ${after.rateId}`,
    ],
    consolePath: '/controls',
  };
}
