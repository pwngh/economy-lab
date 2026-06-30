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

// Scale probe: does per-op cost stay flat as one subject's history grows? It hammers one buyer
// (spend) and one creator (payout) and measures throughput in segments, so O(history) cost shows up
// as ops/sec falling segment over segment — a flat row is O(1) in that subject's history.
//
// Built on the shared harness (scripts/support/harness.ts), so it runs over the same backends the
// bench does, each in its own reseeded throwaway schema/database. Running it against Postgres/MySQL —
// not just in-memory — is how an O(history) effect on a real engine shows up directly (for example
// index depth, or a chain that lengthens on one hot account), which is the kind of cost a
// bloated shared database incurs.
//
//   node scripts/scale-probe.ts                                  # in-memory + any reachable DB
//   SEG=1000 SEGMENTS=12 node scripts/scale-probe.ts             # bigger curve
//   BENCH_BACKENDS=postgres SEG=500 node scripts/scale-probe.ts  # one backend
//
// Knobs: SEG (segment size), SEGMENTS (count), plus the harness knobs (BENCH_BACKENDS, the URLs, etc.).

import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import {
  isCommitted,
  maskUrl,
  proveEconomyOrReport,
  resolveConfig,
  tryProvision,
} from '#scripts/support/harness.ts';

import type { Economy } from '#src/index.ts';

const cfg = resolveConfig();
const SEG = cfg.segmentSize;
const SEGMENTS = cfg.segments;
const tag = `s${process.pid.toString(36)}`;

const nowMs = (): number => performance.now();

// Runs `op(k)` SEG×SEGMENTS times, printing ops/sec per SEG-sized segment. Flat column = O(1) per op
// in this subject's history; falling column = per-op cost grows with accumulated history.
async function curve(
  name: string,
  op: (k: number) => Promise<unknown>,
): Promise<number[]> {
  const rates: number[] = [];
  let k = 0;
  // Discard one full segment first so JIT warmup doesn't inflate the first timed segment — without
  // this, a flat curve reads as "improving", the opposite of the O(history) effect this probe
  // measures (most visible on the always-warm in-memory backend).
  for (let w = 0; w < SEG; w++) await op(k++);
  for (let s = 0; s < SEGMENTS; s++) {
    const t0 = nowMs();
    let committed = 0; // count committed ops only; a rejection is not real throughput
    for (let i = 0; i < SEG; i++) {
      if (isCommitted(await op(k++))) committed += 1;
    }
    rates.push((committed / (nowMs() - t0)) * 1000);
  }
  const first = rates[0]!;
  const last = rates[rates.length - 1]!;
  console.warn(
    `\n  ${name}: ops/sec per ${SEG}-op segment (history grows left→right)`,
  );
  console.warn(
    '    ' + rates.map((r) => String(Math.round(r)).padStart(7)).join(' '),
  );
  console.warn(
    `    first ${Math.round(first).toLocaleString()} → last ${Math.round(last).toLocaleString()} ops/sec  (${(last / first).toFixed(2)}× — 1.00 is flat)`,
  );
  return rates;
}

async function spendCurve(economy: Economy): Promise<void> {
  const buyer = `usr_sp_${tag}`;
  const creator = `usr_cr_${tag}`;
  // Fund the buyer for every sale the whole curve will run — the warmup segment plus all timed
  // segments — with margin.
  const credits = (SEG * (SEGMENTS + 1) + 1000).toString();
  await economy.submit(
    topUp({ userId: buyer, amount: credit(`${credits}.00`) }),
  );
  await curve('spend (one buyer)', (k) =>
    economy.submit(
      spend({
        buyerId: buyer,
        sku: `prod_${tag}`,
        price: credit('1.00'),
        orderId: `ord_${tag}_${k}`,
        recipients: [{ sellerId: creator, shareBps: 10_000 }],
      }),
    ),
  );
}

async function payoutCurve(economy: Economy): Promise<void> {
  const buyer = `usr_pb_${tag}`;
  const creator = `usr_pc_${tag}`;
  await economy.submit(
    topUp({ userId: buyer, amount: credit('1000000000.00') }),
  );
  // Over-fund the creator's earned balance so every payout below is affordable and mature — covering
  // the warmup segment plus all timed segments.
  const funding = Math.ceil((SEG * (SEGMENTS + 1) * 1.5) / 300) + 5;
  for (let i = 0; i < funding; i++) {
    await economy.submit(
      spend({
        buyerId: buyer,
        sku: `prod_${tag}`,
        price: credit('1000.00'),
        orderId: `fund_${tag}_${i}`,
        recipients: [{ sellerId: creator, shareBps: 10_000 }],
      }),
    );
  }
  await curve('requestPayout (one creator)', () =>
    economy.submit(requestPayout({ userId: creator, amount: credit('1.00') })),
  );
}

console.warn(
  `=== scale probe: ${SEGMENTS} segments × ${SEG} ops, Node ${process.version} ===`,
);

// Set if any backend's prove gate fails, so the probe exits non-zero rather than reporting a
// scaling curve over a ledger that no longer passes its invariants — the same correctness gate the
// bench enforces.
let anyProveFailed = false;

for (const backend of cfg.backends) {
  console.warn(`\n${backend}:`);
  if (backend !== 'in-memory') {
    console.warn(
      `  connecting to ${maskUrl(backend === 'postgres' ? cfg.urls.postgres : cfg.urls.mysql)}`,
    );
  }
  const p = await tryProvision(backend, cfg);
  if (!p) continue;
  try {
    console.warn(`  ${p.durability}`);
    await spendCurve(p.economy);
    await payoutCurve(p.economy);
    const { ok, report } = await proveEconomyOrReport(p.economy);
    if (ok) {
      console.warn('  prove: PASS — every invariant holds');
    } else {
      anyProveFailed = true;
      console.warn(`  prove: FAIL — ${JSON.stringify(report)}`);
    }
  } catch (e) {
    // Contain a mid-run failure to this backend so the remaining backends still run, but a backend that
    // provisioned and then THREW is a failure, not a provisioning skip: fail the run loudly so it can
    // never be mistaken for a clean pass.
    anyProveFailed = true;
    console.warn(
      `  FAILED ${backend}: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await p.teardown();
  }
}

if (anyProveFailed) {
  console.warn(
    '\nFAIL: a prove gate failed or a backend errored mid-run — see above. Exiting non-zero.',
  );
}
// eslint-disable-next-line n/no-process-exit
process.exit(anyProveFailed ? 1 : 0);
