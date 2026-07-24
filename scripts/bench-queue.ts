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

// Sequential bench session runner: one unattended command that runs an ordered list of bench
// invocations strictly one at a time — the only honest cadence on a machine with a single fsync
// device — with a cool-down between rounds, writing every round's JSON into one stamped
// bench-results/ directory. It baselines the per-backend rig canary on the first round and, when a
// later round's honesty checks trip, prints whether the rig moved under the run (rerun) or the code
// regressed (investigate).
//
//   npm run bench:queue                                  # the default session (throughput, then contention)
//   BENCH_QUEUE=session.json npm run bench:queue         # a custom ordered manifest
//   BENCH_QUEUE_COOLDOWN_MS=30000 npm run bench:queue    # a longer cool-down between rounds
//
// A manifest is a JSON array of rounds: [{ "label": "...", "script": "bench.ts", "env": { ... } }].

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readInt } from '#src/env.ts';
import { canaryVerdict } from '#scripts/support/rig.ts';

import type { CanaryResult, ContainerHealth } from '#scripts/support/rig.ts';

// bench-queue's own env knobs. Entry scripts execute on import, so the env-surface test lists these
// by hand rather than importing this module; keep the two lists in step.
export const BENCH_QUEUE_KEYS = [
  'BENCH_QUEUE',
  'BENCH_QUEUE_COOLDOWN_MS',
] as const;

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

type Round = { label: string; script: string; env: Record<string, string> };

// Both default rounds cover the same backends, so the round-1 canary baseline has a mate to
// compare in round 2.
const DEFAULT_QUEUE: Round[] = [
  {
    label: 'throughput',
    script: 'bench.ts',
    env: { BENCH_MODE: 'throughput' },
  },
  {
    label: 'contention',
    script: 'bench.ts',
    env: { BENCH_MODE: 'contention' },
  },
];

// One JSON round result, as much of the bench payload as the summary reads.
type RoundJson = {
  provable?: boolean;
  crossEngineDeterministic?: boolean | null;
  throughput?: Array<{
    kind?: string;
    backend?: string;
    canary?: CanaryResult | null;
    container?: ContainerHealth | null;
  }>;
};

type RoundRun = {
  label: string;
  script: string;
  env: Record<string, string>;
  exitCode: number;
  durationMs: number;
  jsonFile: string;
  json: RoundJson | null;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A round is one child running scripts/<script> on this same node binary, its output inherited so
// an attended tail still sees the tables. The overrides win over the forwarded environment, so
// BENCH_JSON_PATH lands the JSON where the session expects it regardless of any .env value.
function runRound(round: Round, jsonPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`scripts/${round.script}`], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...round.env,
        BENCH_OUTPUT: 'both',
        BENCH_JSON_PATH: jsonPath,
      },
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function loadQueue(path: string | undefined): Promise<Round[]> {
  if (!path) return DEFAULT_QUEUE;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `bench queue ${path}: expected a non-empty JSON array of rounds`,
    );
  }
  return parsed.map((entry, i) => {
    const e = entry as { label?: unknown; script?: unknown; env?: unknown };
    const env: Record<string, string> = {};
    if (e.env && typeof e.env === 'object') {
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
        env[k] = String(v);
      }
    }
    return {
      label:
        typeof e.label === 'string' && e.label ? e.label : `round-${i + 1}`,
      script: typeof e.script === 'string' && e.script ? e.script : 'bench.ts',
      env,
    };
  });
}

async function readRoundJson(path: string): Promise<RoundJson | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RoundJson;
  } catch {
    return null;
  }
}

// A round's own verdict on itself: a non-zero exit, an unprovable ledger, or a cross-engine
// disagreement all mean a printed number is not to be trusted as-is.
function honestyTripped(r: RoundRun): boolean {
  return (
    r.exitCode !== 0 ||
    r.json?.provable === false ||
    r.json?.crossEngineDeterministic === false
  );
}

const backendName = (b: {
  kind?: string;
  backend?: string;
}): string | undefined => b.kind ?? b.backend;

const secs = (ms: number): string => (ms / 1000).toFixed(1);

// --- Run ---------------------------------------------------------------------------

const cooldownMs = readInt(process.env.BENCH_QUEUE_COOLDOWN_MS, 15000, {
  min: 0,
});
const queue = await loadQueue(process.env.BENCH_QUEUE);

