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
 * In-process ownership read model: each SKU is interned to a dense int id and each user gets a
 * bitset, so a warm `owns()` check is a bit test instead of a store round trip. Never the source
 * of truth — rebuilt from `list()`, invalidated on every write through this store, and expired
 * after `ttlMs` so writes from other processes surface as bounded staleness. Expiry is encoded
 * per slot with the same inclusive `now <= expiresAt` rule `owns()` applies in SQL.
 *
 * Pass the same `clock` the store uses, or expiry decisions here and in SQL will disagree.
 * Single-process by design.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/grant-entitlement/
 *   Grant entitlement} for the ownership records this read model projects.
 */

import type {
  Clock,
  EntitlementStore,
  CallOptions,
  Store,
  Unit,
} from '#src/ports.ts';

/** Tuning knobs. Defaults: 30s TTL, 10,000 resident users. */
export interface BitsetOptions {
  clock?: Clock;

  /** How long a user's bitmap may serve reads before it must refill from the store. */
  ttlMs?: number;

  /** Resident-user cap; the least recently used bitmap is evicted past it. */
  maxUsers?: number;
}

/** Test-only probe (`__` prefix marks it as not part of the real interface). */
export interface BitsetProbe {
  /** The synchronous warm path, exposed so tests can pin its zero-allocation property. */
  check(userId: string, sku: string, now: number): boolean | null;

  residentUsers(): number;

  bytesFor(userId: string): number;
}

interface UserBitmap {
  bits: Uint32Array;

  // Epoch-ms deadline per SKU slot, 0 for perpetual; null when every held grant is perpetual, so
  // the common case pays no second array.
  deadlines: Float64Array | null;

  loadedAt: number;
}

class BitsetCache {
  private readonly skuIds = new Map<string, number>();
  private readonly users = new Map<string, UserBitmap>();
  private readonly source: EntitlementStore;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly maxUsers: number;

  constructor(
    source: EntitlementStore,
    clock: Clock,
    ttlMs: number,
    maxUsers: number,
  ) {
    this.source = source;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxUsers = maxUsers;
  }

  // Must stay synchronous and allocation-free — a test pins this. Returns null on a cold or
  // stale bitmap so the caller falls back to the store.
  check = (userId: string, sku: string, now: number): boolean | null => {
    const entry = this.users.get(userId);
    if (entry === undefined || now - entry.loadedAt > this.ttlMs) {
      return null;
    }
    const id = this.skuIds.get(sku);
    if (id === undefined) {
      // The user's bitmap is fresh and interning covers every SKU it holds, so an unknown SKU
      // cannot be one of theirs.
      return false;
    }
    const word = id >> 5;
    if (word >= entry.bits.length) {
      return false;
    }
    if (((entry.bits[word]! >>> (id & 31)) & 1) !== 1) {
      return false;
    }
    const deadline = entry.deadlines === null ? 0 : entry.deadlines[id]!;
    return deadline === 0 || now <= deadline;
  };

  async rebuild(userId: string, options?: CallOptions): Promise<void> {
    const grants: Array<{ id: number; expiresAt: number | null }> = [];
    for await (const grant of this.source.list(userId, options)) {
      grants.push({ id: this.idOf(grant.sku), expiresAt: grant.expiresAt });
    }
    const words = (this.skuIds.size >> 5) + 1;
    const bits = new Uint32Array(words);
    let deadlines: Float64Array | null = null;
    for (const grant of grants) {
      bits[grant.id >> 5]! |= (1 << (grant.id & 31)) >>> 0;
      if (grant.expiresAt !== null) {
        deadlines ??= new Float64Array(this.skuIds.size);
        deadlines[grant.id] = grant.expiresAt;
      }
    }
    this.users.delete(userId); // re-insert so Map order stays LRU order
    this.users.set(userId, { bits, deadlines, loadedAt: this.clock.now() });
    if (this.users.size > this.maxUsers) {
      this.users.delete(this.users.keys().next().value!);
    }
  }

  invalidate(userId: string): void {
    this.users.delete(userId);
  }

