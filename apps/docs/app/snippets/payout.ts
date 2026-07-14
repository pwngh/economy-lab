import type { SnippetCtx, SnippetReport } from './context';

// A payout request reserves part of the seller's earned balance and opens a saga in RESERVED.
// From there the worker owns it: submit to the provider when due, settle or reverse.
export async function run(eco: SnippetCtx): Promise<SnippetReport> {
  const request = await eco.requestPayout({ userId: 'usr_nova', credits: 40 });

  return {
    lines: [
      `requestPayout: ${request.status} → ${request.transaction?.id ?? '—'}`,
      request.status === 'committed'
        ? 'the reserve moved out of earned; a saga card is now sitting in RESERVED'
        : `nothing reserved (${request.reason ?? 'refused'}) — a gate answered first`,
    ],
    consolePath: '/payouts',
  };
}
