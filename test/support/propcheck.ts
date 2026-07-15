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

/**
 * A hand-rolled property-based testing core, not fast-check: seeded `Arbitrary` generators that
 * compose, and a multi-axis `minimize` that reduces a failing value to its smallest still-failing
 * form. Seeds are always explicit, so a failing run reproduces byte-identically. This is the shrinker
 * the seeded programs in `scripts/prove.ts` never had — that one only trims the tail.
 */

/** Uniform in [0, 1). */
export type Rng = () => number;

// mulberry32: a fixed seed yields the same stream on every runtime, so a counterexample replays.
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Knows how to generate a value and how to shrink one into simpler candidates, simplest first. */
export type Arbitrary<T> = {
  generate: (rng: Rng) => T;
  shrink: (value: T) => T[];
};

/** Integer in [min, max], shrinking toward `min` by halving the remaining distance. */
export function int(min: number, max: number): Arbitrary<number> {
  return {
    generate: (rng) => min + Math.floor(rng() * (max - min + 1)),
    shrink: (v) => {
      const out: number[] = [];
      let cur = min;
      while (cur < v) {
        out.push(cur);
        const step = Math.max(1, Math.floor((v - cur) / 2));
        if (cur + step >= v) break;
        cur += step;
      }
      return out;
    },
  };
}

/** One of a fixed set, shrinking toward earlier values (so 'other' can simplify to 'system'). */
export function choice<T>(...values: T[]): Arbitrary<T> {
  return {
    generate: (rng) => values[Math.floor(rng() * values.length)]!,
    shrink: (v) => {
      const i = values.indexOf(v);
      return i > 0 ? values.slice(0, i) : [];
    },
  };
}

/** A record of Arbitraries; shrinks one field at a time. */
export function record<T extends object>(shape: {
  [K in keyof T]: Arbitrary<T[K]>;
}): Arbitrary<T> {
  const keys = Object.keys(shape) as (keyof T)[];
  return {
    generate: (rng) => {
      const out = {} as T;
      for (const key of keys) out[key] = shape[key].generate(rng);
      return out;
    },
    shrink: (v) => {
      const out: T[] = [];
      for (const key of keys) {
        for (const shrunk of shape[key].shrink(v[key])) {
          out.push({ ...v, [key]: shrunk });
        }
      }
      return out;
    },
  };
}

/**
 * A variable-length array; shrinks by dropping elements — empty, each half, then one at a time — and
 * by shrinking individual elements. Dropping a middle element is what a prefix-only shrinker misses.
 */
export function array<T>(elem: Arbitrary<T>, maxLen: number): Arbitrary<T[]> {
  return {
    generate: (rng) => {
      const n = Math.floor(rng() * (maxLen + 1));
      const out: T[] = [];
      for (let i = 0; i < n; i += 1) out.push(elem.generate(rng));
      return out;
    },
    shrink: (v) => {
      const out: T[][] = [];
      if (v.length === 0) return out;
      out.push([]);
      if (v.length > 2) {
        out.push(v.slice(0, v.length >> 1));
        out.push(v.slice(v.length >> 1));
      }
      for (let i = 0; i < v.length; i += 1) {
        out.push([...v.slice(0, i), ...v.slice(i + 1)]);
      }
      for (let i = 0; i < v.length; i += 1) {
        for (const shrunk of elem.shrink(v[i]!)) {
          out.push([...v.slice(0, i), shrunk, ...v.slice(i + 1)]);
        }
      }
      return out;
    },
  };
}

export type Property<T> = (value: T) => boolean | Promise<boolean>;

export type Report<T> =
  | { ok: true; runs: number }
  | { ok: false; seed: number; counterexample: T; shrinks: number };

/**
 * Greedily reduces a failing value: repeatedly takes the first simpler candidate that still fails,
 * until nothing simpler fails. Deterministic given the property. Results are memoized per call —
 * different shrink axes reproduce the same candidate, and for a property that replays a whole
 * program, re-testing it is the expensive part.
 */
export async function minimize<T>(
  arb: Arbitrary<T>,
  prop: Property<T>,
  value: T,
): Promise<[T, number]> {
  const seen = new Map<string, boolean>();
  const holds = async (candidate: T): Promise<boolean> => {
    let key: string | null = null;
    try {
      key = JSON.stringify(candidate);
    } catch {
      // Not serializable (bigint values, cycles): test it uncached.
    }
    if (key !== null && seen.has(key)) return seen.get(key)!;
    const result = await prop(candidate);
    if (key !== null) seen.set(key, result);
    return result;
  };
  let current = value;
  let steps = 0;
  for (;;) {
    let advanced = false;
    for (const candidate of arb.shrink(current)) {
      if (!(await holds(candidate))) {
        current = candidate;
        steps += 1;
        advanced = true;
        break;
      }
    }
    if (!advanced) return [current, steps];
  }
}

/**
 * Runs `prop` over `runs` values from `seed`. On the first failure, minimizes it and reports the
 * smallest counterexample plus the exact seed that produced it. The seed is required — a property
 * test with no reproducible seed is a flaky test.
 */
export async function check<T>(
  arb: Arbitrary<T>,
  prop: Property<T>,
  opts: { seed: number; runs?: number },
): Promise<Report<T>> {
  const runs = opts.runs ?? 100;
  const base = opts.seed >>> 0;
  for (let i = 0; i < runs; i += 1) {
    const seed = (base + i) >>> 0;
    const value = arb.generate(mulberry32(seed));
    if (!(await prop(value))) {
      const [counterexample, shrinks] = await minimize(arb, prop, value);
      return { ok: false, seed, counterexample, shrinks };
    }
  }
  return { ok: true, runs };
}
