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

// Benchmarks for the economy, built on the shared harness (scripts/support/harness.ts), so a run is
// standardized, reseeded, provable, portable, and tunable:
//
//   1. Submit throughput per backend, both ways: sequential (one op at a time — latency-bound, each
//      op pays a full round trip + commit) and concurrent (up to BENCH_CONCURRENCY in flight — on a
//      durable SQL backend this lets the engine overlap round trips and group-commit many fsyncs into
//      one, so it is the throughput the engine sustains). The sequential number is not the engine's ceiling.
//   2. Integrity cost vs ledger size (in-memory). prove() and a checkpoint seal re-walk every posting
//      from genesis — O(postings) — so both climb with history; checkpoint verify reads only account
//      heads — O(accounts) — so it stays ~flat. That contrast is why a signed checkpoint, not a full
//      re-prove, anchors ongoing integrity as history grows.
//
// Each SQL backend runs in its own throwaway schema/database, created fresh and
// dropped on teardown, so a run never inherits another run's rows (a bloated database is measurably slower). Each backend is also proven after its workload — a reported number always comes from a
// ledger that just passed every invariant — and annotated with its live durability settings, so the
// reader can see whether the measured commit is as durable as production.
//
//   node scripts/bench.ts                          # in-memory + any reachable DB
//   BENCH_PROFILE=fast node scripts/bench.ts        # quick sample
//   BENCH_PROFILE=thorough node scripts/bench.ts    # heavy sample
//   BENCH_BACKENDS=postgres BENCH_OPS=1000 node scripts/bench.ts
//   BENCH_OUTPUT=json BENCH_JSON_PATH=bench.json node scripts/bench.ts
//   make bench-prod                                 # run inside a Linux container vs the compose DBs
//
// Knobs (all optional): BENCH_PROFILE, BENCH_OPS, BENCH_REPS, BENCH_WARMUP, BENCH_CONCURRENCY,
// BENCH_BUDGET_MS, BENCH_BACKENDS, BENCH_OUTPUT, BENCH_JSON_PATH, BENCH_SEED, BENCH_SHARDS, and the connection URLs
// BENCH_POSTGRES_URL / BENCH_MYSQL_URL (else DATABASE_URL / MYSQL_TEST_URL). See harness.ts.

import { sealCheckpoint, reverifyCheckpoint } from '#src/worker/checkpoint.ts';
import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import {
  bestMs,
  determinismRoot,
  emitJson,
  maskUrl,
  measureConcurrent,
  measureSequential,
  ms,
  num,
  printTable,
  proveEconomyOrReport,
  rate,
  resolveConfig,
  tryProvision,
} from '#scripts/support/harness.ts';

import type {
  BenchMode,
  ConcurrentResult,
  CounterProbe,
  GatesMode,
  Provisioned,
} from '#scripts/support/harness.ts';
import type { Amount, Economy, Operation } from '#src/index.ts';

const cfg = resolveConfig();

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

const timedOps = cfg.reps * cfg.ops * 2;

// Warmup runs cfg.warmup ops, or once per pooled subject, whichever is larger (so every subject's
// account exists before timing). Funding must cover these too, else a buyer runs dry mid-warmup and the
// timed sample sees INSUFFICIENT_FUNDS the throughput-mode assertion would flag as a bug.
const warmupOpsFor = (poolSize: number): number =>
  Math.max(cfg.warmup, poolSize);

const poolIdx = (k: number, size: number): number => ((k % size) + size) % size;

// Why pools: real traffic is many independent users transacting at once. Hammering one buyer/one
// creator measures single-row lock contention, not throughput — at depth every op fights over the
// same rows, so the rate collapses and MySQL deadlocks. Spreading each kind across a pool of subjects
// (>= the concurrency) leaves concurrent ops touching disjoint user rows, contending only on the
// genuinely-shared platform account every posting touches (the funding float for topUp, REVENUE for a
// sale, the payout reserve for a payout) — the honest concurrency ceiling for this ledger's
// lock-the-whole-set discipline.

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

