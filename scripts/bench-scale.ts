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

// Scale benches, kept separate from scripts/bench.ts so the published tables stay untouched:
// a hot-seller curve with the accrual split off vs on, and submit micro-batching weighed
// against one operation per transaction.
//
//   node scripts/bench-scale.ts                          # in-memory + any reachable DB
//   BENCH_HOT_CONCURRENCY=8,32,64 node scripts/bench-scale.ts
//   sh scripts/docker.sh run --rm bench scripts/bench-scale.ts   # production-parity fsync
//
// The usual BENCH_* knobs apply (see scripts/support/harness.ts); BENCH_SHARDS below 2 is raised
// to 2 for the hot-seller pairs so the baseline is not itself bounded by bare platform rows.
// Every backend line prints its durability probe: a rate over commits that skip a real disk
// flush (macOS fsync) is shape, not capacity.

import { createEconomy } from '#src/economy.ts';
import { openInstanceEconomy } from '#src/instance.ts';
import { createReservations } from '#src/netting.ts';
import { proveChain } from '#src/chain.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { loadConfig } from '#src/config.ts';
import { sha256Digest } from '#src/digest.ts';
import { drainAccruals } from '#src/worker/accrual.ts';
import { readList } from '#src/env.ts';
import { topUp, spend, credit } from '#test/support/builders.ts';
import {
  defaultPricing,
  fakeProcessor,
  fixedClock,
  fixedRates,
  seededSigner,
  sequentialIds,
  silentMeter,
  testLogger,
  testSecrets,
} from '#test/support/capabilities.ts';
import {
  measureConcurrent,
  measureSequential,
  resolveConfig,
  tryProvision,
} from '#scripts/support/harness.ts';

import type {
  BackendName,
  HarnessConfig,
  Provisioned,
} from '#scripts/support/harness.ts';
import type { Economy, WorkerCtx } from '#src/contract.ts';
import type { Ports, Store } from '#src/ports.ts';

const cfg = resolveConfig(process.env);
const tag = `bs${process.pid.toString(36)}`;

// The in-flight depths the hot-seller curve samples. Each needs a pool of that many connections
// (plus headroom), so the ceiling is the server's max_connections, not this script.
const HOT_CONCURRENCIES: number[] = (() => {
  const listed = readList(process.env.BENCH_HOT_CONCURRENCY)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 1);
  return listed.length > 0 ? listed : [8, cfg.concurrency];
})();

const fmt = (rate: number): string => `${rate.toFixed(1)}/s`;
const out = (line: string): void => {
  process.stdout.write(line + '\n');
};

// The same policy the shared harness benches under (gates off), with the two knobs this script
// varies: the shard count and the accrual flag.
function scaleEconomy(
  store: Store,
  opts: { accrual: boolean; shards: number },
  ids = sequentialIds(cfg.seed),
): { economy: Economy; workerCtx: WorkerCtx } {
  const config = loadConfig({
    MATURITY_HORIZON_CARD_MS: '0',
    MATURITY_HORIZON_CRYPTO_MS: '0',
    MATURITY_HORIZON_DEFAULT_MS: '0',
    PAYOUT_MIN_EARNED_MINOR: '1',
    PAYOUT_MIN_INTERVAL_MS: '0',
    PLATFORM_SHARDS: String(opts.shards),
    VELOCITY_LIMIT_MINOR: '1000000000000000',
    ACCRUAL_DRAIN: opts.accrual ? '1' : '0',
  });
  const ports: Ports = {
    store,
    clock: fixedClock(0),
    ids,
    digest: sha256Digest(),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    pricing: defaultPricing(),
    logger: testLogger(),
    meter: silentMeter(),
    config,
    secrets: testSecrets(),
  };
  const workerCtx: WorkerCtx = {
    clock: ports.clock,
    ids: ports.ids,
    digest: ports.digest,
    signer: ports.signer,
    processor: ports.processor,
    rates: ports.rates,
    logger: ports.logger,
    meter: ports.meter,
    config,
  };
  return { economy: createEconomy(ports), workerCtx };
}

