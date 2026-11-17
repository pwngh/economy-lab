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

import { add, toAmount, zero } from '#src/money.ts';
import { currency, walletKindOf } from '#src/accounts.ts';
import { balanceDelta } from '#src/ledger.ts';
import { holdReleaseLotFields, metaString } from '#src/meta.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { CheckedConfig, Config } from '#src/config.ts';
import type { Ledger, Lot, StoredLink } from '#src/ports.ts';

/**
 * The maturity config plus an optional AbortSignal passed through to the ledger's balance read.
 *
 * The config is a checked one: the horizons decide what a caller can cash out, and every reader
 * here is on a path a door already opened, so an unchecked config reaching one is a compile error
 * rather than a wrong maturity verdict.
 */
export type MaturityOptions = { config: CheckedConfig; signal?: AbortSignal };

/**
 * {@link MaturityOptions} plus the `amount` the matured balance must reach. A caller that already
 * has the balance can pass it as `live` to avoid re-reading it; the spend handler does, with the
 * balance read under the lock.
 */
export type MaturedAtLeastOptions = MaturityOptions & {
  amount: Amount;
  live?: Amount;
};

// Horizon lookup key for an unrecognized funding source. The 'default' horizon is configured
// independently through MATURITY_HORIZON_DEFAULT_MS. It coincides with the card horizon only under
// the shipped defaults, so an unknown source settles on its own conservative wait.
const DEFAULT_SOURCE: string = 'default';

/**
 * Returns the configured wait in milliseconds before credits from a funding source can be used.
 * Passing this wait does not prove settlement or rule out a later reversal. A source absent from
 * the config uses the 'default' horizon, then 'card', then zero if both are unset. Validated
 * configuration supplies these defaults; callers choose the waiting periods for their policy.
 */
export function maturityHorizonMs(source: string, config: Config): number {
  const horizons = config.maturityHorizonMs;
  const exact = horizons[source];
  if (exact !== undefined) {
    return exact;
  }
  return horizons[DEFAULT_SOURCE] ?? horizons.card ?? 0;
}

/**
 * Returns the moment in epoch milliseconds a lot matures: the top-up time plus the source's
 * required wait. The wait is computed from `source` rather than read from the lot's own
 * `maturesAt`, because a top-up may record the source without a maturity time. This depends on a
 * caller rule: any handler issuing spendable credits records the funding source on the posting (a
 * missing source falls back to the 'default' horizon, just less precisely).
 */
export function lotMaturesAt(lot: Lot, config: Config): number {
  return (
    lot.holdReleasedAt ?? lot.toppedUpAt + maturityHorizonMs(lot.source, config)
  );
}

/**
 * Reports whether a lot has matured as of `now`. The boundary is inclusive, so the lot is matured
 * the moment its wait elapses.
 */
export function isMatured(lot: Lot, now: number, config: Config): boolean {
  return lotMaturesAt(lot, config) <= now;
}

// Lots per bounded page. The newest lot or two usually cover the balance, so the common case is
// one round-trip. A wider tail just pulls the next page.
const TAIL_PAGE = 64;

// One slice of the FIFO tail: how much of the live balance a lot covers, whether that slice
// has matured by `now`, when it does, and the funding source that set its wait.
type TailSlice = {
  take: bigint;
  matured: boolean;
  maturesAt: number;
  source: string;
};

// Walks the newest lots first, a bounded page at a time, yielding each lot's slice of the FIFO
// tail until the live balance is covered. The boundary lot contributes only what is left to
// cover. A fully-included lot contributes its whole amount. The ledger pushes the `order desc
// limit/offset` down to the engine, so each page is bounded DB work. An empty page means the
// history ran out before the balance was covered. That is only possible if a balance row outran
// its lots, so the walk stops rather than loop forever. Both matured-balance reads consume this
// one walker, and each applies its own stop rule.
async function* tailSlices(
  ledger: Ledger,
  account: AccountRef,
  liveMinor: bigint,
  options: { now: number; config: Config },
): AsyncGenerator<TailSlice> {
  if (walletKindOf(account) === 'earned') {
    yield* earnedSlices(ledger, account, liveMinor, options);
    return;
  }
  let remaining = liveMinor;
  for (let offset = 0; remaining > 0n; offset += TAIL_PAGE) {
    let drained = 0;
    for await (const lot of ledger.timeline(account, {
      order: 'desc',
      limit: TAIL_PAGE,
      offset,
    })) {
      drained += 1;
      const take = lot.amount.minor < remaining ? lot.amount.minor : remaining;
      const maturesAt = lotMaturesAt(lot, options.config);
      yield {
        take,
        matured: maturesAt <= options.now,
        maturesAt,
        source: lot.source,
      };
      remaining -= take;
      if (remaining === 0n) {
        return;
      }
    }
    if (drained === 0) {
      return;
    }
  }
}

