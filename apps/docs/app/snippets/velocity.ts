import type { SnippetCtx, SnippetReport } from './context';

// Arm the risk screen, then spend past it. The gate counts value moved inside a rolling window;
// the spend that crosses the ceiling declines as RISK_DENIED, with the subject named.
export async function run(eco: SnippetCtx): Promise<SnippetReport> {
  await eco.setVelocityLimit(100);

  const spend = await eco.purchase({
    buyerId: 'usr_alice',
    sellerId: 'usr_nova',
    listing: 'Velocity Test Pass',
    credits: 500,
  });

  return {
    lines: [
      'velocity ceiling armed: 100 credits per window',
      `spend of 500: ${spend.status} (${spend.reason ?? '—'})`,
    ],
    consolePath: '/controls',
  };
}
