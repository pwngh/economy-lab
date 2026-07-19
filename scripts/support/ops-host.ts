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

// Optional host-layer composition of the `./ops` supervisor (OPS=1): the worker
// composition's meter/logger are wrapped in the ops signal buffer, and the
// supervisor ticks on its own interval, writing audit records to stdout as
// JSONL. The core never sees any of this — leaving the supervisor out of the
// composition is the off switch, and the lab cannot tell it is observed.

import {
  createSupervisor,
  jsonlAuditSink,
  createOpsRuntime,
} from '#src/ops/index.ts';
import { readFlag, readInt } from '#src/env.ts';

import type { EnvMap } from '#src/env.ts';
import type { Clock, Logger, Meter, Scheduler } from '#src/ports.ts';
import type { OpsRuntime, SagaSource } from '#src/ops/index.ts';

/** Every name this host reads; .env.example is held to this list. */
export const OPS_KEYS = ['OPS', 'OPS_INTERVAL_MS'] as const;

/** The levers the running worker hands the supervisor once composition is done. */
export interface OpsLevers {
  sagas: SagaSource;
  runSweep: (now: number) => Promise<unknown>;
  runRelay?: (now: number) => Promise<unknown>;
  reviveInbox?: (limit: number) => Promise<ReadonlyArray<{ id: string }>>;
  pauseWorker?: () => void;
  prove?: () => Promise<unknown>;
}

export interface OpsHost {
  /** The wrapped meter/logger the composition must consume for signals to flow. */
  runtime: OpsRuntime;
  /** Starts the supervisor loop; the returned function stops it. */
  start(levers: OpsLevers): () => void;
}

/**
 * Builds the supervisor host when `OPS=1`; resolves undefined otherwise, and the
 * worker runs exactly as before. Escalations reach the host log as `ops.escalated`
 * (the full record is already on stdout); the raw logger is used so an escalation
 * never re-enters the signal buffer as its own signal.
 */
export function maybeOps(
  env: EnvMap,
  host: { clock: Clock; logger: Logger; meter: Meter },
): OpsHost | undefined {
  if (!readFlag(env.OPS)) {
    return undefined;
  }
  const intervalMs = readInt(env.OPS_INTERVAL_MS, 60_000, { min: 1 });
  const runtime = createOpsRuntime(host);
  return {
    runtime,
    start: (levers) => {
      const supervisor = createSupervisor(
        {
          clock: host.clock,
          signals: runtime.signals,
          sagas: levers.sagas,
          runSweep: levers.runSweep,
          runRelay: levers.runRelay,
          reviveInbox: levers.reviveInbox,
          pauseWorker: levers.pauseWorker,
          prove: levers.prove,
          audit: jsonlAuditSink((line) => process.stdout.write(`${line}\n`)),
          escalate: (record) =>
            host.logger.log('error', 'ops.escalated', {
              signature: record.signature,
              subject: record.subject,
            }),
        },
        intervalScheduler(),
      );
      return supervisor.start?.(intervalMs) ?? (() => {});
    },
  };
}

function intervalScheduler(): Scheduler {
  return {
    every: (ms, task) => {
      const timer = setInterval(() => void task(), ms);
      return () => clearInterval(timer);
    },
  };
}