// --- Hot seller: one seller, N buyers, swept in-flight depth -----------------------

type HotResult = {
  rate: number;
  p99: number;
  errors: number;
  drainMs: number | null;
};

async function hotSellerOnce(
  provisioned: Provisioned,
  runCfg: HarnessConfig,
  accrual: boolean,
): Promise<HotResult> {
  const { economy, workerCtx } = scaleEconomy(provisioned.store, {
    accrual,
    shards: Math.max(2, runCfg.shards),
  });
  const seller = `usr_hot_seller_${tag}`;
  // A buyer pool at least the in-flight depth, so concurrent ops touch disjoint buyer rows and
  // the seller-side row is the only per-sale shared row under test.
  const buyers = Array.from(
    { length: Math.max(runCfg.concurrency, 16) },
    (_, i) => `usr_hot_${tag}_${accrual ? 'on' : 'off'}_${i}`,
  );
  const planned = runCfg.reps * runCfg.ops + runCfg.warmup + buyers.length;
  // +50 whole-credit headroom so warmup drift can't starve a buyer mid-run.
  const perBuyer = Math.ceil(planned / buyers.length) + 50;
  for (const buyer of buyers) {
    await economy.submit(
      topUp({ userId: buyer, amount: credit(`${perBuyer}.00`) }),
    );
  }
  const buy = (k: number): Promise<unknown> =>
    economy.submit(
      spend({
        buyerId: buyers[k % buyers.length]!,
        sku: `prod_${tag}`,
        price: credit('1.00'),
        orderId: `ord_hot_${tag}_${accrual ? 'on' : 'off'}_${k}`,
        recipients: [{ sellerId: seller, shareBps: 10_000 }],
      }),
    );
  // Warm every buyer and the seller-side rows so no timed op pays a chain-genesis race.
  const warmups = Math.max(runCfg.warmup, buyers.length);
  for (let warm = 0; warm < warmups; warm += 1) {
    await buy(1_000_000 + warm);
  }

  const result = await measureConcurrent(
    runCfg,
    runCfg.concurrency,
    (k) => buy(k),
    provisioned.counters,
  );

  // The split's full cost includes moving the parked shares on; time the drain over everything
  // the sample parked, and refuse a result that left money in the pool.
  let drainMs: number | null = null;
  if (accrual) {
    const t0 = performance.now();
    const summary = await drainAccruals(provisioned.store, workerCtx, {
      now: 0,
      limit: 1_000_000,
    });
    drainMs = performance.now() - t0;
    const stats = await provisioned.store.accruals.stats();
    if (summary.failed.length > 0 || stats.pendingMinor !== 0n) {
      throw new Error(
        `drain left the pool dirty: failed=${summary.failed.length} pending=${stats.pendingMinor}`,
      );
    }
  }
  return {
    rate: result.rate,
    p99: result.latency.p99,
    errors: result.errors,
    drainMs,
  };
}

// One (depth, flag) sample on its own fresh store and pool, so depths never share warm caches
// or leftover contention state and the off/on pair stays symmetric.
async function hotSellerAt(
  backend: BackendName,
  concurrency: number,
): Promise<{ off: HotResult; on: HotResult } | null> {
  const runCfg: HarnessConfig = { ...cfg, concurrency };
  const results: HotResult[] = [];
  for (const accrual of [false, true]) {
    const provisioned = await tryProvision(backend, runCfg);
    if (provisioned === null) {
      return null;
    }
    try {
      results.push(await hotSellerOnce(provisioned, runCfg, accrual));
    } finally {
      await provisioned.teardown();
    }
  }
  return { off: results[0]!, on: results[1]! };
}

async function hotSellerCurve(backend: BackendName): Promise<void> {
  for (const concurrency of HOT_CONCURRENCIES) {
    const pair = await hotSellerAt(backend, concurrency);
    if (pair === null) {
      return;
    }
    const { off, on } = pair;
    const gain = off.rate > 0 ? on.rate / off.rate : 0;
    out(
      `    hot seller @${String(concurrency).padStart(3)}  off ${fmt(off.rate)}  on ${fmt(on.rate)}  (${gain.toFixed(2)}x)` +
        `  p99 ${off.p99.toFixed(0)}ms->${on.p99.toFixed(0)}ms` +
        `  drain ${on.drainMs === null ? '-' : `${on.drainMs.toFixed(0)}ms`}` +
        (off.errors + on.errors > 0
          ? `  errors off=${off.errors} on=${on.errors}`
          : ''),
    );
  }
}

