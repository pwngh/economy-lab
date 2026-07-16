import { spendable } from '@pwngh/economy-lab';

import type { Economy } from '@pwngh/economy-lab';
import type { SnippetReport } from './context.ts';

// One block, three reads: a balance, an ownership check, and the pause status. Nothing
// here writes a ledger entry, claims a key, or counts toward a velocity window — run it
// as often as you like and the books never move.
export async function run(economy: Economy): Promise<SnippetReport> {
  const balance = await economy.read.balance(spendable('usr_alice'));
  const owns = await economy.read.entitled('usr_alice', 'Aurora Avatar');
  const status = economy.read.status();

  return {
    lines: [
      `balance: ${balance.minor / 100n} credits in usr_alice's spendable`,
      `entitled('usr_alice', 'Aurora Avatar') → ${owns} — ownership is a record, not a balance`,
      `status: ${status.paused ? 'paused' : 'open'}`,
    ],
    consolePath: '/wallets',
  };
}