// spend: a pool of buyers and creators, round-robin per op. With the pool, concurrent sales contend
// only on REVENUE (every sale credits the platform fee there), not on one buyer's spendable and one
// creator's earned.
function spendKind(poolSize: number): Kind {
  const buyers = Array.from(
    { length: poolSize },
    (_, i) => `usr_spb_${tag}_${i}`,
  );
  const creators = Array.from(
    { length: poolSize },
    (_, i) => `usr_spc_${tag}_${i}`,
  );
  // Each buyer covers its share of every timed sale plus the warmup (round-robin), with margin. In
  // contention mode poolSize is small, so this figure is large and every buyer is hammered — fully
  // funded on purpose, so the signal is contention (retries/throws), not fund rejections.
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
        creator: creators[i]!,
        label: `sp_${k}`,
      });
    },
  };
}

// requestPayout: the synchronous reserve step (not the worker settlement) against a pool of creators'
// earned balances. Each creator is pre-funded with large sales from one bank buyer; the funding is
// generous because the exact fee split belongs to the injected pricing policy and is not assumed here.
function payoutKind(poolSize: number): Kind {
  const bank = `usr_pob_${tag}`;
  const creators = Array.from(
    { length: poolSize },
    (_, i) => `usr_poc_${tag}_${i}`,
  );

  const perCreator =
    Math.ceil((timedOps + warmupOpsFor(poolSize)) / poolSize) + 50; // reserves of 1.00 each
  const salesPerCreator = Math.ceil(perCreator / 300) + 1; // sales of 1000.00, creator keeps >=30%
  return {
    name: 'requestPayout',
    poolSize,
    setup: async (economy) => {
      await economy.submit(
        topUp({ userId: bank, amount: credit('1000000000.00') }),
      );
      for (let c = 0; c < poolSize; c++) {
        for (let s = 0; s < salesPerCreator; s++) {
          await sale(economy, {
            buyer: bank,
            creator: creators[c]!,
            label: `pof_${c}_${s}`,
            price: credit('1000.00'),
          });
        }
      }
    },
    perOp: (economy, k) =>
      economy.submit(
        requestPayout({
          userId: creators[poolIdx(k, poolSize)]!,
          amount: credit('1.00'),
        }),
      ),
  };
}

// A `key=count` rendering of a histogram, used for the rejection-reason and throw-class breakdowns.
const hist = (h: Record<string, number>): string =>
  Object.entries(h)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

// Throughput mode spreads ops across >= concurrency subjects so concurrent ops touch disjoint rows
// (the ledger's ceiling, not single-row contention). Contention mode shrinks the pool so many ops
// dogpile a few subjects' chains, surfacing the retry/deadlock pressure throughput mode avoids.
function poolSizeForMode(concurrency: number, mode: BenchMode): number {
  if (mode === 'contention') return Math.max(2, Math.floor(concurrency / 4));
  return Math.max(concurrency, 8);
}

// A small fixed op sequence run on a fresh ledger to fingerprint the engine for the cross-engine
// determinism check (see determinismRoot). Fixed ids/amounts/keys (no pid tag, no clock dependence) so
// every engine posts byte-identical entries; a representative cross-section (top-ups, fee-splitting
// sales, a payout reserve) so a divergence in any path changes the root. Every op commits under both
// gate modes.
//
// The idempotency keys are pinned, overriding the builders' run-random, process-counted ones: at
// shards > 1 the platform legs route by hashing this key, so every backend must submit identical keys
// or the same sequence lands on different shard rows and the roots diverge. Constants are safe here
// where the builders' comment warns they are not — each backend runs in a throwaway schema/database,
// so a pinned key can never replay a previous run's row as a duplicate.
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
          recipients: [{ sellerId: 'det_creator', shareBps: 10_000 }],
        }),
        `det_spend_${i}`,
      ),
    );
  }
  await economy.submit(
    withKey(
      requestPayout({ userId: 'det_creator', amount: credit('1.00') }),
      'det_payout',
    ),
  );
}

