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

export type Signal = {
  at: number;
  source: 'meter' | 'log';
  name: string;
  value: number;
  tags: Readonly<Record<string, string>>;
};

export type SignalFeed = {
  since(t: number): ReadonlyArray<Signal>;
};

export type OpsRuntime = {
  meter: Meter;
  logger: Logger;
  signals: SignalFeed;
};

const DEFAULT_CAPACITY = 10_000;

// Log fields are forwarded but never buffered: detectors match on event names and
// levels only, so arbitrary field payloads never outlive the host's own log pipeline.
export function opsRuntime(
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
