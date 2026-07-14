import type { SnippetCtx, SnippetReport } from './context';

// A rejection is data, not an exception: the reason code verbatim, plus the typed figures it
// carries — here the funds gate reporting what was required against what was available.
export async function run(eco: SnippetCtx): Promise<SnippetReport> {
  const spend = await eco.purchase({
    buyerId: 'usr_newcomer',
    sellerId: 'usr_nova',
    listing: 'First Purchase',
    credits: 250,
  });

  return {
    lines: [
      `status: ${spend.status}`,
      `reason: ${spend.reason ?? '—'}`,
      `required: ${String(spend.detail?.required ?? '—')} · available: ${String(spend.detail?.available ?? '—')}`,
    ],
    consolePath: '/market',
  };
}
