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
 * Bridges the web UI and the economy-lab engine. The `.server` suffix keeps this module (and the
 * db/crypto it imports) off the client. State lives in one long-lived server-side singleton; the
 * store comes from DATABASE_URL — in-memory by default, Postgres/MySQL when set.
 */

import {
  createEconomy,
  createWorker,
  capabilitiesFromEnv,
  workerCtxFrom,
  spendable,
  earned,
  promo,
  SYSTEM,
} from '#src/index.ts';
import { systemSigner, jsonlLogger, systemDigest } from '#src/runtime.ts';
import { flatFee } from '#src/pricing.ts';
import { currency, isWalletAccount, ownerOf } from '#src/accounts.ts';
import { fault, ERROR_CODES } from '#src/errors.ts';
import { configuredRates } from '#src/adapters/rates.ts';

import type {
  Economy,
  Operation,
  Outcome,
  ProveReport,
  Capabilities,
  WorkerCtx,
} from '#src/index.ts';
import type { Clock, Ids, Digest, Leg, Posting, Saga } from '#src/ports.ts';
import type { Worker } from '#src/worker/index.ts';

import {
  LABELS,
  PLATFORM_ACCOUNTS,
  humanReason,
  humanizeKind,
  credits,
  toCredits,
  accountLabel,
} from '~/views.server';
import { DAY_MS, makeClock, demoEnv } from '~/demo.server';

import type {
  TxnKind,
  LegView,
  TxnView,
  WalletView,
  ProveView,
  SolvencyView,
  PlatformAccountView,
  PayoutView,
  SimSettings,
} from '~/views.server';

// Re-export the view shapes so route modules keep importing them from `~/economy.server`.
export type {
  TxnKind,
  LegView,
  TxnView,
  WalletView,
  ProveView,
  SolvencyView,
  PlatformAccountView,
  PayoutView,
  SimSettings,
} from '~/views.server';

// A page request from a route loader. The facade clamps `offset` and `limit`, so a route can pass
// a raw `?page=` straight through without sanitizing it.
export interface PageReq {
  offset: number;
  limit: number;
}

// One bounded page of a heavy list: at most `limit` rows, plus the full `total` for the pager.
export interface Page<T> {
  rows: T[];
  total: number;
  offset: number;
  limit: number;
}

// The ceiling bounds what a single loader can pull, even when a hand-edited URL asks for more.
export const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// Negative or non-finite inputs collapse to the first page at the default size; an oversized limit
// caps at MAX_PAGE_SIZE.
export function clampPage(req: Partial<PageReq> | undefined): PageReq {
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(req?.limit ?? PAGE_SIZE)) || PAGE_SIZE),
  );
  const offset = Math.max(0, Math.floor(Number(req?.offset ?? 0)) || 0);
  return { offset, limit };
}

// Per-state tallies for the board's column headers — the paged card list alone cannot count columns.
export interface PayoutCounts {
  RESERVED: number;
  SUBMITTED: number;
  SETTLED: number;
  FAILED: number;
}

// --- the console facade ------------------------------------------------------------

export interface ConsoleEngine {
  deposit(input: { userId: string; credits: number }): Promise<Outcome>;
  purchase(input: {
    buyerId: string;
    sellerId: string;
    listing: string;
    credits: number;
  }): Promise<Outcome>;
  requestPayout(input: { userId: string; credits: number }): Promise<Outcome>;
  grantPromo(input: { userId: string; credits: number }): Promise<Outcome>;

  // Heavy lists are read one bounded page at a time.
  wallets(page?: Partial<PageReq>): Promise<Page<WalletView>>;
  // One user's wallet, read directly, so the detail panel can show a user who isn't on the current
  // page. Null when the user holds no wallet account.
  wallet(userId: string): Promise<WalletView | null>;
  ledger(page?: Partial<PageReq>): Promise<Page<TxnView>>;
  payouts(page?: Partial<PageReq>): Promise<Page<PayoutView>>;
  payoutCounts(): Promise<PayoutCounts>;
  prove(): Promise<ProveView>;
  solvency(): Promise<SolvencyView>;
  platformAccounts(): Promise<PlatformAccountView[]>;

