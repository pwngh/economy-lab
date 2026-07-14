/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 */

/**
 * X-ray: one generic Proxy over the facade that records every call — its name, arguments,
 * wall-clock duration, and a summary of the result — into a sink. Adding a facade method never
 * touches the recorder; the Proxy wraps whatever methods exist.
 */

import type { ConsoleEngine } from '~/economy';

export interface RecordedCall {
  id: number;
  name: string;
  args: string;
  ms: number;
  result: string;
}

function scalar(v: unknown): string {
  if (typeof v === 'string') {
    return `'${v}'`;
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v);
}

function summarizeArg(v: unknown): string {
  if (v === null || v === undefined) {
    return String(v);
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).slice(0, 3);
    return `{ ${entries.map(([k, val]) => `${k}: ${scalar(val)}`).join(', ')} }`;
  }
  return scalar(v);
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) {
    return String(result);
  }
  if (Array.isArray(result)) {
    return `${result.length} rows`;
  }
  if (typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if ('rows' in o && 'total' in o) {
      return `${o.total} total`;
    }
    // allGreen is prove()'s summary; test it before backed, which prove() also carries.
    if ('allGreen' in o) {
      return `allGreen=${o.allGreen}`;
    }
    if ('backed' in o) {
      return `backed=${o.backed}`;
    }
    if ('paused' in o) {
      return `paused=${o.paused}`;
    }
    return `{ ${Object.keys(o).slice(0, 3).join(', ')} }`;
  }
  return scalar(result);
}

// Wraps an engine so every method call it makes is timed and appended to `sink`. Async methods are
// timed across their whole promise; sync ones are timed inline.
export function recordCalls(
  engine: ConsoleEngine,
  sink: RecordedCall[],
): ConsoleEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      const method = value as (...a: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const start = performance.now();
        const done = (result: unknown) => {
          sink.push({
            id: sink.length,
            name: String(prop),
            args: args.map(summarizeArg).join(', '),
            ms: Math.round((performance.now() - start) * 100) / 100,
            result: summarizeResult(result),
          });
          return result;
        };
        const out = method(...args);
        return out instanceof Promise ? out.then(done) : done(out);
      };
    },
  });
}
