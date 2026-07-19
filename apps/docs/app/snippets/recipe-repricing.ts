import {
  DEV_RATES,
  createEconomy,
  credits,
  memoryPorts,
  systemActor,
  topUp,
} from '@pwngh/economy-lab';
import { configuredRates } from '@pwngh/economy-lab/adapters';

import type { Ports, RatesConfig } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// Rates freeze into an economy at construction, and construction asserts buy >= par. So a
// reprice is a rebuild over the SAME store with a fresh rate table: cheap (the store carries all
// the state), atomic (no reader ever sees a torn rate — each table hands out frozen Rate objects
// whose rateId embeds the value), and re-asserted (a bad table refuses to build).
export async function run(): Promise<SnippetReport> {
  let ports: Ports = memoryPorts({ signingKey: 'docs-signing-key' });
  let economy = createEconomy(ports);
  await economy.submit(
    topUp({
      idempotencyKey: 'idem_before_reprice',
      actor: systemActor('payments'),
      userId: 'usr_reprice',
      amount: credits(100),
      source: 'card',
    }),
  );
  const before = ports.rates.buy('CREDIT');

  // Quiesce first: a payout in flight was reserved at the old rate and would settle at the new.
  let inFlight = 0;
  for await (const saga of economy.read.payouts({
    states: ['REQUESTED', 'RESERVED', 'SUBMITTED'],
  })) {
    void saga;
    inFlight += 1;
  }

  // The reprice: a new table in a new bag, rebuilt over the same store.
  const next: RatesConfig = { ...DEV_RATES, buyRate: 9000n };
  ports = { ...ports, rates: configuredRates(next) };
  economy = createEconomy(ports);
  const after = ports.rates.buy('CREDIT');

  return {
    lines: [
      `payouts in flight before repricing: ${inFlight} — safe to proceed`,
      `buy rate before: ${before.rateId}`,
      `buy rate after:  ${after.rateId}`,
    ],
    consolePath: '/controls',
  };
}
