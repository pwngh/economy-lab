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

// Benchmarks for the economy. Both run through the real composition root, the same
// `capabilitiesFromEnv` -> `createEconomy` wiring that `make demo` and `make start` use:
//
//   1. Submit throughput (ops/sec, sequential) for topUp, spend, and requestPayout, per storage
//      backend. The backends are in-memory, plus Postgres and MySQL when reachable; an unreachable
//      backend is skipped, as in `make smoke`. This shows the engine cost of the double-entry and
//      hash-chain guarantees.
//   2. Integrity cost vs ledger size (in-memory). This shows how prove() and a checkpoint seal grow
//      with history, since both re-walk every posting from genesis (O(postings)), against checkpoint
//      verify, which reads only account heads (O(accounts), so it stays roughly flat).
//
// These are LAB numbers: one process, sequential submits (no pipelining), in-memory by default. They
// characterize relative cost and scaling shape, not production capacity. The policy gates (maturity,
// velocity, payout interval and minimum) are neutralized via env so the timings reflect ledger work,
// not rejections.
//
// See https://economy-lab-docs.pages.dev/economy/reference/performance/ for what these two tables
// measure and how to read the scaling shape.
//
//   node scripts/bench.ts                 # or: make bench   (in-memory; + any DB that's up)
//   BENCH_OPS=5000 node scripts/bench.ts  # heavier throughput sample
//
// SQL backends need their schema applied first (`make db-migrate`); the bench skips a backend it
// can't reach or whose schema is missing. Postgres :5432, MySQL :3306 (docker compose up -d).

import {
  capabilitiesFromEnv,
  createEconomy,
  workerCtxFrom,
} from '#src/index.ts';
import { sealCheckpoint, reverifyCheckpoint } from '#src/worker/checkpoint.ts';
import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import {
  defaultPricing,
  seededSigner,
  fakeProcessor,
  fixedRates,
} from '#test/support/capabilities.ts';

import type { Amount, Economy, ExternalPorts } from '#src/index.ts';

// External ports have no built-in stand-in, so the deterministic test doubles serve the bench. The
// bench measures the ledger, not the FX feed or the payout rail, so a fake feed and rail are fine.
const ports: ExternalPorts = {
  pricing: defaultPricing(),
  signer: seededSigner(1),
  processor: fakeProcessor(),
  rates: fixedRates(),
};

// Env shared by every run. It holds the required secrets, plus the policy gates turned off so a
// high-volume burst of one subject's operations is not held back by maturity, velocity, or the
// payout interval and minimum. None of those gates is what these timings are about. This object
// deliberately does NOT inherit process.env, so the gate settings stay controlled. Backend DSNs are
// merged in explicitly below.
const BASE_ENV: Record<string, string> = {
  WEBHOOK_SECRET: 'bench-webhook-secret',
  SIGNING_SECRET: 'bench-signing-secret',
  MATURITY_HORIZON_CARD_MS: '0',
  MATURITY_HORIZON_CRYPTO_MS: '0',
  MATURITY_HORIZON_DEFAULT_MS: '0',
  PAYOUT_MIN_EARNED_MINOR: '1',
  PAYOUT_MIN_INTERVAL_MS: '0',
  VELOCITY_LIMIT_MINOR: '1000000000000000',
};

const OPS = Number(process.env.BENCH_OPS ?? 500); // measured ops per throughput sample
const REPS = 3; // throughput is the best (fastest) of this many runs
const WARMUP = 50; // discarded ops before timing, to let the JIT settle
const CURVE_USERS = 20; // fixed user set for the curves: accounts stay ~flat, history grows
const CURVE_SIZES = [500, 1000, 2000, 4000]; // top-ups seeded before each measurement
const CURVE_REPS = 2; // integrity measurements are the best of this many

// Per-process tag so ids are unique across runs (SQL backends keep their rows between runs).
const tag = Math.random().toString(36).slice(2, 8);

const nowMs = (): number => performance.now();

// Runs `fn` `reps` times and returns the fastest run, in ms. The fastest run is the cleanest single
// number to report under GC and JIT noise.
async function bestMs(
  reps: number,
  fn: () => Promise<unknown>,
): Promise<number> {
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = nowMs();
    await fn();
    best = Math.min(best, nowMs() - t0);
  }
  return best;
}

// Per-op-type time budget. A backend whose per-call cost grows with accumulated state caps out here
// instead of hanging the whole run for minutes. That state can be reserves, risk attempts, or lots
// piling up on one subject over a real database.
const BUDGET_MS = 5000;

// Returns ops/sec for `perOp`, the best of REPS runs. Each run stops at BUDGET_MS, and the rate is
// taken from the ops that actually completed. A slow or degrading backend therefore bounds its own
// time and still reports a representative number rather than stalling. `perOp` gets a unique index
// so each op uses fresh ids.
async function measure(
  perOp: (k: number) => Promise<unknown>,
): Promise<number> {
  let bestPerOp = Infinity;
  for (let r = 0; r < REPS; r++) {
    const t0 = nowMs();
    let done = 0;
    for (let i = 0; i < OPS; i++) {
      await perOp(r * OPS + i);
      done = i + 1;
      if (nowMs() - t0 > BUDGET_MS) break;
    }
    bestPerOp = Math.min(bestPerOp, (nowMs() - t0) / done);
  }
  return 1000 / bestPerOp;
}