// Node forbids ':' in path components on some hosts; keep the stamp filesystem-clean.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const relDir = `bench-results/${stamp}`;
const absDir = join(REPO_ROOT, relDir);
await mkdir(absDir, { recursive: true });

console.warn(
  `bench-queue: ${queue.length} round(s), ${secs(cooldownMs)}s cool-down between them, into ${relDir}/\n` +
    `  strictly sequential — one fsync device, so rounds never overlap; parallel measurement waits for real hardware`,
);

const runs: RoundRun[] = [];
for (let i = 0; i < queue.length; i++) {
  const round = queue[i]!;
  const nn = String(i + 1).padStart(2, '0');
  const jsonFile = `${nn}-${round.label}.json`;
  const jsonPath = join(absDir, jsonFile);
  console.warn(
    `\n=== round ${nn}/${queue.length}: ${round.label} (${round.script}) ${JSON.stringify(round.env)} ===`,
  );
  const startedAt = Date.now();
  const exitCode = await runRound(round, jsonPath);
  const durationMs = Date.now() - startedAt;
  const json = await readRoundJson(jsonPath);
  runs.push({
    label: round.label,
    script: round.script,
    env: round.env,
    exitCode,
    durationMs,
    jsonFile,
    json,
  });
  console.warn(
    `--- round ${nn} done: exit ${exitCode}, ${secs(durationMs)}s ---`,
  );
  if (i < queue.length - 1 && cooldownMs > 0) {
    console.warn(
      `cooling down ${secs(cooldownMs)}s before the next round (one fsync device — rounds must not overlap)`,
    );
    await sleep(cooldownMs);
  }
}

// Baseline the canary and container per backend on the first round: the compare is against this
// session only, so cross-day noise never enters it.
const baseCanary = new Map<string, CanaryResult | null>();
const baseContainer = new Map<string, ContainerHealth | null>();
for (const b of runs[0]?.json?.throughput ?? []) {
  const name = backendName(b);
  if (!name) continue;
  baseCanary.set(name, b.canary ?? null);
  baseContainer.set(name, b.container ?? null);
}

console.warn('\n=== session summary ===');
for (let i = 0; i < runs.length; i++) {
  const r = runs[i]!;
  const nn = String(i + 1).padStart(2, '0');
  const tripped = honestyTripped(r);
  console.warn(
    `  round ${nn} ${r.label.padEnd(12)} exit ${r.exitCode}  ${secs(r.durationMs)}s  ` +
      `provable ${r.json?.provable ?? 'n/a'}  determinism ${r.json?.crossEngineDeterministic ?? 'n/a'}` +
      (tripped ? '  ⚠ honesty check tripped' : ''),
  );
  if (!tripped) continue;
  if (i === 0) {
    console.warn(
      '      (round 1 is the canary baseline — no prior rig state to compare; rerun to see if it clears)',
    );
    continue;
  }
  for (const b of r.json?.throughput ?? []) {
    const name = backendName(b);
    if (!name) continue;
    const verdict = canaryVerdict({
      backend: name,
      baseline: baseCanary.get(name) ?? null,
      current: b.canary ?? null,
      baseContainer: baseContainer.get(name) ?? null,
      curContainer: b.container ?? null,
    });
    console.warn(
      `      ${verdict.degraded ? 'RIG ' : 'CODE'}  ${verdict.text}`,
    );
  }
}

await writeFile(
  join(absDir, 'session.json'),
  JSON.stringify(
    {
      tool: 'economy-lab-bench-queue',
      node: process.version,
      startedAt: stamp,
      cooldownMs,
      dir: relDir,
      rounds: runs.map((r) => ({
        label: r.label,
        script: r.script,
        env: r.env,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        jsonFile: r.jsonFile,
        provable: r.json?.provable ?? null,
        crossEngineDeterministic: r.json?.crossEngineDeterministic ?? null,
      })),
    },
    null,
    2,
  ) + '\n',
);

console.warn(`\nwrote ${queue.length} round(s) + session.json to ${relDir}/`);

const failed = runs.some((r) => r.exitCode !== 0);
// Exit explicitly: any lingering child handles would otherwise keep the loop alive.
// eslint-disable-next-line n/no-process-exit
process.exit(failed ? 1 : 0);