// One kind's measurement: `seq` is the latency-bound rate (one op at a time); `con` is the full
// concurrent ConcurrentResult (rate plus the breakdown needed to trust it). measureKind runs setup,
// warmup, then the two samples.
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
    // Negative-offset indices so warmup ids never collide with the timed ones. (A cold-start stress
    // mode would skip this on purpose.)
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

// Print one kind's result as a self-contained block: throughput (seq + con), latency distribution, the
// committed/rejected/threw taxonomy, retry pressure, and the engine's own deadlock count. In throughput
// mode a rejection or duplicate is a bug (the workload is fully funded), so it is called out loudly.
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
};

// Exit non-zero when any backend's prove gate fails, a backend throws mid-run, or the roots disagree — a
// number over a broken ledger (or a run that completed no backend) must never exit 0. `determinismOk`
// (did the compared roots agree) and `determinismChecked` (were at least two compared) are separate so
// the JSON can report agreement honestly: agreed, disagreed, or never checked.
let anyProveFailed = false;
let determinismOk = true;
let determinismChecked = false;

async function throughputFor(p: Provisioned): Promise<BackendResult> {
  console.warn(`    ${p.durability}`);
  console.warn(
    `    pool ${p.poolMax} conns (${p.connsPerOp}×${p.concurrency} concurrency + headroom) · mode ${p.mode} · gates ${p.gates}`,
  );
  // Cross-engine determinism fingerprint: run a fixed sequence on the fresh ledger and snapshot its
  // Merkle root before the workload perturbs it, so every backend's root covers the identical postings.
  await runDeterminismSequence(p.economy);
  const root = await determinismRoot(p);

  const poolSize = poolSizeForMode(p.concurrency, p.mode);
  const kinds: KindRates[] = [];
  for (const kind of [topUpKind(), spendKind(poolSize), payoutKind(poolSize)]) {
    const r = await measureKind(p.economy, p.concurrency, kind, p.counters);
    reportKind(p, r);
    kinds.push(r);
  }
  // Provability gate: the numbers above came from a ledger that must still pass every invariant. A
  // failure is loud and flips the process exit code; it never silently passes.
  const { ok, report } = await proveEconomyOrReport(p.economy);
  if (ok) {
    console.warn('      prove          PASS — every invariant holds');
  } else {
    anyProveFailed = true;
    console.warn(`      prove          FAIL — ${JSON.stringify(report)}`);
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
  };
}

type CurveRow = {
  postings: number;
  accounts: number;
  prove: number;
  seal: number;
  verify: number;
};

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
    `gates ${cfg.gates}, pools sized ${cfg.connsPerOp}×concurrency + ${cfg.poolHeadroom} for the two-connection-per-op write path.`,
);
console.warn(
  'They show relative cost and scaling shape, not production capacity.',
);
console.warn(
  `\nsubmit throughput (best of ${cfg.reps} × ${cfg.ops}; seq = one at a time, con = ${cfg.concurrency} in flight; rate over committed ops only):`,
);