// Submits one sale. The whole `price` goes to one creator, minus the platform fee the pricing policy
// takes, so a few large funding sales build a payable `earned` balance quickly.
function sale(
  economy: Economy,
  o: { buyer: string; creator: string; label: string; price?: Amount },
): Promise<unknown> {
  return economy.submit(
    spend({
      buyerId: o.buyer,
      sku: `prod_${tag}`,
      price: o.price ?? credit('1.00'),
      orderId: `ord_${o.label}_${tag}`,
      recipients: [{ sellerId: o.creator, shareBps: 10_000 }],
    }),
  );
}

// Returns ops/sec for a top-up. Each op uses a fresh user, so nothing serializes on one account.
async function throughputTopUp(economy: Economy): Promise<number> {
  for (let i = 0; i < WARMUP; i++) {
    await economy.submit(
      topUp({ userId: `usr_tuw_${tag}_${i}`, amount: credit('10.00') }),
    );
  }
  return measure((k) =>
    economy.submit(
      topUp({ userId: `usr_tu_${tag}_${k}`, amount: credit('10.00') }),
    ),
  );
}

// Returns ops/sec for a marketplace sale. One funded buyer, one creator, a fresh order id each time.
async function throughputSpend(economy: Economy): Promise<number> {
  const buyer = `usr_spb_${tag}`;
  const creator = `usr_spc_${tag}`;
  await economy.submit(topUp({ userId: buyer, amount: credit('1000000.00') }));
  for (let i = 0; i < WARMUP; i++)
    await sale(economy, { buyer, creator, label: `spw_${i}` });
  return measure((k) => sale(economy, { buyer, creator, label: `sp_${k}` }));
}

// Returns ops/sec for a payout request, meaning the synchronous reserve step, not the worker
// settlement. It funds the creator's earned balance with a handful of large sales first. The funding
// is generous because the exact fee split belongs to the injected pricing policy and is not assumed
// here. Returns null if a payout will not commit.
async function throughputPayout(economy: Economy): Promise<number | null> {
  const buyer = `usr_pob_${tag}`;
  const creator = `usr_poc_${tag}`;
  await economy.submit(
    topUp({ userId: buyer, amount: credit('100000000.00') }),
  );
  const reserved = WARMUP + REPS * OPS; // total credits the runs will reserve, at 1.00 each
  const funding = Math.ceil((reserved * 1.5) / 300) + 5; // sales of 1000.00, assuming creator keeps >=30%
  for (let i = 0; i < funding; i++) {
    await sale(economy, {
      buyer,
      creator,
      label: `pof_${i}`,
      price: credit('1000.00'),
    });
  }
  const probe = await economy.submit(
    requestPayout({ userId: creator, amount: credit('1.00') }),
  );
  if (probe.status !== 'committed') return null;
  for (let i = 0; i < WARMUP; i++) {
    await economy.submit(
      requestPayout({ userId: creator, amount: credit('1.00') }),
    );
  }
  return measure(() =>
    economy.submit(requestPayout({ userId: creator, amount: credit('1.00') })),
  );
}

