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

// Rig honesty for the bench: a per-backend canary and a container health snapshot, so a tripped
// honesty check can be answered — "the rig moved under this run, rerun" vs "the code regressed,
// investigate" — instead of only known-clean by a lucky re-run.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Store } from '#src/ports.ts';

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// --- Canary ------------------------------------------------------------------------

export type CanaryResult = { ops: number; ms: number; opsPerSec: number };

// A fixed number of tiny, isolated commits (one entitlement grant per transaction) timed as a
// commit-latency probe. Entitlements are not ledger rows, so this touches neither the determinism
// root (over chain heads) nor the integrity curve (over postings). Null when disabled (ops <= 0).
export async function measureCanary(
  store: Store,
  ops: number,
  keyPrefix: string,
): Promise<CanaryResult | null> {
  if (ops <= 0) return null;
  const user = `usr_canary_${keyPrefix}`;
  const t0 = performance.now();
  for (let k = 0; k < ops; k++) {
    await store.transaction((unit) =>
      unit.entitlements.grant(user, `sku_canary_${keyPrefix}_${k}`, {}),
    );
  }
  const ms = performance.now() - t0;
  return { ops, ms, opsPerSec: (ops * 1000) / ms };
}

// --- Container health ---------------------------------------------------------------

export type ContainerHealth = {
  service: string;
  status: string; // .State.Status, e.g. "running"
  health: string | null; // .State.Health.Status, or null when no healthcheck is declared
  restartCount: number; // .RestartCount — a bump between rounds is unambiguous rig degradation
};

// The compose service backing a SQL backend; in-memory has no container.
export function backendService(backend: string): string | null {
  return backend === 'postgres' || backend === 'mysql' ? backend : null;
}

// Resolve a compose service's container id, trying the v2 plugin then the v1 binary (as docker.sh does).
async function composeContainerId(service: string): Promise<string | null> {
  const attempts: Array<[string, string[]]> = [
    ['docker', ['compose', 'ps', '-q', service]],
    ['docker-compose', ['ps', '-q', service]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await run(cmd, args, {
        cwd: REPO_ROOT,
        timeout: 5000,
      });
      const id = stdout.trim().split('\n')[0]?.trim();
      if (id) return id;
    } catch {
      // Fall through to the next invocation form.
    }
  }
  return null;
}

// Best-effort: null whenever docker/compose is unavailable, the service is not up, or inspect
// fails — so a rig without docker, or the bench container itself, simply records no container info
// rather than failing the run.
export async function snapshotContainer(
  service: string,
): Promise<ContainerHealth | null> {
  try {
    const id = await composeContainerId(service);
    if (!id) return null;
    const { stdout } = await run(
      'docker',
      [
        'inspect',
        '--format',
        '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}',
        id,
      ],
      { cwd: REPO_ROOT, timeout: 5000 },
    );
    const [status, health, restarts] = stdout.trim().split('|');
    return {
      service,
      status: status ?? 'unknown',
      health: !health || health === 'none' ? null : health,
      restartCount: Number(restarts ?? 0) || 0,
    };
  } catch {
    return null;
  }
}

// --- Verdict ------------------------------------------------------------------------

export type CanaryVerdict = { degraded: boolean; text: string };

// Adjudicate a round whose honesty checks tripped, against the session baseline (the first round):
// a restarted/unhealthy container or a canary that fell past `dropPct` is the rig moving under the
// run (rerun); a canary that held is a suspected code regression (investigate).
export function canaryVerdict(opts: {
  backend: string;
  baseline: CanaryResult | null;
  current: CanaryResult | null;
  baseContainer: ContainerHealth | null;
  curContainer: ContainerHealth | null;
  dropPct?: number;
}): CanaryVerdict {
  const { backend, baseline, current, baseContainer, curContainer } = opts;
  const dropPct = opts.dropPct ?? 15;

  if (
    baseContainer &&
    curContainer &&
    curContainer.restartCount > baseContainer.restartCount
  ) {
    return {
      degraded: true,
      text: `${backend}: container ${curContainer.service} restarted (${baseContainer.restartCount} -> ${curContainer.restartCount}) — rig degraded, rerun`,
    };
  }
  if (
    curContainer &&
    curContainer.health &&
    curContainer.health !== 'healthy'
  ) {
    return {
      degraded: true,
      text: `${backend}: container ${curContainer.service} is ${curContainer.health} — rig degraded, rerun`,
    };
  }
  if (baseline && current && baseline.opsPerSec > 0) {
    const pct =
      ((current.opsPerSec - baseline.opsPerSec) / baseline.opsPerSec) * 100;
    if (pct <= -dropPct) {
      return {
        degraded: true,
        text: `${backend}: rig degraded (canary ${pct.toFixed(0)}% vs baseline ${Math.round(baseline.opsPerSec)} ops/sec), rerun`,
      };
    }
    const sign = pct >= 0 ? '+' : '';
    return {
      degraded: false,
      text: `${backend}: regression suspected (canary ${sign}${pct.toFixed(0)}% vs baseline — the rig held), investigate`,
    };
  }
  return {
    degraded: false,
    text: `${backend}: no canary baseline to compare — verdict withheld`,
  };
}