  advanceTime(ms: number): void;
  now(): number;

  settings(): SimSettings;
  setFault(on: boolean): void;
  setMaturityDays(days: number): Promise<void>;
  setMaxAttempts(n: number): Promise<void>;

  reset(): Promise<void>; // rebuild engine + re-seed the demo (re-seeds the configured store)
  clear(): Promise<void>; // rebuild engine, empty, no seed (removes all users)
  runJobs(): Promise<string>;
}

async function build(): Promise<ConsoleEngine> {
  const clock = makeClock();

  let economy: Economy;
  let workerRef: Worker;
  let workerCtx: WorkerCtx;

  let faultMode = false;
  let maturityDays = 0;
  let maxAttempts = 5;
  let idSeq = 0;

  // Memoized solvency snapshot: the most expensive read (every user's balances plus a full
  // prove()), and the page frame asks for it on every navigation. Cached for a short TTL and
  // cleared on every mutation, so the figure is never stale across a change the user made.
  let solvencyCache: { at: number; value: SolvencyView } | null = null;
  const SOLVENCY_TTL_MS = 5_000;
  function invalidateSolvency(): void {
    solvencyCache = null;
  }

  const digest: Digest = systemDigest();

  // Deterministic sequential ids (txn_1, pay_2, …) so the demo replays identically; the default
  // uuidIds() would be random. idSeq resets to zero on rebuild.
  const ids: Ids = {
    next: (prefix) => `${prefix}_${++idSeq}`,
  };

  // Stand-in payment provider (Tilia) with an outage switch: while faultMode is on, every submit
  // throws a retryable failure. The switch is read live, so a flip takes effect on the next run.
  const processor = {
    submitPayout: async (input: { key: string }) => {
      if (faultMode) {
        throw fault(ERROR_CODES.PROVIDER_FAILURE, 'Tilia is unavailable.', {
          retryable: true,
        });
      }
      return { providerRef: `tilia_${input.key}` };
    },
  };

  // Dual-rate on purpose, not a 1:1 placeholder: buy is what a user pays per credit, par is the
  // redemption/settlement rate, and payout settles at par. The buy-vs-par gap is the platform
  // spread.
  const rates = configuredRates({
    buyRate: 8333n,
    buyScale: 6,
    parRate: 5n,
    parScale: 3,
    payoutRate: 5n,
    payoutScale: 3,
  });

  // The key the engine uses to sign ledger checkpoints (a fixed demo key — never a real secret).
  const signer = systemSigner({
    signingKey: '00112233445566778899aabbccddeeff',
  });

  // Discards output so the demo's injected faults don't flood the dev terminal.
  const logger = jsonlLogger({ out: () => {}, err: () => {} });
  // Discard metrics sink, hand-rolled — there is no Meter counterpart to jsonlLogger.
  const meter = { count: () => {}, observe: () => {} };

  // Build (or rebuild) the engine + worker over one env-selected store — two separate selections
  // would leave the worker blind to the economy's in-memory state. workerCtxFrom(caps) shares the
  // config object, which setMaturityDays/setMaxAttempts rely on (below).
  async function rebuild(): Promise<void> {
    idSeq = 0;
    clock.set(0);

    const caps: Capabilities = await capabilitiesFromEnv(
      demoEnv(maturityDays, maxAttempts),
      { signer, processor, rates, pricing: flatFee() },
      { clock, ids, digest, logger, meter },
    );
    economy = createEconomy(caps);
    workerCtx = workerCtxFrom(caps);
    workerRef = createWorker(caps.store, workerCtx);
  }

  // User ids derived live from read.accounts() via isWalletAccount/ownerOf, so the account-id
  // shape is never re-encoded here.
  async function userIds(): Promise<string[]> {
    const ids = new Set<string>();
    for await (const account of economy.read.accounts()) {
      if (isWalletAccount(account)) {
        ids.add(ownerOf(account));
      }
    }
    return [...ids];
  }

  // Posting legs -> render-ready leg views. Debit is the positive-minor side.
  function toLegViews(legs: ReadonlyArray<Leg>): LegView[] {
    return legs.map((leg: Leg): LegView => {
      const value = toCredits(leg.amount);
      return {
        account: leg.account,
        label: accountLabel(leg.account),
        side: leg.amount.minor > 0n ? 'debit' : 'credit',
        amount: `${value >= 0 ? '+' : ''}${value.toFixed(2)}`,
        currency: currency(leg.account),
      };
    });
  }

  // Sum of a posting's legs in minor units; 0 means it balances.
  function balanceOf(legs: ReadonlyArray<Leg>): number {
    return legs.reduce((sum, leg) => sum + Number(leg.amount.minor), 0);
  }

  // The first user account a posting touches (not a "platform:" one), so a worker posting can name
  // the user it concerns. Null if none.
  function userInLegs(legs: ReadonlyArray<Leg>): string | null {
    for (const leg of legs) {
      if (!leg.account.startsWith('platform:')) {
        const colon = leg.account.lastIndexOf(':');
        return colon >= 0 ? leg.account.slice(0, colon) : leg.account;
      }
    }
    return null;
  }

  // Build a feed row from a stored posting — user operation or worker posting alike — plus a
  // plain-English note where the legs don't explain themselves.
  async function viewFromPosting(id: string, p: Posting): Promise<TxnView> {
    const meta = p.meta as { kind?: string; sagaId?: string; reason?: string };
    const metaKind = String(meta.kind ?? '');
    const first = p.legs[0];
    const amount = first ? Math.abs(toCredits(first.amount)) : 0;
    const priceCurrency =
      first && currency(first.account) === 'USD' ? 'USD' : 'CREDIT';
    const sagaId = meta.sagaId ? String(meta.sagaId) : undefined;
    const sagaUser = sagaId ? (await economy.read.saga(sagaId))?.userId : null;
    const user = sagaUser ?? userInLegs(p.legs) ?? 'user';
    const money = amount.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const cr = `${money} Cr`;

    const base = {
      id,
      at: clock.now(),
      paymentType: 'Tilia',
      priceCredits: amount,
      priceCurrency: priceCurrency as 'CREDIT' | 'USD',
      buyer: 'Platform',
      seller: user,
      legs: toLegViews(p.legs),
      balancedTo: balanceOf(p.legs),
      sagaId,
    };

    // User operations render from legs + meta the same way worker postings do. Display niceties
    // not on the immutable posting (a listing name, buyer/seller labels) are derived from what the
    // legs imply.
    if (metaKind === 'topUp') {
      return {
        ...base,
        kind: 'topUp',
        label: LABELS.topUp,
        paymentType: 'Card',
        listing: 'Credit top-up',
        buyer: user,
        seller: 'Platform',
      };
    }
    if (metaKind === 'spend') {
      return {
        ...base,
        kind: 'spend',
        label: LABELS.spend,
        paymentType: 'Credits',
        listing: 'Marketplace purchase',
        buyer: userInLegs(p.legs) ?? 'user',
        seller: user,
      };
    }
    if (metaKind === 'requestPayout') {
      return {
        ...base,
        kind: 'requestPayout',
        label: LABELS.requestPayout,
        paymentType: 'Tilia',
        listing: 'Payout to Tilia',
        buyer: 'Platform',
        seller: user,
      };
    }
    if (metaKind === 'grantPromo') {
      return {
        ...base,
        kind: 'grantPromo',
        label: LABELS.grantPromo,
        paymentType: 'Promotion',
        listing: 'Promotional credits',
        buyer: user,
        seller: 'Platform',
      };
    }

    if (metaKind === 'payouts.dead_letter') {
      const reason = humanReason(String(meta.reason ?? ''));
      return {
        ...base,
        kind: 'payoutReversed',
        label: LABELS.payoutReversed,
        listing: 'Reserve returned to seller',
        note: `Tilia payout failed (${reason}) after the retry cap. The ${cr} reserve was returned to ${user}'s earned balance — nothing is stranded.`,
      };
    }
    if (metaKind === 'settlePayout') {
      return {
        ...base,
        kind: 'payoutSettled',
        label: LABELS.payoutSettled,
        listing: `Settled to ${user}`,
        note: `Payout to ${user} settled — the ${cr} reserve was released to platform revenue.`,
      };
    }
    // USD companion of a settlement: the cash leg that pays the seller out of trust, rendered as
    // its own feed row. The board's "paid" caption reads the saga's payoutUsd field, not this
    // branch.
    if (metaKind === 'settlePayout.cash') {
      return {
        ...base,
        kind: 'payoutCash',
        label: LABELS.payoutCash,
        listing: `Cash to ${user}`,
        note: `$${money} was paid out to ${user} from trust cash.`,
      };
    }
    if (metaKind === 'treasury.fee_sweep') {
      return {
        ...base,
        kind: 'feeSweep',
        label: LABELS.feeSweep,
        listing: 'Marketplace fees to treasury',
        seller: 'platform',
        paymentType: 'System',
        note: `The platform swept ${cr} of accumulated marketplace fees out of revenue into its own treasury.`,
      };
    }
    if (metaKind === 'promos.expiry') {
      return {
        ...base,
        kind: 'promoExpiry',
        label: LABELS.promoExpiry,
        listing: 'Unspent promo reclaimed',
        paymentType: 'Promotion',
        note: `${cr} of expired promotional credits was reclaimed from ${user}.`,
      };
    }
    // Any other worker posting: surfaced with a humanized title and a system-side note, since these
    // move platform money between platform accounts.
    const title = humanizeKind(metaKind);
    return {
      ...base,
      kind: 'other',
      label: title,
      listing: title,
      seller: userInLegs(p.legs) ?? 'platform',
      paymentType: 'System',
      note: `Background ledger posting${metaKind ? ` (${metaKind})` : ''}.`,
    };
  }

  let opSeq = 0;
  function key(prefix: string): string {
    return `${prefix}_${++opSeq}`;
  }

  async function submit(op: Operation): Promise<Outcome> {
    const outcome = await economy.submit(op);
    // Any committed operation changes balances, so the cached solvency figure is now stale.
    invalidateSolvency();
    return outcome;
  }

  async function runWorkerOnce(): Promise<{
    batch: Record<string, { ok: boolean; summary?: unknown }>;
  }> {
    const run = await workerRef.runOnce({
      now: clock.now(),
      limit: 100,
      dispatcher: undefined,
      feed: {
        pull: async () => {
          throw new Error('no reconcile feed in the console');
        },
      },
      windows: [],
    });
    return {
      batch: run.batch as unknown as Record<
        string,
        { ok: boolean; summary?: unknown }
      >,
    };
  }

  // Seed an economy that has already run a bit, so the first load shows the full lifecycle: user
  // operations, worker postings, and settled/failed/in-flight payouts.
  async function seed(): Promise<void> {
    // Everyday operations; the purchases leave nova and pixel with earned credits to cash out.
    await api.deposit({ userId: 'usr_alice', credits: 5000 });
    await api.deposit({ userId: 'usr_bjorn', credits: 3000 });
    await api.grantPromo({ userId: 'usr_alice', credits: 500 }); // alice spends hers below
    await api.grantPromo({ userId: 'usr_pixel', credits: 600 }); // a seller incentive, left unspent
    await api.purchase({
      buyerId: 'usr_alice',
      sellerId: 'usr_nova',
      listing: 'Aurora Avatar',
      credits: 2000,
    });
    await api.purchase({
      buyerId: 'usr_bjorn',
      sellerId: 'usr_nova',
      listing: 'Skyline World Pass',
      credits: 1200,
    });
    await api.purchase({
      buyerId: 'usr_alice',
      sellerId: 'usr_pixel',
      listing: 'Wave Emote Pack',
      credits: 450,
    });

    // A seller's current earned balance, in credits — so a payout request never exceeds it.
    const earnedOf = async (userId: string) =>
      toCredits(await economy.read.balance(earned(userId)));
    const fraction = async (userId: string, f: number) =>
      Math.max(1, Math.floor((await earnedOf(userId)) * f));

    // Two payouts that settle fully: the worker advances RESERVED → SUBMITTED on the first run and
    // SUBMITTED → SETTLED a day later.
    await api.requestPayout({
      userId: 'usr_nova',
      credits: await fraction('usr_nova', 0.35),
    });
    await api.requestPayout({
      userId: 'usr_pixel',
      credits: await fraction('usr_pixel', 0.6),
    });
    await api.runJobs();
    api.advanceTime(DAY_MS);
    await api.runJobs();

    // A payout that fails: provider down, retry cap 1, so the next run abandons it and reverses the
    // reserve back to nova's earned balance.
    api.setFault(true);
    await api.setMaxAttempts(1);
    await api.requestPayout({
      userId: 'usr_nova',
      credits: await fraction('usr_nova', 0.3),
    });
    api.advanceTime(DAY_MS);
    await api.runJobs();
    api.setFault(false);
    await api.setMaxAttempts(5);

    // One more left mid-flight (RESERVED) so the board isn't all terminal.
    await api.requestPayout({
      userId: 'usr_nova',
      credits: await fraction('usr_nova', 0.3),
    });
  }

  const api: ConsoleEngine = {
    deposit: ({ userId, credits: amount }) =>
      submit({
        kind: 'topUp',
        idempotencyKey: key('idem'),
        actor: { kind: 'system', service: 'console' },
        source: 'card',
        userId,
        amount: credits(amount),
      } as Operation),

    purchase: ({ buyerId, sellerId, listing, credits: price }) =>
      submit({
        kind: 'spend',
        idempotencyKey: key('idem'),
        actor: { kind: 'user', userId: buyerId },
        buyerId,
        sku: listing,
        price: credits(price),
        recipients: [{ sellerId, shareBps: 10_000 }],
        orderId: key('ord'),
      } as Operation),

    requestPayout: ({ userId, credits: amount }) =>
      submit({
        kind: 'requestPayout',
        idempotencyKey: key('idem'),
        actor: { kind: 'user', userId },
        userId,
        amount: credits(amount),
      } as Operation),

    grantPromo: ({ userId, credits: amount }) =>
      submit({
        kind: 'grantPromo',
        idempotencyKey: key('idem'),
        actor: { kind: 'system', service: 'marketing' },
        userId,
        amount: credits(amount),
        expiresAt: clock.now() + 30 * 24 * 60 * 60_000,
      } as Operation),

    // Ordered by user id: paging stays stable, and sorting needs no balance reads — only the
    // page's users get their three balances read.
    wallets: async (req) => {
      const { offset, limit } = clampPage(req);
      const ids = (await userIds()).sort();
      const slice = ids.slice(offset, offset + limit);
      const rows: WalletView[] = [];
      for (const userId of slice) {
        const p = toCredits(await economy.read.balance(spendable(userId)));
        const e = toCredits(await economy.read.balance(earned(userId)));
        const m = toCredits(await economy.read.balance(promo(userId)));
        rows.push({
          userId,
          purchased: p,
          earned: e,
          promotional: m,
          total: p + e + m,
        });
      }
      return { rows, total: ids.length, offset, limit };
    },

    // Null for an unknown user, so the detail panel never shows a phantom all-zero wallet.
    wallet: async (userId) => {
      const p = toCredits(await economy.read.balance(spendable(userId)));
      const e = toCredits(await economy.read.balance(earned(userId)));
      const m = toCredits(await economy.read.balance(promo(userId)));
      const total = p + e + m;
      const exists = await userIds().then((ids) => ids.includes(userId));
      if (!exists) {
        return null;
      }
      return { userId, purchased: p, earned: e, promotional: m, total };
    },

    // Newest first, streamed from the engine's posting log: views are built only for the page
    // window, the rest of the pass just counts toward `total`. Reading the log (not a side feed)
    // is why a direct-to-DB write — e.g. the bench's — shows up here.
    ledger: async (req) => {
      const { offset, limit } = clampPage(req);
      const rows: TxnView[] = [];
      let total = 0;
      for await (const posting of economy.read.postings()) {
        const index = total++;
        if (index < offset || rows.length >= limit) {
          continue;
        }
        rows.push(await viewFromPosting(posting.txnId, posting));
      }
      return { rows, total, offset, limit };
    },

    // Newest first, streamed from the saga list; views are built only for the page window. The
    // terminal captions (failure reason / USD paid) come from the saga's own terminal-outcome
    // fields, not a posting-meta side channel.
    payouts: async (req) => {
      const { offset, limit } = clampPage(req);
      const rows: PayoutView[] = [];
      let total = 0;
      for await (const saga of economy.read.payouts()) {
        const index = total++;
        if (index < offset || rows.length >= limit) {
          continue;
        }
        rows.push({
          id: saga.id,
          userId: saga.userId,
          reserveCredits: toCredits(saga.reserve),
          state: saga.state,
          providerRef: saga.providerRef,
          attempts: saga.attempts,
          dueAt: saga.dueAt,
          // toCredits is minor-units / scale, so it renders the USD Amount to dollars too.
          reason: saga.reason === null ? null : humanReason(saga.reason),
          payoutUsd: saga.payoutUsd === null ? null : toCredits(saga.payoutUsd),
        });
      }
      return { rows, total, offset, limit };
    },

    // REQUESTED folds into RESERVED to match the board's columns (requestPayout opens directly in
    // RESERVED).
    payoutCounts: async () => {
      const counts: PayoutCounts = {
        RESERVED: 0,
        SUBMITTED: 0,
        SETTLED: 0,
        FAILED: 0,
      };
      for await (const saga of economy.read.payouts()) {
        switch (saga.state) {
          case 'REQUESTED':
          case 'RESERVED':
            counts.RESERVED++;
            break;
          case 'SUBMITTED':
            counts.SUBMITTED++;
            break;
          case 'SETTLED':
            counts.SETTLED++;
            break;
          case 'FAILED':
            counts.FAILED++;
            break;
        }
      }
      return counts;
    },

    prove: async () => {
      const r: ProveReport = await economy.read.prove();
      const allGreen =
        r.conserved &&
        r.backed &&
        r.noOverdraft &&
        r.chainIntact &&
        r.consistent;
      return {
        conserved: r.conserved,
        backed: r.backed,
        noOverdraft: r.noOverdraft,
        chainIntact: r.chainIntact,
        consistent: r.consistent,
        shortfallUsd: toCredits(r.shortfall),
        driftCount: r.drift.length,
        allGreen,
      };
    },

    solvency: async () => {
      const now = clock.now();
      if (solvencyCache && now - solvencyCache.at < SOLVENCY_TTL_MS) {
        return solvencyCache.value;
      }
      let purchased = 0;
      let earnedTotal = 0;
      let promotional = 0;
      for (const userId of await userIds()) {
        purchased += toCredits(await economy.read.balance(spendable(userId)));
        earnedTotal += toCredits(await economy.read.balance(earned(userId)));
        promotional += toCredits(await economy.read.balance(promo(userId)));
      }
      const r = await economy.read.prove();
      const trustCash = await economy.read.balance(SYSTEM.TRUST_CASH);
      const value: SolvencyView = {
        userCredits: purchased + earnedTotal + promotional,
        backed: r.backed,
        shortfallUsd: toCredits(r.shortfall),
        trustCashUsd: toCredits(trustCash),
        purchased,
        earned: earnedTotal,
        promotional,
      };
      solvencyCache = { at: now, value };
      return value;
    },

    // Shown as magnitudes — the Overview reads "how much sits in each account", not signed
    // balances.
    platformAccounts: async () => {
      const out: PlatformAccountView[] = [];
      for (const a of PLATFORM_ACCOUNTS) {
        const bal = await economy.read.balance(a.account);
        out.push({
          key: a.key,
          label: a.label,
          sublabel: a.sublabel,
          value: Math.abs(toCredits(bal)),
          currency: currency(a.account) === 'USD' ? 'USD' : 'CREDIT',
        });
      }
      return out;
    },

    advanceTime: (ms) => {
      clock.advance(ms);
      // Maturity and the backing check are time-sensitive, and the cache is keyed on the clock, so
      // drop it after a jump rather than trust a snapshot taken at an earlier time.
      invalidateSolvency();
    },
    now: () => clock.now(),

    settings: () => ({
      faultMode,
      maturityHorizonDays: maturityDays,
      maxPayoutAttempts: maxAttempts,
      now: clock.now(),
    }),

    setFault: (on) => {
      faultMode = on;
    },

    // createEconomy snapshots config at construction, but the engine and worker hold the config
    // object by reference, so we mutate it in place; the change takes effect on the next submit or
    // worker run, without a rebuild that would lose saga state.
    setMaturityDays: async (days) => {
      maturityDays = Math.max(0, Math.round(days));
      workerCtx.config.maturityHorizonMs = {
        card: 0,
        crypto: 0,
        default: maturityDays * DAY_MS,
      };
    },

    setMaxAttempts: async (n) => {
      maxAttempts = Math.max(1, Math.round(n));
      workerCtx.config.maxPayoutAttempts = maxAttempts;
    },

    reset: async () => {
      faultMode = false;
      maturityDays = 0;
      maxAttempts = 5;
      opSeq = 0;
      invalidateSolvency();
      await rebuild();
      await seed();
    },

    clear: async () => {
      faultMode = false;
      maturityDays = 0;
      maxAttempts = 5;
      opSeq = 0;
      invalidateSolvency();
      await rebuild();
    },

    runJobs: async () => {
      const { batch } = await runWorkerOnce();
      // Worker postings move money, so the cached solvency figure is stale.
      invalidateSolvency();
      const notes: string[] = [];
      for (const [name, result] of Object.entries(batch)) {
        if (!result.ok) {
          notes.push(`${name}: error`);
          continue;
        }
        const summary = result.summary as Record<string, unknown>;
        const acted = Object.values(summary)
          .filter(Array.isArray)
          .reduce((sum, arr) => sum + (arr as unknown[]).length, 0);
        if (acted > 0) {
          notes.push(`${name} ${acted}`);
        }
      }
      return notes.length ? notes.join(' · ') : 'no due items';
    },
  };

  await rebuild();
  await seed();
  return api;
}

// --- module singleton ---

// Built once per server process and reused across requests, so state survives a browser refresh.
// The globalThis slot keeps the instance across Vite dev hot-reloads, so HMR doesn't re-seed.
declare global {
  // eslint-disable-next-line no-var
  var __economyConsole: Promise<ConsoleEngine> | undefined;
}

export function getEconomy(): Promise<ConsoleEngine> {
  if (!globalThis.__economyConsole) {
    globalThis.__economyConsole = build();
  }
  return globalThis.__economyConsole;
}