const results: BackendResult[] = [];
for (const backend of cfg.backends) {
  console.warn(`  ${backend}: measuring...`);
  if (backend !== 'in-memory') {
    console.warn(
      `    connecting to ${maskUrl(backend === 'postgres' ? cfg.urls.postgres : cfg.urls.mysql)}`,
    );
  }
  const p = await tryProvision(backend, cfg);
  if (!p) continue;
  try {
    results.push(await throughputFor(p));
  } catch (e) {
    // Contain a mid-run failure to this backend (e.g. a dropped connection, or a prove-walk that hit
    // a connection error) so the others' results and the integrity curve below still print. But a
    // backend that provisioned and then THREW is a failure, not a provisioning skip: fail the run
    // loudly (exit non-zero) so it can never be mistaken for a clean pass — distinct from tryProvision
    // returning null for an unreachable backend, which is the intended skip.
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
  `Concurrent throughput — ops/sec, up to ${cfg.concurrency} in flight (pipelined; in-memory is serial so con≈seq)`,
  ['backend', ...kindNames, 'provable'],
  results.map((r) => [
    r.backend,
    ...kindNames.map((n) => conRate(r, n)),
    r.provable ? 'yes' : 'NO',
  ]),
);

// Latency distribution under concurrency, over committed ops only (ms; p99 reads "spend's worst 1% of
// committed ops"). A fat p99/max beside a healthy p50 is the contention a best-of-N mean would smooth
// away — the stalls a stress bench exists to expose.
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

// Surface what did NOT commit under concurrency, split by cause — never a blanket "deadlock". Each line
// names the rejections (data, no money moved), the throws past the retry budget (with the REAL class +
// driver code), the retries withTransientRetry absorbed, and — authoritatively — the deadlocks the
// ENGINE itself detected (counter Δ). App-side throws are what surfaced; the DB counter is ground truth.
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

// Cross-engine determinism: the same fixed sequence must reach the same Merkle root on every backend
// that ran; a mismatch is a real correctness bug, so it is loud and flips the exit code. The reference
// is in-memory when present, else any backend that ran (so two SQL engines are still compared when
// in-memory is excluded). Fewer than two backends → nothing to compare, reported as "not run".
if (results.length >= 2) {
  determinismChecked = true;
  const reference =
    results.find((r) => r.backend === 'in-memory') ?? results[0]!;
  const disagree = results.filter(
    (r) => r.determinismRoot !== reference.determinismRoot,
  );
  if (disagree.length === 0) {
    console.warn(
      `\ncross-engine determinism: PASS — ${results.length} backends reached identical chain root ${reference.determinismRoot.slice(0, 16)}…`,
    );
  } else {
    anyProveFailed = true;
    determinismOk = false;
    console.warn(
      `\ncross-engine determinism: FAIL — ${reference.backend} root ${reference.determinismRoot.slice(0, 16)}… but ` +
        disagree
          .map((r) => `${r.backend}=${r.determinismRoot.slice(0, 16)}…`)
          .join(', '),
    );
  }
} else {
  console.warn(
    `\ncross-engine determinism: not run — fewer than two backends produced a root to compare.`,
  );
}

const curve = await integrityCurve();
printTable(
  'Integrity cost vs ledger size — in-memory, ms (lower is better)',
  ['postings', 'accounts', 'prove()', 'seal', 'verify'],
  curve.map((c) => [
    num(c.postings),
    num(c.accounts),
    ms(c.prove),
    ms(c.seal),
    ms(c.verify),
  ]),
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
  // Each backend's `kinds[].con` carries the full taxonomy, latency, retry pressure, and deadlock Δ, so
  // the JSON is as complete as the table.
  throughput: results,
  // Run-level verdicts a CI job can assert on. `provable` requires at least one backend to have completed;
  // `crossEngineDeterministic` is agreed/disagreed, or null when fewer than two backends were compared.
  provable: results.length > 0 && results.every((r) => r.provable),
  crossEngineDeterministic: determinismChecked ? determinismOk : null,
  integrityCurve: curve,
});

// Fail loudly: exit non-zero when a prove gate failed, a backend errored mid-run, or the roots
// disagreed, so a broken (or empty) run can never read as a pass. Exit explicitly since open SQL pools
// would otherwise keep the event loop alive.
if (anyProveFailed) {
  console.warn(
    '\nFAIL: a prove gate, a mid-run backend error, or the cross-engine determinism check did not pass — see above. Exiting non-zero.',
  );
}
// eslint-disable-next-line n/no-process-exit
process.exit(anyProveFailed ? 1 : 0);
