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

// Scale probe: does per-op cost stay flat as one subject's history grows? One buyer (spend) and one
// seller (payout) are hammered in SEG-sized segments — a flat ops/sec row is O(1) in that subject's
// history, a falling row is O(history). Runs over the shared harness backends (scripts/support/harness.ts).
//
//   node scripts/scale.ts                                  # in-memory + any reachable DB
//   SEG=1000 SEGMENTS=12 node scripts/scale.ts             # bigger curve

import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import {
  isCommitted,
  proveGate,
  resolveConfig,
  tryProvision,
  urlFor,
} from '#scripts/support/harness.ts';

import type { Economy } from '#src/index.ts';

// The one capture of process.env, and the one parse: everything below reads cfg, never env.
const cfg = resolveConfig(process.env);
const SEG = cfg.segmentSize;
const SEGMENTS = cfg.segments;
const tag = `s${process.pid.toString(36)}`;

const nowMs = (): number => performance.now();

async function curve(
  name: string,
  op: (k: number) => Promise<unknown>,
): Promise<number[]> {
  // A slow backend runs a curve for minutes; the header keeps that from reading as a hang.
  console.warn(
    `\n  ${name}: ops/sec per ${SEG}-op segment (history grows left->right)`,
  );
  const rates: number[] = [];
  let k = 0;
  // Discard one full segment first, or JIT warmup makes a flat curve read as "improving".
  for (let w = 0; w < SEG; w++) await op(k++);
  for (let s = 0; s < SEGMENTS; s++) {
    const t0 = nowMs();
    let committed = 0;
    for (let i = 0; i < SEG; i++) {
      if (isCommitted(await op(k++))) committed += 1;
    }
    rates.push((committed / (nowMs() - t0)) * 1000);
  }
  const first = rates[0]!;
  const last = rates[rates.length - 1]!;
  console.warn(
    '    ' + rates.map((r) => String(Math.round(r)).padStart(7)).join(' '),
  );
  console.warn(
    `    first ${Math.round(first).toLocaleString()} -> last ${Math.round(last).toLocaleString()} ops/sec  (${(last / first).toFixed(2)}* — 1.00 is flat)`,
  );
  return rates;
}

async function spendCurve(economy: Economy): Promise<void> {
  const buyer = `usr_sp_${tag}`;
  const seller = `usr_cr_${tag}`;
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
        recipients: [{ sellerId: seller, shareBps: 10_000 }],
      }),
    ),
  );
}

async function payoutCurve(economy: Economy): Promise<void> {
  const buyer = `usr_pb_${tag}`;
  const seller = `usr_pc_${tag}`;
  await economy.submit(
    topUp({ userId: buyer, amount: credit('1000000000.00') }),
  );
  // Over-fund the seller's earned balance so every payout below is affordable and mature — covering
  // the warmup segment plus all timed segments.
  const funding = Math.ceil((SEG * (SEGMENTS + 1) * 1.5) / 300) + 5;
  for (let i = 0; i < funding; i++) {
    await economy.submit(
      spend({
        buyerId: buyer,
        sku: `prod_${tag}`,
        price: credit('1000.00'),
        orderId: `fund_${tag}_${i}`,
        recipients: [{ sellerId: seller, shareBps: 10_000 }],
      }),
    );
  }
  await curve('requestPayout (one seller)', () =>
    economy.submit(requestPayout({ userId: seller, amount: credit('1.00') })),
  );
}

console.warn(
  `=== scale probe: ${SEGMENTS} segments * ${SEG} ops, Node ${process.version} ===`,
);

// A failed prove gate exits non-zero: never report a scaling curve over a ledger that fails its invariants.
let anyProveFailed = false;

for (const backend of cfg.backends) {
  console.warn(`\n${backend}:`);
  if (backend !== 'in-memory') {
    console.warn(`  connecting to ${urlFor(cfg, backend)}`);
  }
  const p = await tryProvision(backend, cfg);
  if (!p) continue;
  try {
    console.warn(`  ${p.durability}`);
    await spendCurve(p.economy);
    await payoutCurve(p.economy);
    const ok = await proveGate(p, '  prove: ');
    if (!ok) {
      anyProveFailed = true;
    }
  } catch (e) {
    // Contain the failure so the remaining backends still run, but a backend that provisioned and
    // then threw fails the run — not a provisioning skip.
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