// Earned withdrawals consume matured lots, which need not be the oldest lots when funding
// sources have different horizons. Replaying these accounts preserves pending credit through
// holds and payouts. It deliberately replays full history; other accounts keep the bounded tail.
async function* earnedSlices(
  ledger: Ledger,
  account: AccountRef,
  liveMinor: bigint,
  options: { now: number; config: Config },
): AsyncGenerator<TailSlice> {
  const statement = await ledger.statement(account, {
    from: Number.MIN_SAFE_INTEGER,
    to: Number.MAX_SAFE_INTEGER,
  });
  const times = new Map(
    statement.entries.map((entry) => [entry.txnId, entry.postedAt]),
  );
  const lots: ReplayLot[] = [];
  for await (const link of ledger.lineage(account)) {
    const postedAt = times.get(link.txnId);
    if (postedAt === undefined) return; // Missing history cannot establish availability.
    const { incoming, outgoing } = entryAmounts(link, account);
    const source = metaString(link.meta, 'source', 'unknown');
    if (incoming > 0n) {
      const releasedAt = holdReleaseLotFields(
        account,
        link.meta,
      ).holdReleasedAt;
      lots.push({
        take: incoming,
        source,
        maturesAt:
          releasedAt ?? postedAt + maturityHorizonMs(source, options.config),
      });
    }
    if (!drainEarned(lots, outgoing, link.meta, postedAt)) return;
  }
  if (lots.reduce((sum, lot) => sum + lot.take, 0n) !== liveMinor) return;
  for (const lot of lots) {
    if (lot.take > 0n) yield { ...lot, matured: lot.maturesAt <= options.now };
  }
}

type ReplayLot = { take: bigint; maturesAt: number; source: string };
function entryAmounts(
  link: StoredLink,
  account: AccountRef,
): { incoming: bigint; outgoing: bigint } {
  let incoming = 0n;
  let outgoing = 0n;
  for (const leg of link.legs) {
    if (leg.account !== account) continue;
    const delta = balanceDelta(leg).minor;
    if (delta > 0n) incoming += delta;
    else outgoing -= delta;
  }
  return { incoming, outgoing };
}
function drainEarned(
  lots: ReplayLot[],
  outgoing: bigint,
  meta: Record<string, unknown>,
  postedAt: number,
): boolean {
  // Historical payouts have no eligibility timestamp and retain their legacy FIFO allocation.
  const maturedOnly =
    meta.kind === 'placeBalanceHold' ||
    (meta.kind === 'requestPayout' && typeof meta.maturityAt === 'number');
  const explicitAt =
    meta.kind === 'placeBalanceHold' ? meta.now : meta.maturityAt;
  const at =
    typeof explicitAt === 'number' && Number.isSafeInteger(explicitAt)
      ? explicitAt
      : postedAt;
  for (const lot of lots) {
    if (outgoing === 0n) break;
    if (maturedOnly && lot.maturesAt > at) continue;
    const take = outgoing < lot.take ? outgoing : lot.take;
    lot.take -= take;
    outgoing -= take;
  }
  // Missing history or a withdrawal with no eligible lots cannot establish availability.
  return outgoing === 0n;
}

/**
 * Returns when `amount` would be fully matured, assuming no further postings: the latest
 * matures-at among the earliest-maturing slices that cover it. Null when the live balance cannot cover
 * the amount at all, since maturity is not what blocks it then. Runs only on the
 * FUNDS_IMMATURE rejection path, so walking the whole tail is acceptable.
 */
export async function maturedAvailableAt(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturedAtLeastOptions,
): Promise<number | null> {
  const need = options.amount.minor;
  if (need <= 0n) {
    return now;
  }
  const live =
    options.live ?? (await ledger.balance(account, { signal: options.signal }));
  if (live.minor < need) {
    return null;
  }
  const slices: Array<{ take: bigint; maturesAt: number }> = [];
  for await (const slice of tailSlices(ledger, account, live.minor, {
    now,
    config: options.config,
  })) {
    slices.push(slice);
  }
  slices.sort((a, b) => a.maturesAt - b.maturesAt);
  let covered = 0n;
  for (const slice of slices) {
    covered += slice.take;
    if (covered >= need) {
      return slice.maturesAt;
    }
  }
  return null;
}

/**
 * Returns the lot that blocks an immature draw: the binding slice of the same walk as
 * {@link maturedAvailableAt}, with the funding source that set its wait. When the walk cannot
 * name a binding lot (a balance row that outran its lots), the answer falls back to the
 * 'default' horizon from `now` — the module's conservative rule for unknown funding.
 */
export async function maturityBlocker(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturedAtLeastOptions,
): Promise<{ source: string; availableAt: number }> {
  const need = options.amount.minor;
  const fallback = {
    source: DEFAULT_SOURCE,
    availableAt: now + maturityHorizonMs(DEFAULT_SOURCE, options.config),
  };
  if (need <= 0n) {
    return { source: DEFAULT_SOURCE, availableAt: now };
  }
  const live =
    options.live ?? (await ledger.balance(account, { signal: options.signal }));
  if (live.minor < need) {
    return fallback;
  }
  const slices: TailSlice[] = [];
  for await (const slice of tailSlices(ledger, account, live.minor, {
    now,
    config: options.config,
  })) {
    slices.push(slice);
  }
  slices.sort((a, b) => a.maturesAt - b.maturesAt);
  let covered = 0n;
  for (const slice of slices) {
    covered += slice.take;
    if (covered >= need) {
      return { source: slice.source, availableAt: slice.maturesAt };
    }
  }
  return fallback;
}

