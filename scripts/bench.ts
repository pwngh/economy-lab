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

// Benchmarks over the shared harness (scripts/support/harness.ts): submit throughput per backend
// (sequential and concurrent), integrity cost vs ledger size, and the opt-in fast paths (instance
// netting, entitlement bitset). Knobs are the BENCH_* env vars — see BENCH_KEYS in harness.ts.
//
//   node scripts/bench.ts                       # in-memory + any reachable DB
//   BENCH_PROFILE=fast node scripts/bench.ts    # quick sample
//   BENCH_OUTPUT=json BENCH_JSON_PATH=bench.json node scripts/bench.ts
//   make bench-prod                             # Linux container vs the compose DBs

import { sealCheckpoint, reverifyCheckpoint } from '#src/worker/checkpoint.ts';
import {
  cachedEntitlements,
  createReservations,
  credit as creditLeg,
  debit as debitLeg,
  decodeAmount,
  earned,
  instanceSession,
  spendable,
} from '#src/index.ts';
import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import { I64Column, foldColumn } from '#src/fold-column.ts';
import { seededDeltas } from '#test/support/seeded-deltas.ts';
import {
  bestMs,
  determinismRoot,
  emitJson,
  measureConcurrent,
  measureSequential,
  ms,
  num,
  printTable,
  proveGate,
  rate,
  resolveConfig,
  tryProvision,
  urlFor,
} from '#scripts/support/harness.ts';

import type {
  BenchMode,
  ConcurrentResult,
  CounterProbe,
  GatesMode,
  Provisioned,
} from '#scripts/support/harness.ts';
import type { Amount, Economy, Operation } from '#src/index.ts';

// The one capture of process.env, and the one parse: everything below reads cfg, never env.
const cfg = resolveConfig(process.env);

// Per-process tag so ids are unique within a run; with the reseeded throwaway schema/database, that
// is all the uniqueness a run needs.
const tag = `b${process.pid.toString(36)}`;

// --- Workload kinds ----------------------------------------------------------------

// `poolSize` is how many distinct subjects this kind spreads its ops across (0 for topUp, a fresh user
// per op). measureKind warms every one before timing so no concurrent op pays a cold-start chain-genesis
// (which could fork-race a sibling and pollute the throughput number).
type Kind = {
  name: string;
  poolSize: number;
  setup: (economy: Economy) => Promise<void>;
  perOp: (economy: Economy, k: number) => Promise<unknown>;
};

function sale(
  economy: Economy,
  o: { buyer: string; seller: string; label: string; price?: Amount },
): Promise<unknown> {
  return economy.submit(
    spend({
      buyerId: o.buyer,
      sku: `prod_${tag}`,
      price: o.price ?? credit('1.00'),
      orderId: `ord_${o.label}_${tag}`,
      recipients: [{ sellerId: o.seller, shareBps: 10_000 }],
    }),
  );
}

const timedOps = cfg.reps * cfg.ops * 2;

// Warmup runs cfg.warmup ops, or once per pooled subject, whichever is larger (so every subject's
// account exists before timing). Funding must cover these too, else a buyer runs dry mid-warmup and the
// timed sample sees INSUFFICIENT_FUNDS the throughput-mode assertion would flag as a bug.
const warmupOpsFor = (poolSize: number): number =>
  Math.max(cfg.warmup, poolSize);

const poolIdx = (k: number, size: number): number => ((k % size) + size) % size;

// Why pools: hammering one buyer/seller measures single-row lock contention, not throughput. A pool
// of subjects >= the concurrency leaves concurrent ops touching disjoint user rows, contending only
// on the genuinely-shared platform account every posting touches.

function topUpKind(): Kind {
  return {
    name: 'topUp',
    poolSize: 0, // a fresh user per op; the only shared rows are the seeded platform accounts
    setup: async () => {},
    perOp: (economy, k) =>
      economy.submit(
        topUp({ userId: `usr_tu_${tag}_${k}`, amount: credit('10.00') }),
      ),
  };
}

