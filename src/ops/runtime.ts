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

import type { Clock, Logger, Meter } from '#src/ports.ts';

/**
 * One buffered telemetry event. Meter counts and observations buffer as-is; a log call buffers
 * as name = event, value = 1, and tags = `{ level }` only — log fields are forwarded to the
 * host logger but never buffered, so detectors match on event names and levels alone.
 */
export type Signal = {
  /** Host-clock milliseconds at capture, the timestamp {@link SignalFeed.since} filters on. */
  at: number;
  source: 'meter' | 'log';
  name: string;
  value: number;
  tags: Readonly<Record<string, string>>;
};

/** The read side of the buffer the detectors poll. */
export type SignalFeed = {
  /** Every buffered signal with `at >= t`, oldest first. Evicted signals are gone. */
  since(t: number): ReadonlyArray<Signal>;
};

/**
 * What {@link createOpsRuntime} returns. The composition consumes `meter` and `logger` in place
 * of the host pair; `signals` is the feed the supervisor's detectors read.
 */
export type OpsRuntime = {
  meter: Meter;
  logger: Logger;
  signals: SignalFeed;
};

const DEFAULT_CAPACITY = 10_000;

/**
 * Wraps a host meter/logger pair with pass-through-plus-buffer instrumentation: every call is
 * forwarded to the host implementation unchanged (same arguments, host first), then recorded as
 * a {@link Signal} stamped from the host clock. The buffer is a bounded window — `capacity`
 * signals, 10,000 by default — and the oldest signals are dropped once it fills, so detectors
 * see recent history, never an unbounded log. Log fields are forwarded but never buffered, so
 * arbitrary field payloads never outlive the host's own log pipeline.
 *
 * @example
 * const ops = createOpsRuntime({ meter, logger, clock });
 * // compose the economy with the wrapped pair; the host pair still sees every call
 * const ports = await openPorts(env, { clock, meter: ops.meter, logger: ops.logger });
 * // ops.signals feeds createSupervisor / createSupervisorFrom
 */
export function createOpsRuntime(
  host: { meter: Meter; logger: Logger; clock: Clock },
  options: { capacity?: number } = {},
): OpsRuntime {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const buffer: Signal[] = [];
  const record = (signal: Signal): void => {
    buffer.push(signal);
    if (buffer.length > capacity) {
      buffer.splice(0, buffer.length - capacity);
    }
  };
  return {
    meter: {
      count: (name, n, tags) => {
        host.meter.count(name, n, tags);
        record({
          at: host.clock.now(),
          source: 'meter',
          name,
          value: n,
          tags: tags ?? {},
        });
      },
      observe: (name, value, tags) => {
        host.meter.observe(name, value, tags);
        record({
          at: host.clock.now(),
          source: 'meter',
          name,
          value,
          tags: tags ?? {},
        });
      },
    },
    logger: {
      log: (level, event, fields) => {
        host.logger.log(level, event, fields);
        record({
          at: host.clock.now(),
          source: 'log',
          name: event,
          value: 1,
          tags: { level },
        });
      },
    },
    signals: {
      since: (t) => buffer.filter((signal) => signal.at >= t),
    },
  };
}
