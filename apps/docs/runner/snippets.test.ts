/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// Every Runnable block's snippet, run for real against the console's seeded engine — the lines a
// docs page prints are asserted here, so a snippet that stops doing what its page says fails CI.
import { expect, it } from 'vitest';

import { buildEngine } from '../console/app/economy';
import { run as drain } from './app/snippets/drain';
import { run as idempotency } from './app/snippets/idempotency';
import { run as payout } from './app/snippets/payout';
import { run as prove } from './app/snippets/prove';
import { run as recipeAllowance } from './app/snippets/recipe-allowance';
import { run as recipeEntitlementGate } from './app/snippets/recipe-entitlement-gate';
import { run as recipeFeeSplit } from './app/snippets/recipe-fee-split';
import { run as recipePromo } from './app/snippets/recipe-promo';
import { run as recipeRepricing } from './app/snippets/recipe-repricing';
import { run as rejection } from './app/snippets/rejection';
import { run as rejectionMaturity } from './app/snippets/rejection-maturity';
import { run as rejectionPaused } from './app/snippets/rejection-paused';
import { run as rejectionPayoutGates } from './app/snippets/rejection-payout-gates';
import { run as rejectionRecords } from './app/snippets/rejection-records';
import { run as velocity } from './app/snippets/velocity';

it('idempotency: first committed, retry duplicate, one posting', async () => {
  const eco = await buildEngine();
  const report = await idempotency(eco.economy);
  expect(report.lines[0]).toMatch(/first: {2}committed → txn_/);
  expect(report.lines[1]).toMatch(/again: {2}duplicate — same transaction/);
  expect(report.txnId).toMatch(/^txn_/);
});

it('drain: six racing spends — two commit, four refuse, wallet at zero', async () => {
  const eco = await buildEngine();
  const report = await drain(eco.economy);
  expect(report.lines[0]).toBe('attempts: 6 — all in flight at once');
  expect(report.lines[1]).toBe('committed: 2 · refused INSUFFICIENT_FUNDS: 4');
  expect(report.lines[2]).toContain('left in the wallet: 0 credits');
});

it('rejection: an empty wallet declines with the real figures', async () => {
  const eco = await buildEngine();
  const report = await rejection(eco.economy);
  expect(report.lines[0]).toBe('status: rejected');
  expect(report.lines[1]).toBe('reason: INSUFFICIENT_FUNDS');
  expect(report.lines[2]).toMatch(/need: .+ · have: .+/);
});

it('payout: the request reserves and parks a saga in RESERVED', async () => {
  const eco = await buildEngine();
  const report = await payout(eco.economy);
  expect(report.lines[0]).toMatch(/requestPayout: committed → txn_/);
  expect(report.lines[1]).toMatch(/saga pay_.+: RESERVED/);
});

it('prove: all five flags hold after the run', async () => {
  const eco = await buildEngine();
  const report = await prove(eco.economy);
  expect(report.lines[2]).toBe('all five re-derived and holding after your operations');
});

it('velocity: its own economy arms the ceiling and the second spend declines', async () => {
  const report = await velocity();
  expect(report.lines[1]).toBe('spend of 160: committed — 160 of 300 out this window');
  expect(report.lines[2]).toMatch(
    /160 more: rejected \(RISK_DENIED\) — the outflow window at its 300-credit limit/,
  );
});

it('rejection-records: five record-keyed declines, each naming its record', async () => {
  const report = await rejectionRecords();
  expect(report.lines[0]).toMatch(/DUPLICATE_ORDER — detail .*ord_r1/);
  expect(report.lines[1]).toMatch(/UNKNOWN_ORDER — detail .*ord_ghost/);
  expect(report.lines[2]).toMatch(/UNKNOWN_SUBSCRIPTION — detail .*sub_ghost/);
  expect(report.lines[3]).toMatch(/ALREADY_SUBSCRIBED — detail .*"sku":"Club"/);
  expect(report.lines[4]).toMatch(/NOT_ENTITLED — detail .*sku_never_granted/);
});

it('rejection-payout-gates: the three gates trip in check order', async () => {
  const report = await rejectionPayoutGates();
  expect(report.lines[0]).toMatch(/BELOW_MINIMUM — detail .*"minimum":"CREDIT:100\.00"/);
  expect(report.lines[1]).toMatch(/PAYOUT_TOO_SOON — detail .*"retryAt"/);
  expect(report.lines[2]).toMatch(/PAYEE_UNVERIFIED — detail .*"userId":"usr_pending"/);
});