function spendKind(poolSize: number): Kind {
  const buyers = Array.from(
    { length: poolSize },
    (_, i) => `usr_spb_${tag}_${i}`,
  );
  const sellers = Array.from(
    { length: poolSize },
    (_, i) => `usr_spc_${tag}_${i}`,
  );
  // Fully funded even in contention mode, so the signal is contention (retries/throws), not fund rejections.
  const perBuyer =
    Math.ceil((timedOps + warmupOpsFor(poolSize)) / poolSize) + 50;
  return {
    name: 'spend',
    poolSize,
    setup: async (economy) => {
      for (const buyer of buyers) {
        await economy.submit(
          topUp({ userId: buyer, amount: credit(`${perBuyer}.00`) }),
        );
      }
    },
    perOp: (economy, k) => {
      const i = poolIdx(k, poolSize);
      return sale(economy, {
        buyer: buyers[i]!,
        seller: sellers[i]!,
        label: `sp_${k}`,
      });
    },
  };
}

// The synchronous reserve step, not the worker settlement. Funding is generous because the exact
// fee split belongs to the injected pricing policy and is not assumed here.
function payoutKind(poolSize: number): Kind {
  const bank = `usr_pob_${tag}`;
  const sellers = Array.from(
    { length: poolSize },
    (_, i) => `usr_poc_${tag}_${i}`,
  );

  const perSeller =
    Math.ceil((timedOps + warmupOpsFor(poolSize)) / poolSize) + 50; // reserves of 1.00 each
  const salesPerSeller = Math.ceil(perSeller / 300) + 1; // sales of 1000.00, seller keeps >=30%
  return {
    name: 'requestPayout',
    poolSize,
    setup: async (economy) => {
      await economy.submit(
        topUp({ userId: bank, amount: credit('1000000000.00') }),
      );
      for (let c = 0; c < poolSize; c++) {
        for (let s = 0; s < salesPerSeller; s++) {
          await sale(economy, {
            buyer: bank,
            seller: sellers[c]!,
            label: `pof_${c}_${s}`,
            price: credit('1000.00'),
          });
        }
      }
    },
    perOp: (economy, k) =>
      economy.submit(
        requestPayout({
          userId: sellers[poolIdx(k, poolSize)]!,
          amount: credit('1.00'),
        }),
      ),
  };
}

const hist = (h: Record<string, number>): string =>
  Object.entries(h)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

// Contention mode shrinks the pool so many ops dogpile a few subjects' chains; throughput mode
// spreads them >= the concurrency (see the pool note above).
function poolSizeForMode(concurrency: number, mode: BenchMode): number {
  if (mode === 'contention') return Math.max(2, Math.floor(concurrency / 4));
  return Math.max(concurrency, 8);
}

// A fixed op sequence to fingerprint the engine for the cross-engine determinism check; every op
// commits under both gate modes. Idempotency keys are pinned because at shards > 1 the platform
// legs route by hashing the key — different keys would land on different shard rows and diverge
// the roots. Pinned keys are safe only because each backend runs in a throwaway schema/database.
const withKey = (op: Operation, idempotencyKey: string): Operation => ({
  ...op,
  idempotencyKey,
});

async function runDeterminismSequence(economy: Economy): Promise<void> {
  await economy.submit(
    withKey(
      topUp({ userId: 'det_buyer_a', amount: credit('1000.00') }),
      'det_topup_a',
    ),
  );
  await economy.submit(
    withKey(
      topUp({ userId: 'det_buyer_b', amount: credit('1000.00') }),
      'det_topup_b',
    ),
  );
  for (let i = 0; i < 2; i++) {
    await economy.submit(
      withKey(
        spend({
          buyerId: i === 0 ? 'det_buyer_a' : 'det_buyer_b',
          sku: 'det_sku',
          price: credit('100.00'),
          orderId: `det_ord_${i}`,
          recipients: [{ sellerId: 'det_seller', shareBps: 10_000 }],
        }),
        `det_spend_${i}`,
      ),
    );
  }
  await economy.submit(
    withKey(
      requestPayout({ userId: 'det_seller', amount: credit('1.00') }),
      'det_payout',
    ),
  );
}

type KindRates = {
  name: string;
  seq: number;
  con: ConcurrentResult;
};

async function measureKind(
  economy: Economy,
  concurrency: number,
  kind: Kind,
  counters: CounterProbe,
): Promise<KindRates> {
  await kind.setup(economy);
  const warm = warmupOpsFor(kind.poolSize);
  for (let i = 0; i < warm; i++) {
    // Negative-offset indices so warmup ids never collide with the timed ones.
    await kind.perOp(economy, -1 - i);
  }
  const seq = await measureSequential(cfg, (k) => kind.perOp(economy, k));
  const con = await measureConcurrent(
    cfg,
    concurrency,
    (k) => kind.perOp(economy, cfg.reps * cfg.ops + k),
    counters,
  );
  return { name: kind.name, seq, con };
}