// --- Batched vs unbatched submits --------------------------------------------------

// 16: deep enough that fsync coalescing shows, shallow enough to be a realistic request burst.
const BATCH_SIZE = 16;

async function measureBatched(
  economy: Economy,
  freshTopUp: () => ReturnType<typeof topUp>,
): Promise<number> {
  // Timed the way measureSequential times: best rep over committed ops, budget-bounded.
  let bestPerOp = Infinity;
  for (let r = 0; r < cfg.reps; r += 1) {
    const t0 = performance.now();
    let done = 0;
    for (let i = 0; i < cfg.ops; i += BATCH_SIZE) {
      const size = Math.min(BATCH_SIZE, cfg.ops - i);
      const slots = await economy.submitBatch(
        Array.from({ length: size }, freshTopUp),
      );
      done += slots.filter(
        (slot) => slot.ok && slot.outcome.status === 'committed',
      ).length;
      if (performance.now() - t0 > cfg.budgetMs) {
        break;
      }
    }
    if (done > 0) {
      bestPerOp = Math.min(bestPerOp, (performance.now() - t0) / done);
    }
  }
  return bestPerOp === Infinity ? 0 : 1000 / bestPerOp;
}

async function batching(backend: BackendName): Promise<void> {
  const provisioned = await tryProvision(backend, cfg);
  if (provisioned === null) {
    return;
  }
  try {
    out(`    durability: ${provisioned.durability}`);
    const { economy } = scaleEconomy(provisioned.store, {
      accrual: false,
      shards: cfg.shards,
    });
    let n = 0;
    const freshTopUp = (): ReturnType<typeof topUp> =>
      topUp({ userId: `usr_bat_${tag}_${n++}`, amount: credit('10.00') });
    for (let i = 0; i < cfg.warmup; i += 1) {
      await economy.submit(freshTopUp());
    }

    const sequential = await measureSequential(cfg, () =>
      economy.submit(freshTopUp()),
    );
    const batched = await measureBatched(economy, freshTopUp);
    const gain = sequential.rate > 0 ? batched / sequential.rate : 0;
    out(
      `    batching    1-by-1 ${fmt(sequential.rate)}  x${BATCH_SIZE} ${fmt(batched)}  (${gain.toFixed(2)}x)`,
    );
  } finally {
    await provisioned.teardown();
  }
}

// --- The fast lane: session purchases at journal speed -----------------------------
//
// Per-session `instant` rate (no SQL amortized), per-session `permanent` rate (one grant upsert
// each), and M concurrent sessions against one database whose aggregate scales ~linearly in M.
// Every phase settles and then refuses its numbers unless the ledger proves exact seller/buyer
// balances, clearing at zero, chains intact, and the registry released.

const LANE_OPS = 4_000;
const LANE_BUYERS = 8;
// A product-real price: 600 credits for an in-world product. The production fee rounds up to
// whole credit units — 92.00 at the default 15.3% — so the seller nets exactly 508.00 = 50_800
// minor per purchase. Tiny prices are dishonest bench inputs: below ~7 credits the whole price
// rounds into the fee.
const LANE_PRICE = toAmount('CREDIT', 60_000n);

type LaneDeps =
  ReturnType<typeof scaleEconomy> extends never
    ? never
    : Parameters<typeof openInstanceEconomy>[0];

function laneDeps(
  provisioned: Provisioned,
  ids: ReturnType<typeof sequentialIds>,
): LaneDeps {
  const config = loadConfig({
    MATURITY_HORIZON_CARD_MS: '0',
    MATURITY_HORIZON_DEFAULT_MS: '0',
    VELOCITY_LIMIT_MINOR: '1000000000000000',
  });
  return {
    store: provisioned.store,
    digest: sha256Digest(),
    clock: fixedClock(0),
    ids,
    pricing: defaultPricing(),
    config,
    logger: testLogger(),
    meter: silentMeter(),
  };
}

