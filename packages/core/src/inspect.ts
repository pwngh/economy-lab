/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { ROUTES } from '@pwngh/economy-lab/contract';
import type { RouteRow } from '@pwngh/economy-lab/contract';
import { SWEEP_NAMES } from '@pwngh/economy-lab/worker';
import type { SweepName } from '@pwngh/economy-lab/worker';
import type { ResolvedModule } from './module.js';
import type { Knob } from './app.js';

export interface InspectReport {
  readonly file: string;
  readonly exports: readonly string[];
  readonly posture: string;
  readonly ports: string;
  readonly port: number | null;
  readonly worker: {
    readonly enabled: boolean;
    readonly sweeps: readonly string[];
  };
  readonly config: readonly Knob[];
}

export function inspectReport(
  mod: ResolvedModule,
  config: readonly Knob[],
  extra: { posture: string; ports: string; port: number | null },
): InspectReport {
  const w = mod.worker;
  return {
    file: mod.file,
    exports: mod.exports,
    posture: extra.posture,
    ports: extra.ports,
    port: extra.port,
    worker: {
      enabled: w !== false,
      sweeps: activeSweeps(mod) ?? SWEEP_NAMES,
    },
    config,
  };
}

/**
 * The sweep list after module narrowing; undefined = all sixteen. The payouts flag never
 * narrows this: the sweep must keep running so a declined saga fails fast and its hold
 * releases — excluding it would strand accepted payouts.
 */
export function activeSweeps(
  mod: ResolvedModule,
): readonly SweepName[] | undefined {
  return mod.worker && mod.worker.sweeps
    ? (mod.worker.sweeps as readonly SweepName[])
    : undefined;
}

export interface Capabilities {
  readonly routes: readonly { method: string; path: string }[];
  /** Declared provider names; presence mounts `POST /webhooks/:provider`. */
  readonly providers: readonly string[];
  readonly instances: boolean;
  readonly worker: {
    readonly enabled: boolean;
    readonly jobs: readonly string[];
  };
}

/**
 * The lab routes this module mounts, in registry order and in path-parameter spelling.
 *
 * `ROUTES` is the registry the server serves and the OpenAPI is generated from, so reading it
 * is what keeps this report honest. It spells parameters `{provider}` for OpenAPI; a report a
 * host matches against its own router wants `:provider`.
 */
function labRoutes(mod: ResolvedModule): { method: string; path: string }[] {
  const mounted: Record<NonNullable<RouteRow['when']>, boolean> = {
    webhook: Object.keys(mod.providers ?? {}).length > 0,
    instances: !!mod.instances,
    reads: mod.flags?.reads !== false,
  };
  return ROUTES.filter((r) => r.when === undefined || mounted[r.when]).map(
    (r) => ({ method: r.method, path: r.path.replace(/\{(\w+)\}/g, ':$1') }),
  );
}

/** Only routes that actually answer; the honesty test holds this against the served table. */
export function capabilitiesReport(
  mod: ResolvedModule,
  network: boolean,
): Capabilities {
  return {
    routes: network
      ? [
          ...labRoutes(mod),
          ...Object.keys(mod.routes ?? {}).map((k) => {
            const [method = '', path = ''] = [
              k.slice(0, k.indexOf(' ')),
              k.slice(k.indexOf(' ') + 1),
            ];
            return { method, path };
          }),
        ]
      : [],
    providers: Object.keys(mod.providers ?? {}),
    instances: !!mod.instances,
    worker: {
      enabled: mod.worker !== false,
      jobs: activeSweeps(mod) ?? SWEEP_NAMES,
    },
  };
}

export function posture(mod: ResolvedModule): string {
  if (mod.authenticate === false) return 'trusted (in-process only)';
  if (typeof mod.authenticate === 'function') return 'function';
  return 'unstated — dev injects tokens; listen refuses';
}
