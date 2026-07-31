/**
 * @pwngh/economy-test
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { memoryPorts } from '@pwngh/economy-lab';
import type { Economy, Ports } from '@pwngh/economy-lab';
import {
  fixedClock,
  memoryStore,
  sequentialIds,
} from '@pwngh/economy-lab/adapters';
import type { SweepRun } from '@pwngh/economy-lab/worker';
import { createApp, type App } from '@pwngh/economy-core';
import {
  effectivePolicy,
  resolveEconomyModule,
  withDev,
} from '@pwngh/economy-core/module';
import type { EconomyModule } from '@pwngh/economy-core/module';

export interface TestClock {
  now(): number;
  advance(ms: number): number;
}

export interface TestEconomyOptions {
  /** Where `fixedClock` starts, in epoch milliseconds. Default 0. */
  readonly now?: number;
  /** Stated only when a test verifies an inbound provider callback. */
  readonly webhookSecret?: string;
}

export interface TestApp {
  readonly app: App;
  readonly economy: Economy;
  readonly clock: TestClock;
  /** The app's handler as a plain fetch: `request('/healthz')`. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** One full sweep pass — the worker cycle plus the fast lanes when the seam is present. */
  tick(): Promise<SweepRun>;
  /** The resolved module in canonical form — stable keys, functions named, bigints as strings. */
  canonical(): unknown;
  close(): Promise<void>;
}

/**
 * A deterministic app: memory ports over `fixedClock` and `sequentialIds`, so two runs of
 * the same test produce the same rows. The worker is built but never started — time passes
 * through `clock.advance`, work through `tick`, and nothing listens, so nothing ever ticks
 * on its own. The bag rides createApp's `portsBag`, which wins wholesale: a module's own
 * `ports` overrides are not applied — the harness owns the ports by contract.
 */
export async function testApp(
  module: EconomyModule | Record<string, unknown>,
  options: TestEconomyOptions = {},
): Promise<TestApp> {
  const mod =
    'file' in module && 'exports' in module
      ? (module as unknown as ReturnType<typeof resolveEconomyModule>)
      : resolveEconomyModule(module as Record<string, unknown>, '(testApp)');
  const clock = fixedClock(options.now ?? 0);
  const ids = sequentialIds();
  const base = memoryPorts({
    signingKey: 'economy-test',
    // portsBag wins wholesale, so the harness compiles policy into its own bag.
    config: effectivePolicy(mod),
    ...(options.webhookSecret
      ? { secrets: { webhookSecret: options.webhookSecret } }
      : {}),
  });
  // The store must share the fixed clock, or its timestamps drift from the app's time.
  const store = memoryStore({
    digest: base.digest,
    clock,
    velocityWindowMs: base.config.velocityWindowMs,
  });
  const ports: Ports = { ...base, clock, ids, store };
  // withDev supplies the token-table posture when the module states none; the bag wins ports.
  const app = await createApp(withDev(mod), { env: {}, portsBag: ports });
  return {
    app,
    economy: app.economy,
    clock,
    request: (path, init) =>
      app.handler(new Request(`http://testapp${path}`, init)),
    async tick() {
      const run = app.worker ? await app.worker.sweep() : null;
      if (app.instances) await app.instances.sweep();
      if (!run) throw new Error('tick() with `worker: false` — nothing to run');
      return run;
    },
    canonical: () => canonicalForm({ ...mod }),
    close: () => app.close(),
  };
}

/** Stable keys, `[fn name]` for functions, decimal strings for bigints. */
export function canonicalForm(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[fn ${value.name || 'anonymous'}]`;
  if (Array.isArray(value)) return value.map(canonicalForm);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonicalForm((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