function reportKind(p: Provisioned, r: KindRates): void {
  const c = r.con;
  const lat = c.latency;
  console.warn(
    `      ${r.name.padEnd(14)} seq ${rate(r.seq).padStart(9)}  con ${rate(c.rate).padStart(9)} ops/sec` +
      `  · lat p50 ${ms(lat.p50)} p95 ${ms(lat.p95)} p99 ${ms(lat.p99)} max ${ms(lat.max)} ms`,
  );
  const bits: string[] = [`committed ${num(c.committed)}`];
  bits.push(
    c.rejected > 0
      ? `rejected ${c.rejected} [${hist(c.rejectReasons)}]`
      : 'rejected 0',
  );
  bits.push(
    c.threw > 0 ? `threw ${c.threw} [${hist(c.throwClasses)}]` : 'threw 0',
  );
  if (c.duplicate > 0) bits.push(`duplicate ${c.duplicate}`);
  const retry =
    c.retries.retries > 0
      ? `retries ${num(c.retries.retries)} (recovered ${num(c.retries.recovered)}, exhausted ${num(c.retries.exhausted)})`
      : 'retries 0';
  const dl = c.dbCounters
    ? `db-deadlocks ${c.dbCounters.deadlocks}` +
      (c.dbCounters.lockWaits > 0
        ? `, lock-waits ${c.dbCounters.lockWaits}`
        : '')
    : 'db-deadlocks n/a';
  console.warn(`                     ${bits.join('  ')}  · ${retry}  · ${dl}`);
  if (p.mode === 'throughput' && (c.rejected > 0 || c.duplicate > 0)) {
    console.warn(
      `      ⚠ ${r.name}: ${c.rejected} rejected / ${c.duplicate} duplicate under throughput mode — a funding/gate/id BUG, not contention; investigate`,
    );
  }
}

type NettingResult = {
  movements: number;
  accepted: number;
  acceptMs: number;
  settleMs: number;
  settleMode: string;
  settlePostings: number;
};

// Instance netting (src/netting.ts): N movements into the hash-chained journal, then one settle
// through clearing. Accepted/sec vs the spend seq rate is the gap the session buys.
async function measureNetting(p: Provisioned): Promise<NettingResult> {
  const n = cfg.reps * cfg.ops;
  const width = 4;
  const viewers = Array.from({ length: width }, (_, i) => `usr_nv_${tag}_${i}`);
  const creators = Array.from(
    { length: width },
    (_, i) => `usr_nc_${tag}_${i}`,
  );
  const perViewer = Math.ceil(n / width) + 50; // movements are 0.50 each; funded with margin
  for (const viewer of viewers) {
    await p.economy.submit(
      topUp({ userId: viewer, amount: credit(`${perViewer}.00`) }),
    );
  }
  const session = instanceSession(
    { store: p.store, digest: p.workerCtx.digest, clock: p.workerCtx.clock },
    `sess_${tag}`,
    { reservations: createReservations() },
  );
  const amount = decodeAmount('0.50', 'CREDIT');
  let accepted = 0;
  const t0 = performance.now();
  for (let k = 0; k < n; k++) {
    const outcome = await session.record({
      idempotencyKey: `bmv_${tag}_${k}`,
      legs: [
        debitLeg(spendable(viewers[k % width]!), amount),
        creditLeg(earned(creators[k % width]!), amount),
      ],
    });
    if (outcome.status === 'accepted') accepted += 1;
  }
  await session.flush(); // acceptance includes the final journal batch commit
  const acceptMs = performance.now() - t0;
  const t1 = performance.now();
  const report = await session.settle();
  return {
    movements: n,
    accepted,
    acceptMs,
    settleMs: performance.now() - t1,
    settleMode: report.mode,
    settlePostings: report.postings,
  };
}