// Funds one session's buyer pool through the main lane (a handful of slow-lane ops). The caller
// passes one funding economy per store: a fresh one per call would restart the txn id sequence
// and collide with its own earlier postings.
async function fundLaneBuyers(
  economy: Economy,
  session: string,
  ops: number,
): Promise<string[]> {
  // Total spend is ops x LANE_PRICE (60_000 minor); / 100 converts minor units to the whole
  // credits `credit()` takes, and +1_000 credits is headroom so no buyer runs dry mid-lane.
  const perBuyer = Math.ceil((ops * 60_000) / (LANE_BUYERS * 100)) + 1_000;
  const buyers = Array.from(
    { length: LANE_BUYERS },
    (_, i) => `usr_lane_${session}_${i}`,
  );
  for (const buyer of buyers) {
    await economy.submit(
      topUp({ userId: buyer, amount: credit(`${perBuyer}.00`) }),
    );
  }
  return buyers;
}

// One session's purchase storm, issued one at a time — the lane serializes concurrent callers
// itself, and sequential issue keeps the rate an honest per-purchase cost. Returns the
// wall-clock rate over accepted purchases; any rejection fails the phase (funding covers all).
async function laneStorm(
  deps: LaneDeps,
  input: {
    session: string;
    buyers: string[];
    seller: string;
    kind: 'instant' | 'permanent';
    ops: number;
    registry: ReturnType<typeof createReservations>;
  },
): Promise<{
  rate: number;
  settleMs: number;
  lane: ReturnType<typeof openInstanceEconomy>;
}> {
  const lane = openInstanceEconomy(deps, input.session, {
    reservations: input.registry,
  });
  const t0 = performance.now();
  for (let k = 0; k < input.ops; k += 1) {
    const outcome = await lane.purchase({
      buyerId: input.buyers[k % input.buyers.length]!,
      price: LANE_PRICE,
      recipients: [{ sellerId: input.seller, shareBps: 10_000 }],
      product: {
        kind: input.kind,
        sku: input.kind === 'instant' ? 'sku_play' : `sku_item_${k}`,
      },
    });
    if (outcome.status !== 'accepted') {
      throw new Error(`lane purchase rejected: ${JSON.stringify(outcome)}`);
    }
  }
  const acceptMs = performance.now() - t0;
  const s0 = performance.now();
  const report = await lane.settle();
  const settleMs = performance.now() - s0;
  if (report.rejected.length > 0) {
    throw new Error(`lane settle rejected ${report.rejected.length} movements`);
  }
  return { rate: (input.ops * 1000) / acceptMs, settleMs, lane };
}

async function proveLane(
  provisioned: Provisioned,
  deps: LaneDeps,
  expect: { seller: string; earnedMinor: bigint },
): Promise<void> {
  const earnedNow = await provisioned.store.ledger.balance(
    earned(expect.seller),
  );
  if (earnedNow.minor !== expect.earnedMinor) {
    throw new Error(
      `seller earned ${earnedNow.minor}, expected ${expect.earnedMinor}`,
    );
  }
  const clearing = await provisioned.store.ledger.balance(
    SYSTEM.NETTING_CLEARING,
  );
  if (clearing.minor !== 0n) {
    throw new Error(`clearing left at ${clearing.minor}`);
  }
  const chain = await proveChain({
    ledger: provisioned.store.ledger,
    digest: deps.digest,
  });
  if (!chain.intact) {
    throw new Error('chain failed to re-derive after the lane storm');
  }
}