it('rejection-maturity: held card credit declines with when it clears', async () => {
  const report = await rejectionMaturity();
  expect(report.lines[0]).toBe('status: rejected (FUNDS_IMMATURE)');
  expect(report.lines[1]).toMatch(/"source":"card"/);
  expect(report.lines[1]).toMatch(/"availableAt":\d+/);
});

it('rejection-paused: the window stops the user write and not the settlement', async () => {
  const report = await rejectionPaused();
  expect(report.lines[0]).toBe(
    'system top-up in the window: committed — settlement is never paused',
  );
  expect(report.lines[1]).toMatch(/rejected \(ECONOMY_PAUSED\) — resumes in ~\d+ min/);
});

it('recipe promo: the grant draws first and leaves spendable whole', async () => {
  const report = await recipePromo();
  expect(report.lines[2]).toBe('promo left: CREDIT:50.00 · spendable untouched: CREDIT:100.00');
});

it('recipe repricing: quiesced, then a rebuild mints a new rateId', async () => {
  const report = await recipeRepricing();
  expect(report.lines[0]).toBe('payouts in flight before repricing: 0 — safe to proceed');
  expect(report.lines[1]).not.toBe(report.lines[2]);
});

it('recipe entitlement gate: the sale itself flips read.entitled', async () => {
  const report = await recipeEntitlementGate();
  expect(report.lines[0]).toBe("entitled('usr_g', 'wrld_cape') before the purchase: false");
  expect(report.lines[2]).toBe("entitled('usr_g', 'wrld_cape') after: true");
});

it('recipe fee split: fee off the top, shares of the net, leftover to the house', async () => {
  const report = await recipeFeeSplit();
  expect(report.lines[1]).toMatch(/artist \(6,000 bps\): {3}CREDIT:/);
  expect(report.lines[3]).toMatch(/house \(fee \+ rounding leftover\): CREDIT:/);
});

it('recipe allowance: the period key absorbs the double fire', async () => {
  const report = await recipeAllowance();
  expect(report.lines[0]).toBe('2026-07 fired:    committed');
  expect(report.lines[1]).toBe('2026-07 re-fired: duplicate — the key absorbed the retry');
  expect(report.lines[2]).toBe('2026-08 fired:    committed');
  expect(report.lines[3]).toBe('two months, one retry, balance: CREDIT:100.00');
});

// Every Runnable a page renders must resolve in the engine's registry, or its Run button
// renders a wiring fault — this walks the content tree so an unregistered name fails CI
// instead of shipping a dead button.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SNIPPETS } from './engine.ts';

function runnableNames(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...runnableNames(full));
    else if (entry.name.endsWith('.mdx')) {
      const source = readFileSync(full, 'utf8');
      for (const m of source.matchAll(/<Runnable\s+name="([^"]+)"/g)) out.push(m[1]);
    }
  }
  return out;
}

it('every Runnable on a page is registered in the engine', () => {
  const used = runnableNames(new URL('../app/content/', import.meta.url).pathname);
  expect(used.length).toBeGreaterThan(0);
  const missing = used.filter((name) => !(name in SNIPPETS));
  expect(missing).toEqual([]);
});

// The sandbox executor, driven exactly as the workbench drives it: raw snippet source in, the
// pitch's edit applied, faults and logs on their own channels. Only the iframe/postMessage
// plumbing is left to the browser.
import { execute } from './sandbox-worker.ts';

const velocitySource = readFileSync(
  new URL('../app/snippets/velocity.ts', import.meta.url),
  'utf8',
);

it('sandbox: the shipped source runs unchanged, type-stripped', async () => {
  const result = await execute(velocitySource, []);
  expect(result.error).toBeUndefined();
  expect(result.lines[2]).toMatch(/160 more: rejected \(RISK_DENIED\)/);
});

it('sandbox: the pitch edit — shrink the spends under the window and both commit', async () => {
  const edited = velocitySource.replace('const PRICE = 160', 'const PRICE = 100');
  const result = await execute(edited, []);
  expect(result.error).toBeUndefined();
  expect(result.lines[2]).toBe('100 more: committed');
});