/**
 * Returns the matured part of an account's balance as of `now`. Earned accounts replay their
 * history to preserve pending lots through mature-only withdrawals. Other accounts read the
 * newest-first FIFO tail and stop once it covers the live balance; their differential oracle
 * is {@link maturedBalanceFullScan}.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/ Credit maturity}
 * for the dated-lot model, the FIFO tail, and why only the matured run may be drawn.
 */
export async function maturedBalance(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  const live = await ledger.balance(account, { signal: options.signal });
  const unit = currency(account);

  if (live.minor <= 0n) {
    return zero(unit);
  }

  let matured = 0n;
  for await (const slice of tailSlices(ledger, account, live.minor, {
    now,
    config: options.config,
  })) {
    if (slice.matured) {
      matured += slice.take;
    }
  }
  return toAmount(unit, matured);
}

/**
 * Reports whether an account has at least `amount` of matured balance as of `now`, short-circuiting
 * once the matured running sum reaches `amount`. Equals `maturedBalance(...).minor >= amount.minor`
 * but stops summing once the request is covered. Earned accounts first replay their full
 * history; other accounts use the bounded FIFO tail. A non-positive `amount` is covered.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/ Credit maturity}
 *   for the dated-lot model behind the running sum.
 */
export async function maturedAtLeast(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturedAtLeastOptions,
): Promise<boolean> {
  const need = options.amount.minor;
  if (need <= 0n) {
    return true;
  }
  const live =
    options.live ?? (await ledger.balance(account, { signal: options.signal }));
  if (live.minor <= 0n) {
    return false;
  }

  // This is the same walk as maturedBalance, but the running sum stops the walk the moment it
  // covers `need`. Returning ends the generator, so no further page is read.
  let matured = 0n;
  for await (const slice of tailSlices(ledger, account, live.minor, {
    now,
    config: options.config,
  })) {
    if (slice.matured) {
      matured += slice.take;
      if (matured >= need) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Full-history oracle for the bounded FIFO calculation on non-earned accounts. Earned
 * accounts already use a full replay, so they share that implementation; the holds suite
 * checks earned allocations against an independent state-machine model instead.
 */
export async function maturedBalanceFullScan(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  if (walletKindOf(account) === 'earned') {
    return maturedBalance(ledger, account, now, options);
  }
  const live = await ledger.balance(account, { signal: options.signal });
  const unit = currency(account);
  if (live.minor <= 0n) {
    return zero(unit);
  }

  const lots = await collectLots(ledger, account, options.config);
  const tail = fifoTail(lots, live.minor);
  return sumMatured(tail, now, unit);
}

/**
 * Returns the part of an account's balance still in its settlement wait as of `now`. The matured
 * and still-waiting amounts sum to the current balance.
 */
export async function immatureBalance(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  const live = await ledger.balance(account, { signal: options.signal });
  const matured = await maturedBalance(ledger, account, now, options);
  return toAmount(currency(account), live.minor - matured.minor);
}

// --- Which lots are left, then which have matured --------------------

type Settled = { minor: bigint; maturesAt: number };

// Reads every lot for the account, oldest first. The ledger only turns balance-increasing entries
// into lots, so each amount is positive.
async function collectLots(
  ledger: Ledger,
  account: AccountRef,
  config: Config,
): Promise<Settled[]> {
  const lots: Settled[] = [];
  for await (const lot of ledger.timeline(account)) {
    lots.push({
      minor: lot.amount.minor,
      maturesAt: lotMaturesAt(lot, config),
    });
  }
  return lots;
}

// Returns the most recent run of lots summing to the current balance. Spends drain oldest-first, so
// spent = (sum of all lots) - (current balance). The walk goes oldest-first and skips the spent
// amount, splitting the lot that spending stopped partway through, then keeps the rest.
function fifoTail(
  lots: ReadonlyArray<Settled>,
  balanceMinor: bigint,
): Settled[] {
  const total = lots.reduce((sum, lot) => sum + lot.minor, 0n);
  let toDrain = total - balanceMinor;
  if (toDrain <= 0n) {
    return [...lots];
  }
  const tail: Settled[] = [];
  for (const lot of lots) {
    if (toDrain <= 0n) {
      tail.push(lot);
      continue;
    }
    if (toDrain >= lot.minor) {
      toDrain -= lot.minor;
      continue;
    }
    tail.push({ minor: lot.minor - toDrain, maturesAt: lot.maturesAt });
    toDrain = 0n;
  }
  return tail;
}

function sumMatured(
  tail: ReadonlyArray<Settled>,
  now: number,
  unit: Amount['currency'],
): Amount {
  let matured = zero(unit);
  for (const lot of tail) {
    if (lot.maturesAt <= now) {
      matured = add(matured, toAmount(unit, lot.minor));
    }
  }
  return matured;
}
