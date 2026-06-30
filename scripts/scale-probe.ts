// Scale probe: does per-op cost stay flat as one subject's history grows? Hammers ONE buyer
// (spend) and ONE creator (payout) and measures in-memory throughput in segments, so any
// O(history) cost shows up as ops/sec falling segment over segment. Not part of the suite; a
// diagnostic for the velocity / saga / maturity scaling work.
//
//   node scripts/scale-probe.ts            # default 8 segments of 500
//   SEG=1000 SEGMENTS=12 node scripts/scale-probe.ts

import { capabilitiesFromEnv, createEconomy } from '#src/index.ts';
import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import {
  defaultPricing,
  seededSigner,
  fakeProcessor,
  fixedRates,
} from '#test/support/capabilities.ts';

import type { Economy, ExternalPorts } from '#src/index.ts';

const ports: ExternalPorts = {
  pricing: defaultPricing(),
  signer: seededSigner(1),
  processor: fakeProcessor(),
  rates: fixedRates(),
};

// Gates off, exactly like scripts/bench.ts, so timings reflect ledger work, not rejections.
const ENV: Record<string, string> = {
  WEBHOOK_SECRET: 'probe',
  SIGNING_SECRET: 'probe',
  MATURITY_HORIZON_CARD_MS: '0',
  MATURITY_HORIZON_CRYPTO_MS: '0',
  MATURITY_HORIZON_DEFAULT_MS: '0',
  PAYOUT_MIN_EARNED_MINOR: '1',
  PAYOUT_MIN_INTERVAL_MS: '0',
  VELOCITY_LIMIT_MINOR: '1000000000000000',
};

const SEG = Number(process.env.SEG ?? 500);
const SEGMENTS = Number(process.env.SEGMENTS ?? 8);
const tag = Math.random().toString(36).slice(2, 8);

async function fresh(): Promise<Economy> {
  return createEconomy(await capabilitiesFromEnv(ENV, ports));
}

// Runs `op(k)` SEG*SEGMENTS times, printing ops/sec per SEG-sized segment. Flat column = O(1) per
// op; falling column = per-op cost grows with accumulated history.
async function curve(
  name: string,
  op: (k: number) => Promise<unknown>,
): Promise<void> {
  const rates: number[] = [];
  let k = 0;
  for (let s = 0; s < SEGMENTS; s++) {
    const t0 = performance.now();
    for (let i = 0; i < SEG; i++) {
      await op(k++);
    }
    rates.push((SEG / (performance.now() - t0)) * 1000);
  }
  const first = rates[0]!;
  const last = rates[rates.length - 1]!;
  console.warn(
    `\n${name}: ops/sec per ${SEG}-op segment (history grows left→right)`,
  );
  console.warn(
    '  ' + rates.map((r) => String(Math.round(r)).padStart(7)).join(' '),
  );
  console.warn(
    `  first ${Math.round(first).toLocaleString()} → last ${Math.round(last).toLocaleString()} ops/sec  (${(last / first).toFixed(2)}× — 1.00 is flat)`,
  );
}

async function spendCurve(): Promise<void> {
  const economy = await fresh();
  const buyer = `usr_sp_${tag}`;
  const creator = `usr_cr_${tag}`;
  await economy.submit(
    topUp({ userId: buyer, amount: credit('100000000.00') }),
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
  await economy.close();
}

async function payoutCurve(): Promise<void> {
  const economy = await fresh();
  const buyer = `usr_pb_${tag}`;
  const creator = `usr_pc_${tag}`;
  await economy.submit(
    topUp({ userId: buyer, amount: credit('1000000000.00') }),
  );
  // Over-fund the creator's earned balance so every payout below is affordable and mature.
  const funding = Math.ceil((SEG * SEGMENTS * 1.5) / 300) + 5;
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
  await economy.close();
}

console.warn(
  `=== in-memory scale probe: ${SEGMENTS} segments × ${SEG} ops, Node ${process.version} ===`,
);
await spendCurve();
await payoutCurve();
// eslint-disable-next-line n/no-process-exit
process.exit(0);