it('sandbox: edited runs journal their operations for the console handoff', async () => {
  const idempotencySource = readFileSync(
    new URL('../app/snippets/idempotency.ts', import.meta.url),
    'utf8',
  );
  const result = await execute(idempotencySource, []);
  expect(result.error).toBeUndefined();
  // topUp + the spend submitted twice — the duplicate replay is journaled too.
  expect(result.ops).toHaveLength(3);
  expect(result.ops[0]).toMatchObject({ kind: 'topUp' });
});

it('sandbox: an import outside the published surface is refused with the reason', async () => {
  const result = await execute(
    "import { readFileSync } from 'node:fs';\nexport async function run() { return { lines: [String(readFileSync('/etc/hosts'))] }; }",
    [],
  );
  expect(result.error).toMatch(/Cannot import "node:fs".*published package exports/);
});

it('sandbox: reader logs come back on their own channel', async () => {
  const result = await execute(
    "export async function run() { console.log('hello from the reader'); return { lines: ['done'] }; }",
    [],
  );
  expect(result.logs).toEqual(['hello from the reader']);
  expect(result.lines).toEqual(['done']);
});

it('sandbox: code without a run export gets a teaching error, not a crash', async () => {
  const result = await execute('const x = 1;', []);
  expect(result.error).toMatch(/must export an async function `run`/);
});

import { run as chAuthSolved } from '../app/snippets/challenge-authorization.solution.ts';
// The challenges: each starting file's bug must reproduce and each solution must fix it — the
// answer key is executable, so it can't rot.
import { run as chAuth } from '../app/snippets/challenge-authorization.ts';
import { run as chIdemSolved } from '../app/snippets/challenge-idempotency.solution.ts';
import { run as chIdem } from '../app/snippets/challenge-idempotency.ts';

it('challenge idempotency: the naive retry double-charges; the solution charges once', async () => {
  const eco = await buildEngine();
  const bug = await chIdem(eco.economy);
  expect(bug.lines[1]).toContain('committed: 2 — the buyer paid twice for one cart');
  const fixed = await chIdemSolved(eco.economy);
  expect(fixed.lines[0]).toBe('first: committed · retry: duplicate');
  expect(fixed.lines[1]).toContain('committed: 1 — one cart, one charge');
});

it('challenge authorization: the wrong principal faults; the fix commits', async () => {
  const eco = await buildEngine();
  await expect(chAuth(eco.economy)).rejects.toMatchObject({ code: 'AUTH.UNAUTHORIZED' });
  const fixed = await chAuthSolved(eco.economy);
  expect(fixed.lines[0]).toMatch(/order: committed → txn_/);
});

// The console wallet view reports exact display strings ("3,050.00"); parse one back to a
// number for the harness arithmetic.
const creditsOf = (display: string | undefined): number =>
  Number((display ?? '0').replace(/,/g, ''));

it('flagship: the-economy block shows the balance moving, before to after', async () => {
  const eco = await buildEngine();
  const before = creditsOf((await eco.wallet('usr_alice'))?.purchased);
  const { run: flagship } = await import('../app/snippets/the-economy.ts');
  const report = await flagship(eco.economy);
  expect(report.lines[0]).toMatch(/outcome: committed → txn_/);
  expect(report.lines[1]).toBe(
    `usr_alice spendable: ${before} → ${before + 50} credits (moved 50)`,
  );
});

it('legs: the sale posts balanced legs and balanceDelta reads the buyer side', async () => {
  const eco = await buildEngine();
  const { run: legs } = await import('../app/snippets/legs.ts');
  const report = await legs(eco.economy);
  expect(report.lines[0]).toMatch(/^\d+ legs, summing to 0n — the posting balances$/);
  expect(report.lines[1]).toBe("buyer's leg via balanceDelta: -10 credits");
  expect(report.txnId).toMatch(/^txn_/);
});

it('reads: three reads answer without moving the books', async () => {
  const eco = await buildEngine();
  const before = creditsOf((await eco.wallet('usr_alice'))?.purchased);
  const { run: reads } = await import('../app/snippets/reads.ts');
  const report = await reads(eco.economy);
  expect(report.lines[0]).toBe(`balance: ${before} credits in usr_alice's spendable`);
  expect(report.lines[1]).toContain("entitled('usr_alice', 'Aurora Avatar') → true");
  expect(report.lines[2]).toBe('status: open');
  const after = creditsOf((await eco.wallet('usr_alice'))?.purchased);
  expect(after).toBe(before);
});