function reportNetting(
  p: Provisioned,
  r: NettingResult,
  spendSeq: number | null,
): void {
  const perMv = r.acceptMs / Math.max(1, r.accepted);
  const perSec = 1000 / perMv;
  console.warn(
    `      netting        ${num(r.accepted)} movements accepted in ${ms(r.acceptMs)} ms (${rate(perSec)} /sec, ${ms(perMv)} ms/movement)`,
  );
  console.warn(
    `                     settle → ${r.settlePostings} posting(s) [${r.settleMode}] in ${ms(r.settleMs)} ms` +
      (spendSeq
        ? `  · ${(perSec / spendSeq).toFixed(1)}× the spend seq rate`
        : ''),
  );
  if (
    p.mode === 'throughput' &&
    (r.accepted !== r.movements || r.settleMode !== 'netted')
  ) {
    console.warn(
      `      ⚠ netting: ${r.movements - r.accepted} rejected / settle mode "${r.settleMode}" under throughput mode — a funding BUG, not contention; investigate`,
    );
  }
}

type BitsetResult = {
  storeChecks: number;
  storeMs: number;
  cachedChecks: number;
  cachedMs: number;
};

// Entitlement bitset (src/adapters/entitlement-bitset.ts): the same owns() answered by the raw
// store vs the warm bitmap through the identical async Store surface, so the warm figure includes
// the promise machinery a caller pays; the sync core underneath is faster still.
async function measureBitset(p: Provisioned): Promise<BitsetResult> {
  const user = `usr_bs_${tag}`;
  const sku = `sku_bs_${tag}`;
  await p.store.transaction((unit) => unit.entitlements.grant(user, sku, {}));
  const storeChecks = 200;
  const t0 = performance.now();
  for (let i = 0; i < storeChecks; i++) {
    await p.store.entitlements.owns(user, sku);
  }
  const storeMs = performance.now() - t0;
  const cached = cachedEntitlements(p.store, { clock: p.workerCtx.clock });
  await cached.entitlements.owns(user, sku); // the cold read fills the bitmap
  const cachedChecks = 200_000;
  const t1 = performance.now();
  for (let i = 0; i < cachedChecks; i++) {
    await cached.entitlements.owns(user, sku);
  }
  return {
    storeChecks,
    storeMs,
    cachedChecks,
    cachedMs: performance.now() - t1,
  };
}

const bitsetStoreUs = (r: BitsetResult): number =>
  (r.storeMs * 1000) / r.storeChecks;
const bitsetCachedNs = (r: BitsetResult): number =>
  (r.cachedMs * 1e6) / r.cachedChecks;

function reportBitset(r: BitsetResult): void {
  const storeUs = bitsetStoreUs(r);
  const cachedNs = bitsetCachedNs(r);
  console.warn(
    `      bitset         store owns ${storeUs.toFixed(1)} µs/check · warm bitmap ${cachedNs.toFixed(0)} ns/check (${num(Math.round((storeUs * 1000) / cachedNs))}×)`,
  );
}

type BackendResult = {
  backend: string;
  durability: string;
  provable: boolean;
  mode: BenchMode;
  gates: GatesMode;
  concurrency: number;
  poolMax: number;
  connsPerOp: number;
  determinismRoot: string;
  kinds: KindRates[];
  netting: NettingResult;
  bitset: BitsetResult;
};

// Exit non-zero when any prove gate fails, a backend throws mid-run, or the roots disagree.
// `determinismOk` and `determinismChecked` are separate so the JSON can report agreement honestly:
// agreed, disagreed, or never checked.
let anyProveFailed = false;
let determinismOk = true;
let determinismChecked = false;

async function throughputFor(p: Provisioned): Promise<BackendResult> {
  console.warn(`    ${p.durability}`);
  console.warn(
    `    pool ${p.poolMax} conns (${p.connsPerOp}*${p.concurrency} concurrency + headroom) · mode ${p.mode} · gates ${p.gates}`,
  );
  // Snapshot the root before the workload perturbs it, so every backend's root covers identical postings.
  await runDeterminismSequence(p.economy);
  const root = await determinismRoot(p);

  const poolSize = poolSizeForMode(p.concurrency, p.mode);
  const kinds: KindRates[] = [];
  for (const kind of [topUpKind(), spendKind(poolSize), payoutKind(poolSize)]) {
    const r = await measureKind(p.economy, p.concurrency, kind, p.counters);
    reportKind(p, r);
    kinds.push(r);
  }
  const netting = await measureNetting(p);
  reportNetting(p, netting, kinds.find((k) => k.name === 'spend')?.seq ?? null);
  const bitset = await measureBitset(p);
  reportBitset(bitset);
  // The prove gate also covers the netting settlement just posted; a failure flips the exit code.
  const ok = await proveGate(p, '      prove          ');
  if (!ok) {
    anyProveFailed = true;
  }
  return {
    backend: p.label,
    durability: p.durability,
    provable: ok,
    mode: p.mode,
    gates: p.gates,
    concurrency: p.concurrency,
    poolMax: p.poolMax,
    connsPerOp: p.connsPerOp,
    determinismRoot: root,
    kinds,
    netting,
    bitset,
  };
}