// Measures one op-type without letting a failure sink the whole backend. A missing schema or a
// payout gate can make one op throw. On any throw, this cell reads n/a and the rest still run.
async function tryRate(
  name: string,
  run: () => Promise<number | null>,
): Promise<number | null> {
  try {
    return await run();
  } catch (e) {
    console.warn(
      `      ${name} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// Returns the throughput row for one backend, or null when the backend is unreachable, for example
// on a refused connection or an unmigrated schema. A single probe op confirms the backend works
// before the timed runs begin.
async function throughputRow(
  label: string,
  url: string | undefined,
): Promise<string[] | null> {
  const env = { ...BASE_ENV, ...(url ? { DATABASE_URL: url } : {}) };
  if (url) console.warn(`    connecting to ${mask(url)}`);
  let caps;
  try {
    caps = await capabilitiesFromEnv(env, ports);
    const economy = createEconomy(caps);
    await economy.submit(
      topUp({ userId: `usr_probe_${tag}`, amount: credit('1.00') }),
    );
    console.warn(`    connected — timing ${REPS} runs of ${OPS} ops per kind`);
    const tu = await tryRate('topUp', () => throughputTopUp(economy));
    console.warn(`      topUp          ${rate(tu).padStart(10)} ops/sec`);
    const sp = await tryRate('spend', () => throughputSpend(economy));
    console.warn(`      spend          ${rate(sp).padStart(10)} ops/sec`);
    const po = await tryRate('requestPayout', () => throughputPayout(economy));
    console.warn(`      requestPayout  ${rate(po).padStart(10)} ops/sec`);
    await caps.store.close();
    return [label, rate(tu), rate(sp), rate(po)];
  } catch (e) {
    if (caps) await caps.store.close().catch(() => {});
    console.warn(
      `    SKIP ${label}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// Returns the integrity-cost-vs-ledger-size rows, in-memory. It seeds top-ups across a fixed user
// set, so the account count stays roughly flat while postings pile up. At each size it times
// prove(), a checkpoint seal, and a checkpoint verify.
async function curveRows(): Promise<string[][]> {
  const caps = await capabilitiesFromEnv(BASE_ENV, ports);
  const economy = createEconomy(caps);
  const { store } = caps;
  const ctx = workerCtxFrom(caps);
  const users = Array.from(
    { length: CURVE_USERS },
    (_, i) => `usr_cv_${tag}_${i}`,
  );
  const rows: string[][] = [];
  let done = 0;
  console.warn('\nintegrity curves (in-memory), one row per ledger size:');
  for (const size of CURVE_SIZES) {
    for (; done < size; done++) {
      await economy.submit(
        topUp({ userId: users[done % users.length], amount: credit('10.00') }),
      );
    }
    await economy.read.prove(); // warm the path before timing it
    const prove = await bestMs(CURVE_REPS, () => economy.read.prove());
    const seal = await bestMs(CURVE_REPS, () => sealCheckpoint(store, ctx));
    const verify = await bestMs(CURVE_REPS, () =>
      reverifyCheckpoint(store, ctx),
    );
    const accounts = await accountCount(economy);
    rows.push([num(done * 2), num(accounts), ms(prove), ms(seal), ms(verify)]);
    console.warn(
      `  ${String(done * 2).padStart(6)} postings · prove ${ms(prove)} · seal ${ms(seal)} · verify ${ms(verify)} (ms)`,
    );
  }
  await store.close();
  return rows;
}

async function accountCount(economy: Economy): Promise<number> {
  const seen: string[] = [];
  for await (const account of economy.read.accounts()) seen.push(account);
  return seen.length;
}

// --- formatting -------------------------------------------------------------------

// Hides a DSN password (`:secret@`) before logging the connection string.
const mask = (url: string): string => url.replace(/:[^:@/]*@/, ':***@');

const num = (n: number): string => Math.round(n).toLocaleString('en-US');
const rate = (n: number | null): string => (n === null ? 'n/a' : num(n));
const ms = (n: number): string => n.toFixed(n < 10 ? 2 : 1);

function printTable(title: string, headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.warn(`\n${title}`);
  console.warn(line(headers));
  console.warn(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.warn(line(r));
}

// --- run ---------------------------------------------------------------------------

console.warn('=== economy-lab benchmarks ===');
console.warn(
  `Lab numbers: single process, sequential submits, Node ${process.version}.`,
);
console.warn(
  'They show relative cost and scaling shape, not production capacity.',
);

// Prefer the connection the rest of the project already uses, that is DATABASE_URL or MYSQL_TEST_URL
// from .env as loaded by `make bench`. A machine's real role and password can differ from the
// compose template, for example when a volume was first initialized under a different POSTGRES_USER.
// The literals are only a last-resort default for a bare checkout with the compose stack freshly up.
const envDb = process.env.DATABASE_URL ?? '';
// Postgres is reached by either scheme, since the `pg` driver treats `postgres://` and
// `postgresql://` as the same alias, so accept both. MySQL is reached via `mysql://`. This matches
// selectStore in src/index.ts.
const envIsPostgres =
  envDb.startsWith('postgres://') || envDb.startsWith('postgresql://');
const pgUrl =
  process.env.BENCH_POSTGRES_URL ??
  (envIsPostgres ? envDb : undefined) ??
  'postgres://economy:economy@localhost:5432/economy_lab';
const mysqlUrl =
  process.env.BENCH_MYSQL_URL ??
  process.env.MYSQL_TEST_URL ??
  (envDb.startsWith('mysql://') ? envDb : undefined) ??
  'mysql://root:economy@localhost:3306/economy_lab';

console.warn(`\nsubmit throughput (best of ${REPS} × ${OPS} sequential ops):`);
const throughput: string[][] = [];
for (const [label, url] of [
  ['in-memory', undefined],
  ['postgres', pgUrl],
  ['mysql', mysqlUrl],
] as const) {
  console.warn(`  ${label}: measuring...`);
  const row = await throughputRow(label, url);
  if (row) throughput.push(row);
}
printTable(
  `Submit throughput — ops/sec, sequential, best of ${REPS} × ${OPS} (higher is better)`,
  ['backend', 'topUp', 'spend', 'requestPayout'],
  throughput,
);

const curve = await curveRows();
printTable(
  'Integrity cost vs ledger size — in-memory, ms (lower is better)',
  ['postings', 'accounts', 'prove()', 'seal', 'verify'],
  curve,
);
console.warn('');
console.warn(
  'prove() and seal re-walk every posting from genesis — O(postings) — so both climb',
);
console.warn(
  'with history. verify reads only account heads — O(accounts) — so it stays ~flat.',
);
console.warn(
  'A signed checkpoint verifies in O(accounts), so it anchors ongoing integrity where a',
);
console.warn('full re-prove — O(postings) — cannot keep up as history grows.');

// Open SQL pools keep the event loop alive. This is a run-once script, so exit explicitly.
// eslint-disable-next-line n/no-process-exit
process.exit(0);