async function fastLaneSingle(
  backend: BackendName,
  kind: 'instant' | 'permanent',
): Promise<void> {
  const provisioned = await tryProvision(backend, cfg);
  if (provisioned === null) {
    return;
  }
  try {
    // One id sequence per store: the funder and the lane must never re-mint each other's ids.
    const ids = sequentialIds(cfg.seed);
    const deps = laneDeps(provisioned, ids);
    const funder = scaleEconomy(
      provisioned.store,
      { accrual: false, shards: 1 },
      ids,
    ).economy;
    const ops = kind === 'instant' ? LANE_OPS : Math.min(LANE_OPS, 1_000);
    const buyers = await fundLaneBuyers(funder, `s1${kind}`, ops);
    const registry = createReservations();
    const seller = `usr_lane_seller_${kind}`;
    const { rate, settleMs } = await laneStorm(deps, {
      session: `sess:bench:${kind}:0`,
      buyers,
      seller,
      kind,
      ops,
      registry,
    });
    await proveLane(provisioned, deps, {
      seller,
      // 50_800 = seller's net per purchase at LANE_PRICE under the test fee; rots if either changes.
      earnedMinor: BigInt(ops) * 50_800n,
    });
    out(
      `    fast lane   ${kind.padEnd(9)} ${fmt(rate)} per session  settle ${settleMs.toFixed(0)}ms (${ops} ops)`,
    );
  } finally {
    await provisioned.teardown();
  }
}

// M sessions on one database, one shared seller (the settle-time worst case on purpose): the
// aggregate should scale ~linearly because sessions share nothing until their settles.
async function fastLaneAggregate(
  backend: BackendName,
  m: number,
): Promise<void> {
  const provisioned = await tryProvision(backend, cfg);
  if (provisioned === null) {
    return;
  }
  try {
    const ids = sequentialIds(cfg.seed);
    const deps = laneDeps(provisioned, ids);
    const registry = createReservations();
    const seller = 'usr_lane_seller_agg';
    const funder = scaleEconomy(
      provisioned.store,
      { accrual: false, shards: 1 },
      ids,
    ).economy;
    const pools: string[][] = [];
    for (let s = 0; s < m; s += 1) {
      pools.push(await fundLaneBuyers(funder, `agg${m}_${s}`, LANE_OPS));
    }
    const before = provisioned.counters ? await provisioned.counters() : null;
    const t0 = performance.now();
    const runs = await Promise.all(
      pools.map((buyers, s) =>
        laneStorm(deps, {
          session: `sess:bench:agg${m}:${s}`,
          buyers,
          seller,
          kind: 'instant',
          ops: LANE_OPS,
          registry,
        }),
      ),
    );
    const wallMs = performance.now() - t0;
    const after = provisioned.counters ? await provisioned.counters() : null;
    await proveLane(provisioned, deps, {
      seller,
      // Same 50_800 net-per-purchase figure as the single-lane prove above.
      earnedMinor: BigInt(m) * BigInt(LANE_OPS) * 50_800n,
    });
    const aggregate = (m * LANE_OPS * 1000) / wallMs;
    const settleTotal = runs.reduce((sum, run) => sum + run.settleMs, 0);
    const locks =
      before === null || after === null
        ? '-'
        : String(after.lockWaits - before.lockWaits);
    out(
      `    fast lane   x${String(m).padEnd(2)} sessions ${fmt(aggregate)} aggregate  settle ${settleTotal.toFixed(0)}ms total  db lock waits ${locks}`,
    );
  } finally {
    await provisioned.teardown();
  }
}

// --- Main --------------------------------------------------------------------------

async function main(): Promise<void> {
  out(
    `bench-scale: profile=${cfg.profile} ops=${cfg.ops} reps=${cfg.reps} shards>=${Math.max(2, cfg.shards)} ` +
      `hot-concurrency=[${HOT_CONCURRENCIES.join(',')}] batch=${BATCH_SIZE}`,
  );
  for (const backend of cfg.backends) {
    out(`  ${backend}`);
    // The batching pass prints the backend's durability probe first, so every number below it
    // reads against the rig's real commit cost.
    await batching(backend);
    if (backend !== 'in-memory') {
      await hotSellerCurve(backend);
    }
    await fastLaneSingle(backend, 'instant');
    await fastLaneSingle(backend, 'permanent');
    for (const m of [4, 16]) {
      await fastLaneAggregate(backend, m);
    }
  }
}

await main();
