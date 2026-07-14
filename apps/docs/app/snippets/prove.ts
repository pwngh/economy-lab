import type { SnippetCtx, SnippetReport } from './context';

// Move real money, then run the thorough prover: every hash and balance re-derived from the raw
// ledger lines — the same full audit the console's Integrity page runs beneath its light report.
export async function run(eco: SnippetCtx): Promise<SnippetReport> {
  await eco.deposit({ userId: 'usr_alice', credits: 250 });
  await eco.purchase({
    buyerId: 'usr_alice',
    sellerId: 'usr_nova',
    listing: 'Proof Demo Pass',
    credits: 250,
  });

  const p = await eco.proveFull();
  const mark = (ok: boolean) => (ok ? 'holds' : 'FAILED');

  return {
    lines: [
      `conserved: ${mark(p.conserved)} · backed: ${mark(p.backed)} · no overdraft: ${mark(p.noOverdraft)}`,
      `chain intact: ${mark(p.chainIntact)} · consistent: ${mark(p.consistent)}`,
      p.allGreen
        ? 'all five re-derived and holding after your operations'
        : 'a check failed — that would be a bug worth reporting',
    ],
    consolePath: '/integrity',
  };
}