type CurveRow = {
  postings: number;
  accounts: number;
  prove: number;
  seal: number;
  verify: number;
};

type FoldRow = { legs: number; scalarUs: number; foldUs: number };

// One account's signed-delta column, seeded with i64-safe values, so a re-derivation folds a
// resident column exactly as the in-memory store does.
function seedColumn(legs: number): I64Column {
  const column = new I64Column();
  for (const delta of seededDeltas(legs)) {
    column.push(delta);
  }
  return column;
}

// Times one summation kernel over many repetitions; the accumulator stays live so the call is not
// optimized away. Returns microseconds per fold.
function foldUs(iterations: number, fn: () => bigint): number {
  for (let i = 0; i < 50; i += 1) fn();
  const t0 = performance.now();
  let live = 0n;
  for (let i = 0; i < iterations; i += 1) live += fn();
  const us = ((performance.now() - t0) * 1000) / iterations;
  if (live === 7n) console.warn('');
  return us;
}

// The in-memory balance re-derivation kernel: summing one account's leg column, WASM fold vs the
// scalar loop, at a few account leg counts. The fold is the win on the hot platform accounts, which
// accumulate a leg per operation; an ordinary wallet holds too few legs to reach the fold path.
function foldCurve(): FoldRow[] {
  const rows: FoldRow[] = [];
  console.warn(
    '\nbalance re-derivation kernel (in-memory), one row per account leg count:',
  );
  for (const legs of [1_000, 10_000, 100_000, 1_000_000]) {
    const column = seedColumn(legs);
    const view = column.view();
    const iterations = legs >= 1_000_000 ? 20 : legs >= 100_000 ? 200 : 5_000;
    const scalarUs = foldUs(iterations, () => {
      let sum = 0n;
      for (let i = 0; i < view.length; i += 1) sum += view[i]!;
      return sum;
    });
    const fold = foldUs(iterations, () => foldColumn(column));
    rows.push({ legs, scalarUs, foldUs: fold });
    console.warn(
      `  ${String(legs).padStart(9)} legs · scalar ${scalarUs.toFixed(2)} µs · fold ${fold.toFixed(2)} µs (${(scalarUs / fold).toFixed(1)}×)`,
    );
  }
  return rows;
}

async function integrityCurve(): Promise<CurveRow[]> {
  const p = await tryProvision('in-memory', cfg);
  if (!p) return [];
  const { economy, store, workerCtx } = p;
  const users = Array.from(
    { length: cfg.curveUsers },
    (_, i) => `usr_cv_${tag}_${i}`,
  );
  const rows: CurveRow[] = [];
  let done = 0;
  console.warn('\nintegrity curves (in-memory), one row per ledger size:');
  for (const size of cfg.curveSizes) {
    for (; done < size; done++) {
      await economy.submit(
        topUp({ userId: users[done % users.length]!, amount: credit('10.00') }),
      );
    }

    const prove = await bestMs(cfg.curveReps, () => economy.read.prove());
    const seal = await bestMs(cfg.curveReps, () =>
      sealCheckpoint(store, workerCtx),
    );
    const verify = await bestMs(cfg.curveReps, () =>
      reverifyCheckpoint(store, workerCtx),
    );
    const accountIds: string[] = [];
    for await (const account of economy.read.accounts())
      accountIds.push(account);
    rows.push({
      postings: done * 2,
      accounts: accountIds.length,
      prove,
      seal,
      verify,
    });
    console.warn(
      `  ${String(done * 2).padStart(6)} postings · prove ${ms(prove)} · seal ${ms(seal)} · verify ${ms(verify)} (ms)`,
    );
  }
  await p.teardown();
  return rows;
}

