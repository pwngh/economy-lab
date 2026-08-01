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

// The optional integrations this repository runs its own economy on, and the one place they are
// composed. Each is off until its env name opts it in, and each reaches the framework through a
// seam the module contract already has: a port slot, or a flag. Nothing here opens a socket or
// starts a timer — createApp does both, once, for the module it loaded.
//
// Resources follow the slot that carries them: a wiring that opened a pool hands it in behind a
// port with a close(), which is what economy.close() releases. Nothing here registers a signal
// handler of its own.

import { maybeEdgeTilia } from '#economy/lib/edge-host.ts';
import { maybeStore } from '#economy/lib/store-host.ts';
import { maybeTaskqHost } from '#economy/lib/taskq-host.ts';
import { readFlag } from '#src/env.ts';

import type { EnvMap } from '#src/env.ts';
import type { Dispatcher, Logger, PayeeDirectory } from '#src/ports.ts';
import type { PortsOverrides } from '@pwngh/economy/module';

export type HostWiringName = 'store' | 'edge' | 'taskq' | 'supervisor';

/** One optional integration: what turns it on, and what it hands the module. */
export interface HostWiring {
  readonly name: HostWiringName;
  /** The env name that opts it in. Unset leaves the framework's own default in place. */
  readonly optIn: string;
  /** The seams it fills — port slot names, or a flag in dotted form. */
  readonly contributes: readonly string[];
}

/**
 * Every wiring this app can compose. {@link openHostWirings} is held to it by
 * `test/lab-app.test.ts`: a wiring that stops being composed, or one composed but unlisted,
 * fails there rather than disappearing from a deployment nobody re-reads.
 */
export const HOST_WIRINGS: readonly HostWiring[] = [
  // First, because the queue below reads the store's own database to decide where its table
  // lives. Unset leaves the framework's in-memory selection alone.
  { name: 'store', optIn: 'DATABASE_URL', contributes: ['store'] },
  {
    name: 'edge',
    optIn: 'TILIA_CLIENT_ID',
    contributes: ['processor', 'payees'],
  },
  { name: 'taskq', optIn: 'TASKQ', contributes: ['dispatcher'] },
  {
    name: 'supervisor',
    optIn: 'SUPERVISOR',
    contributes: ['flags.supervisor'],
  },
];

/** What the module file exports, plus the roster of what this environment turned on. */
export interface HostComposition {
  /** Port overrides, or undefined when no wiring supplies one — never an empty bag. */
  readonly ports: PortsOverrides | undefined;
  readonly flags: { readonly supervisor: true } | undefined;
  /** The wirings this environment turned on, in roster order. Empty is the default deployment. */
  readonly composed: readonly HostWiringName[];
}

/**
 * Reads the environment once and builds whatever it opted into. A misconfigured opt-in throws
 * here, at module load, which is before `serve` binds and before `worker` sweeps.
 */
export async function openHostWirings(
  env: EnvMap,
  logger: Logger,
): Promise<HostComposition> {
  const composed: HostWiringName[] = [];
  const ports: Record<string, unknown> = {};

  const store = await maybeStore(env, logger);
  if (store !== undefined) {
    composed.push('store');
    ports.store = store.store;
  }

  const edge = await maybeEdgeTilia(env, logger);
  if (edge !== undefined) {
    composed.push('edge');
    ports.processor = edge.processor;
    // The payee directory is the only slot holding the edge's pool, and it is a slot
    // economy.close() releases — so the framework closes what this module opened.
    const payees: PayeeDirectory = {
      status: (userId, options) => edge.payees.status(userId, options),
      close: () => edge.stop(),
    };
    ports.payees = payees;
  }

  const taskq = await maybeTaskqHost(env, logger);
  if (taskq !== undefined) {
    composed.push('taskq');
    const dispatcher: Dispatcher = Object.assign(
      (event: Parameters<Dispatcher>[0], options?: Parameters<Dispatcher>[1]) =>
        taskq.dispatcher(event, options),
      { close: () => taskq.stop() },
    );
    ports.dispatcher = dispatcher;
  }

  // The supervisor is the framework's own composition: `flags.supervisor` wraps the meter and
  // logger and ticks a supervisor over them. A second copy in this file would be the hand-wiring
  // this app exists to stop keeping.
  if (readFlag(env.SUPERVISOR)) {
    composed.push('supervisor');
  }

  return {
    ports: Object.keys(ports).length ? (ports as PortsOverrides) : undefined,
    flags: composed.includes('supervisor') ? { supervisor: true } : undefined,
    composed,
  };
}
