import type { SnippetCtx, SnippetReport } from './context';

// Six spends race a wallet that only covers two. The funds gate is the only limiter — it commits
// what the balance covers and refuses the rest, so the balance can never go negative. The wallet
// is a fresh throwaway, so every run races the same thin balance.
export async function run(eco: SnippetCtx): Promise<SnippetReport> {
  const buyerId = `usr_thin_${crypto.randomUUID().slice(0, 6)}`;
  await eco.deposit({ userId: buyerId, credits: 500 });

  const tally = await eco.drainWallet({
    buyerId,
    sellerId: 'usr_nova',
    listing: 'Docs Drain Listing',
    credits: 200,
    count: 6,
  });

  return {
    lines: [
      `attempts: ${tally.attempts}`,
      `committed: ${tally.committed} · refused INSUFFICIENT_FUNDS: ${tally.insufficient}`,
      `moved: ${tally.movedCredits} credits — never more than the wallet held`,
    ],
  };
}