console.warn('=== economy-lab benchmarks ===');
console.warn(
  `Lab numbers: single process, Node ${process.version}, profile "${cfg.profile}" (ops=${cfg.ops}, reps=${cfg.reps}, concurrency=${cfg.concurrency}).`,
);
console.warn(
  `Mode "${cfg.mode}" (${cfg.mode === 'throughput' ? 'fully funded — any rejection is a bug' : 'oversubscribed on purpose — rejections/retries are the measured signal'}), ` +
    `gates ${cfg.gates}, pools sized ${cfg.connsPerOp}*concurrency + ${cfg.poolHeadroom} for the money-transaction write path (velocity rides the same transaction).`,
);
console.warn(
  'They show relative cost and scaling shape, not production capacity.',
);
console.warn(
  `\nsubmit throughput (best of ${cfg.reps} * ${cfg.ops}; seq = one at a time, con = ${cfg.concurrency} in flight; rate over committed ops only):`,
);

const results: BackendResult[] = [];
for (const backend of cfg.backends) {
  console.warn(`  ${backend}: measuring...`);
  if (backend !== 'in-memory') {
    console.warn(`    connecting to ${urlFor(cfg, backend)}`);
  }
  const p = await tryProvision(backend, cfg);
  if (!p) continue;
  try {
    results.push(await throughputFor(p));
  } catch (e) {
    // Contain the failure so the other backends still run, but a backend that provisioned and then
    // threw fails the run — distinct from tryProvision's null for an unreachable backend, the intended skip.
    anyProveFailed = true;
    console.warn(
      `    FAILED ${backend}: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await p.teardown();
  }
}

const kindNames = ['topUp', 'spend', 'requestPayout'];
const kindOf = (r: BackendResult, name: string): KindRates | undefined =>
  r.kinds.find((k) => k.name === name);
const seqRate = (r: BackendResult, name: string): string =>
  rate(kindOf(r, name)?.seq ?? null);
const conRate = (r: BackendResult, name: string): string =>
  rate(kindOf(r, name)?.con.rate ?? null);

printTable(
  `Sequential throughput — ops/sec, one at a time (latency-bound; higher is better)`,
  ['backend', ...kindNames, 'provable'],
  results.map((r) => [
    r.backend,
    ...kindNames.map((n) => seqRate(r, n)),
    r.provable ? 'yes' : 'NO',
  ]),
);
printTable(
  `Concurrent throughput — ops/sec, up to ${cfg.concurrency} in flight (pipelined; in-memory is serial so con~seq)`,
  ['backend', ...kindNames, 'provable'],
  results.map((r) => [
    r.backend,
    ...kindNames.map((n) => conRate(r, n)),
    r.provable ? 'yes' : 'NO',
  ]),
);

printTable(
  `Concurrent latency over committed ops — ms (p50 / p99 / max per kind; lower is better)`,
  ['backend', ...kindNames.map((n) => `${n} p50·p99·max`)],
  results.map((r) => [
    r.backend,
    ...kindNames.map((n) => {
      const l = kindOf(r, n)?.con.latency;
      return l ? `${ms(l.p50)} · ${ms(l.p99)} · ${ms(l.max)}` : 'n/a';
    }),
  ]),
);

printTable(
  'Opt-in fast paths — instance netting and entitlement bitset (lower is better)',
  [
    'backend',
    'accept ms/mv',
    'accepted/sec',
    'settle ms · postings',
    'store owns µs',
    'bitmap ns',
    'speedup',
  ],
  results.map((r) => {
    const perMv = r.netting.acceptMs / Math.max(1, r.netting.accepted);
    const storeUs = bitsetStoreUs(r.bitset);
    const cachedNs = bitsetCachedNs(r.bitset);
    return [
      r.backend,
      ms(perMv),
      rate(1000 / perMv),
      `${ms(r.netting.settleMs)} · ${r.netting.settlePostings}`,
      storeUs.toFixed(1),
      cachedNs.toFixed(0),
      `${num(Math.round((storeUs * 1000) / cachedNs))}×`,
    ];
  }),
);

// Surface what did not commit under concurrency, split by real cause; the engine's own counter
// delta is ground truth.
for (const r of results) {
  for (const k of r.kinds) {
    const c = k.con;
    const surfaced = c.rejected > 0 || c.threw > 0 || c.duplicate > 0;
    const contended =
      c.retries.retries > 0 || (c.dbCounters?.deadlocks ?? 0) > 0;
    if (!surfaced && !contended) continue;
    const bits: string[] = [];
    if (c.rejected > 0)
      bits.push(`rejected ${c.rejected} (${hist(c.rejectReasons)})`);
    if (c.threw > 0) bits.push(`threw ${c.threw} (${hist(c.throwClasses)})`);
    if (c.duplicate > 0) bits.push(`duplicate ${c.duplicate}`);
    if (c.retries.retries > 0)
      bits.push(
        `retries ${num(c.retries.retries)} (recovered ${num(c.retries.recovered)}, exhausted ${num(c.retries.exhausted)})`,
      );
    bits.push(
      c.dbCounters
        ? `engine-detected deadlocks ${c.dbCounters.deadlocks}` +
            (c.dbCounters.lockWaits > 0
              ? ` + lock-waits ${c.dbCounters.lockWaits}`
              : '')
        : 'engine-detected deadlocks n/a',
    );
    console.warn(`  ${r.backend} ${k.name}: ${bits.join('  ·  ')}`);
  }
}

// A root mismatch is a real correctness bug: loud, and it flips the exit code. The reference is
// in-memory when present, else any backend that ran, so two SQL engines still compare.
if (results.length >= 2) {
  determinismChecked = true;
  const reference =
    results.find((r) => r.backend === 'in-memory') ?? results[0]!;
  const disagree = results.filter(
    (r) => r.determinismRoot !== reference.determinismRoot,
  );
  if (disagree.length === 0) {
    console.warn(
      `\ncross-engine determinism: PASS — ${results.length} backends reached identical chain root ${reference.determinismRoot.slice(0, 16)}...`,
    );
  } else {
    anyProveFailed = true;
    determinismOk = false;
    console.warn(
      `\ncross-engine determinism: FAIL — ${reference.backend} root ${reference.determinismRoot.slice(0, 16)}... but ` +
        disagree
          .map((r) => `${r.backend}=${r.determinismRoot.slice(0, 16)}...`)
          .join(', '),
    );
  }
} else {
  console.warn(
    `\ncross-engine determinism: not run — fewer than two backends produced a root to compare.`,
  );
}

// A backend named in BENCH_REQUIRE that skipped or failed flips the exit code, so partial coverage
// never reads as a clean pass.
const missingRequired = cfg.required.filter(
  (b) => !results.some((r) => r.backend === b),
);
if (missingRequired.length > 0) {
  anyProveFailed = true;
  console.warn(
    `\nFAIL: required backend(s) did not complete: ${missingRequired.join(', ')} (BENCH_REQUIRE=${cfg.required.join(',')})`,
  );
}

const curve = await integrityCurve();
console.warn('');
console.warn(
  'prove() and seal re-walk every posting from genesis — O(postings) — so both climb',
);
console.warn(
  'with history. verify recomputes the v2 sum root from the legs — O(legs), one index-only',
);
console.warn(
  'aggregate — so it grows linearly too, by design: the sum check attests the legs, not the',
);
console.warn(
  'balance cache. It still beats a full re-prove (no re-hashing of every link), which is what',
);
console.warn('cannot keep up as history grows.');

const fold = foldCurve();
console.warn('');
console.warn(
  "Re-deriving a balance folds the account's resident i64 leg column. Above a few hundred legs",
);
console.warn(
  'the WASM fold beats the scalar loop; a wallet holds too few legs to reach it, so the win lands',
);
console.warn('on the hot platform accounts that take a leg per operation.');

await emitJson(cfg, {
  config: {
    ops: cfg.ops,
    reps: cfg.reps,
    warmup: cfg.warmup,
    concurrency: cfg.concurrency,
    mode: cfg.mode,
    gates: cfg.gates,
    connsPerOp: cfg.connsPerOp,
    poolHeadroom: cfg.poolHeadroom,
    backends: cfg.backends,
  },
  throughput: results,
  // Run-level verdicts a CI job can assert on. `provable` requires at least one backend to have completed;
  // `crossEngineDeterministic` is agreed/disagreed, or null when fewer than two backends were compared.
  provable: results.length > 0 && results.every((r) => r.provable),
  crossEngineDeterministic: determinismChecked ? determinismOk : null,
  integrityCurve: curve,
  foldCurve: fold,
});

// Exit explicitly: open SQL pools would otherwise keep the event loop alive.
if (anyProveFailed) {
  console.warn(
    '\nFAIL: a prove gate, a mid-run backend error, or the cross-engine determinism check did not pass — see above. Exiting non-zero.',
  );
}
// eslint-disable-next-line n/no-process-exit
process.exit(anyProveFailed ? 1 : 0);