  // An LRU touch without invalidating: re-insert the existing entry.
  touch(userId: string): void {
    const entry = this.users.get(userId);
    if (entry !== undefined) {
      this.users.delete(userId);
      this.users.set(userId, entry);
    }
  }

  probe(): BitsetProbe {
    return {
      check: this.check,
      residentUsers: () => this.users.size,
      bytesFor: (userId) => {
        const entry = this.users.get(userId);
        return entry === undefined
          ? 0
          : entry.bits.byteLength + (entry.deadlines?.byteLength ?? 0);
      },
    };
  }

  private idOf(sku: string): number {
    let id = this.skuIds.get(sku);
    if (id === undefined) {
      id = this.skuIds.size;
      this.skuIds.set(sku, id);
    }
    return id;
  }
}

// `touched`, when present, records written users for end-of-transaction invalidation.
function wrapEntitlements(
  inner: EntitlementStore,
  cache: BitsetCache,
  clock: Clock,
  touched?: Set<string>,
): EntitlementStore {
  return {
    grant: async (userId, sku, attrs, options) => {
      await inner.grant(userId, sku, attrs, options);
      cache.invalidate(userId);
      touched?.add(userId);
    },
    revoke: async (userId, sku, options) => {
      await inner.revoke(userId, sku, options);
      cache.invalidate(userId);
      touched?.add(userId);
    },
    owns: async (userId, sku, options) => {
      const warm = cache.check(userId, sku, clock.now());
      if (warm !== null) {
        cache.touch(userId);
        return warm;
      }
      await cache.rebuild(userId, options);
      return cache.check(userId, sku, clock.now()) ?? false;
    },
    list: (userId, options) => inner.list(userId, options),
  };
}

/**
 * Wraps a store so `entitlements.owns` is served from the bitmap when warm: a warm hit is a
 * synchronous bit test, a cold or stale user refills once from `list()` and then answers from the
 * bitmap. Everything else on the store passes through untouched; `transaction` is wrapped only to
 * observe entitlement writes so their users can be invalidated when the transaction ends.
 *
 * The bitmap is never the source of truth. Every `grant` and `revoke` through this store
 * invalidates the written user (on commit and on rollback); a write from another process surfaces
 * within `ttlMs` (default 30 seconds) when the user's bitmap expires and refills. Resident users
 * are capped at `maxUsers` (default 10,000) with least-recently-used eviction. Single-process by
 * design, and expiry decisions match the store only when both share one clock, so pass the store's
 * `clock`.
 *
 * @example
 * const store = cachedEntitlements(baseStore, { clock, ttlMs: 30_000 });
 * await store.entitlements.owns('usr_42', 'sku_gold_trim'); // cold: fills from list()
 * await store.entitlements.owns('usr_42', 'sku_gold_trim'); // warm: a bit test, no store call
 */
export function cachedEntitlements(
  base: Store,
  options?: BitsetOptions,
): Store & { __bitset: BitsetProbe } {
  const clock = options?.clock ?? { now: () => Date.now() };
  const cache = new BitsetCache(
    base.entitlements,
    clock,
    options?.ttlMs ?? 30_000,
    options?.maxUsers ?? 10_000,
  );

  return {
    ...base,
    entitlements: wrapEntitlements(base.entitlements, cache, clock),
    transaction: async <T>(
      work: (unit: Unit) => Promise<T>,
      txOptions?: CallOptions,
    ): Promise<T> => {
      const touched = new Set<string>();
      try {
        return await base.transaction(
          (unit) =>
            work({
              ...unit,
              entitlements: wrapEntitlements(
                unit.entitlements,
                cache,
                clock,
                touched,
              ),
            }),
          txOptions,
        );
      } finally {
        // On commit AND on rollback: a concurrent miss may have refilled mid-transaction from
        // state this outcome contradicts (pre-commit rows on SQL, uncommitted rows on memory).
        for (const userId of touched) {
          cache.invalidate(userId);
        }
      }
    },
    __bitset: cache.probe(),
  };
}
