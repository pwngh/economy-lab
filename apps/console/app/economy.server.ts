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
 * economy.server.ts — bridges the web UI and the economy-lab engine.
 *
 * The `.server` suffix keeps this module (and the db/crypto it imports) off the client: the engine
 * runs on the Node server. Loaders read through the facade below; actions call the mutating ones.
 *
 * Two things to know:
 *  - State lives in one long-lived server-side singleton, so a browser refresh keeps it. Reset
 *    rebuilds and re-seeds; clear rebuilds empty.
 *  - The store comes from DATABASE_URL: in-memory by default, Postgres/MySQL when set (same engine,
 *    real adapters, survives restarts). The db driver is imported only when that var is set.
 */

// The economy and worker share one store: capabilitiesFromEnv() selects it once from env, then
// createEconomy + createWorker(caps.store, workerCtxFrom(caps)) wire both halves over it. In a
// single process, two separate compose()/composeWorker() calls would each select their own store,
// leaving the worker blind to the economy's in-memory state.
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

// A page request from a route loader. `offset` and `limit` are clamped inside the facade, so a
// route can pass a raw `?page=` straight through without sanitizing it — the facade never reads or
// renders more than `limit` rows regardless of what the URL asks for.
export interface PageReq {
  offset: number;
  limit: number;
}

// One bounded page of a heavy list. `rows` holds at most `limit` items; `total` is the full count
// behind the list (for the "N of M" caption and the pager), and `offset` echoes where this page
// starts. The DOM only ever holds `rows.length` rows, so render cost is independent of `total`.
export interface Page<T> {
  rows: T[];
  total: number;
  offset: number;
  limit: number;
}

// The default and ceiling page sizes. The ceiling caps how much a single loader can ever pull into
// memory or the DOM, even if a hand-edited `?size=` asks for more.
export const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// Clamp a raw page request to a sane, bounded window. Negative or non-finite inputs collapse to the
// first page at the default size; an oversized limit is capped at MAX_PAGE_SIZE.
export function clampPage(req: Partial<PageReq> | undefined): PageReq {
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(req?.limit ?? PAGE_SIZE)) || PAGE_SIZE),
  );
  const offset = Math.max(0, Math.floor(Number(req?.offset ?? 0)) || 0);
  return { offset, limit };
}

// Per-state tallies for the payout board, so the kanban can show accurate column counts and a
// bounded slice of cards without materializing every saga as a view object.
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

  // Heavy lists are read one bounded page at a time. Each takes an optional page request and
  // returns a Page whose `rows` never exceed the (clamped) limit, plus the full `total` for the
  // pager — so a loader holds a fixed number of rows no matter how many users/postings/payouts
  // exist.
  wallets(page?: Partial<PageReq>): Promise<Page<WalletView>>;
  // One user's wallet, read directly (three balance reads). Lets the accounts detail panel show a
  // user who isn't on the current page, without scanning every wallet to find them. Null when the
  // user holds no wallet account.
  wallet(userId: string): Promise<WalletView | null>;
  ledger(page?: Partial<PageReq>): Promise<Page<TxnView>>;
  payouts(page?: Partial<PageReq>): Promise<Page<PayoutView>>;
  // Per-state payout tallies for the board's column headers, counted in one streaming pass without
  // materializing the sagas.
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

  // Memoized solvency snapshot. solvency() sums a balance across every user and runs a full
  // prove(), so it's the most expensive read — and _chrome.tsx calls it on *every* page
  // navigation. It is computed at most once per short TTL and cleared whenever the economy
  // mutates (any submit, worker run, time advance, reset/clear), so the figure stays exact while
  // costing O(1) on the common navigation path.
  let solvencyCache: { at: number; value: SolvencyView } | null = null;
  const SOLVENCY_TTL_MS = 5_000;
  function invalidateSolvency(): void {
    solvencyCache = null;
  }

  // The engine's default SHA-256 hasher (Web Crypto), reused so the console hashes as the engine does.
  const digest: Digest = systemDigest();

  // Deterministic sequential ids (txn_1, pay_2, …) so the demo replays identically; the default
  // uuidIds() would be random. idSeq resets to zero on rebuild.
  const ids: Ids = {
    next: (prefix) => `${prefix}_${++idSeq}`,
  };

  // Stand-in for the payment provider (the demo calls it Tilia), with an outage switch. While
  // faultMode is on, every submit throws a retryable failure (what the worker retries, then
  // abandons at the cap, returning the reserve to the seller); off, it returns a fake providerRef.
  // The switch is read live, so flipping it takes effect on the next worker run.
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

  // A dual-rate credit economy, not a 1:1 placeholder. buy is the acquisition rate a user pays per
  // credit (~120 credits/USD, $0.00833); par is the ledger-backed redemption/settlement rate
  // (~200/USD, $0.005); payout settles at par. The buy-vs-par gap is the platform spread that funds
  // fees, processing, reserves, and margin.
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

  // A logger that discards its output, so the demo's injected faults don't flood the dev terminal.
  // Still the library's real logger type, not an empty stub.
  const logger = jsonlLogger({ out: () => {}, err: () => {} });
  // A metrics sink that discards everything; the demo collects no metrics.
  // A hand-rolled object satisfying the Meter interface, not a library factory (there is no metrics
  // counterpart to jsonlLogger).
  const meter = { count: () => {}, observe: () => {} };

  // Build (or rebuild) the engine + worker over one env-selected store, so both read identical
  // state. capabilitiesFromEnv() selects the store once and assembles the bundle from env plus the
  // demo's injected clock/ids/digest/signer/processor/rates; createEconomy and createWorker then
  // wire both halves over caps.store. workerCtxFrom(caps) shares the same config object, so
  // setMaturityDays/setMaxAttempts can mutate it in place (below) without a rebuild.
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

  // Distinct user ids that hold an account on the ledger, derived live from read.accounts() rather
  // than tracked by hand. isWalletAccount/ownerOf are the lab's own definition of a user wallet
  // (spendable/earned/promo) and its owner, so this never re-encodes the account-id shape.
  async function userIds(): Promise<string[]> {
    const ids = new Set<string>();
    for await (const account of economy.read.accounts()) {
      if (isWalletAccount(account)) {
        ids.add(ownerOf(account));
      }
    }
    return [...ids];
  }

  // Posting legs -> render-ready leg views: labelled, tagged debit/credit (debit is positive minor),
  // signed for display. Used by viewFromPosting() when it builds a feed row from a stored posting.
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

  // Build a feed row from a stored posting (any kind — user operation or worker posting), read
  // straight from the engine's posting log so the amounts/legs are the engine's own, plus a
  // plain-English note for the postings whose legs don't explain themselves.
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
    // Grouped, two-decimal amount to match how the feed's figures read in the table.
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

    // User operations, read back from their own posting (kind in meta) the same way worker postings
    // are. The engine's posting log is the one source, so these render straight from legs + meta,
    // like everything else — including a direct-to-DB posting (e.g. the bench's). Display niceties
    // that aren't on the immutable posting (a listing name, friendly buyer/seller labels) are
    // derived from what the legs imply: the user the operation concerns, and a generic listing line.
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

    if (metaKind === 'payout.deadLetter') {
      const reason = humanReason(String(meta.reason ?? ''));
      return {
        ...base,
        kind: 'payoutReversed',
        label: LABELS.payoutReversed,
        listing: 'Reserve returned to seller',
        note: `Tilia payout failed (${reason}) after the retry cap. The ${cr} reserve was returned to ${user}'s earned balance — nothing is stranded.`,
      };
    }
    if (metaKind === 'payout.settle') {
      return {
        ...base,
        kind: 'payoutSettled',
        label: LABELS.payoutSettled,
        listing: `Settled to ${user}`,
        note: `Payout to ${user} settled — the ${cr} reserve was released to platform revenue.`,
      };
    }
    // USD companion of a settlement: the cash leg that pays the seller out of trust. Its own row in
    // the feed (newest first, the engine's posting log isn't re-stitched into one row per event). The
    // settled payout's "paid" caption on the board now comes from the saga's own payoutUsd field, so
    // this branch only builds the feed row.
    if (metaKind === 'payout.settle.cash') {
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
    if (metaKind === 'promoExpiry') {
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

  // Run every background job once and return the per-job batch summary. runJobs() folds it into the
  // one-line note the panel shows; the payout board instead reads each saga's own attempt count.
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

  // Seed a demo economy that has already run a bit, so the first load shows the full lifecycle:
  // user operations plus the worker's own postings (settlements with their cash legs, a fee sweep,
  // a provider outage reversing a payout). Ends with settled/failed/in-flight payouts and the clock
  // a couple of days in. Payout amounts are fractions of each seller's actual earned balance.
  async function seed(): Promise<void> {
    // Day 0 — everyday operations. At par ($0.005/credit) the two deposits back $40 of real cash in
    // trust, with the buy-vs-par spread booked as revenue; the purchases leave nova and pixel with
    // earned credits to cash out.
    await api.deposit({ userId: 'usr_alice', credits: 5000 }); // ~$41.67 at the buy rate
    await api.deposit({ userId: 'usr_bjorn', credits: 3000 }); // ~$25.00 at the buy rate
    await api.grantPromo({ userId: 'usr_alice', credits: 500 }); // alice spends hers below
    await api.grantPromo({ userId: 'usr_pixel', credits: 600 }); // a creator incentive, left unspent
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

    // Two payouts that settle fully. Run the worker twice, a day apart: first run RESERVED →
    // SUBMITTED, second SUBMITTED → SETTLED, posting the reserve→revenue and trust→bank legs and
    // triggering the fee sweep.
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

    // One bounded page of user wallets, ordered by user id so paging is stable across requests.
    // Ordering by id needs no balance reads (a sort by total would read every user's three
    // balances just to order them): enumerate user ids, sort that list for a deterministic page
    // window, then read the three balances only for the `limit` users on the page. Per-page DB
    // work is O(limit), independent of the user count.
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

    // One user's three balances, read directly. Returns null when the user has no wallet account at
    // all (no balances posted), so the detail panel can fall back to "not found" rather than
    // showing a phantom all-zero wallet.
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

    // One bounded page of the ledger feed, newest first, read straight from the engine's streaming
    // posting log — the same way `payouts` pages the saga list. We build a view object only for the
    // `limit` postings on the page (between `offset` and `offset+limit`); the rest of the pass just
    // counts toward `total` for the pager, holding no extra objects. Reading from the posting log
    // (not a side feed) is also why a direct-to-DB write — e.g. the bench's — shows up here: the
    // side feed only ever saw writes made through this process.
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

    // One bounded page of the payout board, newest first, read straight from the engine's streaming
    // saga list. We materialize a view object only for the `limit` sagas on the page (between
    // `offset` and `offset+limit`); the rest of the pass just counts toward `total` for the pager,
    // holding no extra objects — so a long board never builds more than one page of views in one
    // streaming pass. Each terminal caption (failure reason / USD paid) is read straight off the
    // saga record's own terminal-outcome fields — the engine persists them at the SETTLED/FAILED
    // transition — so no posting-meta side-channel is needed.
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
          // The failure reason is a raw code on the saga; humanize it the way the feed does. USD is
          // a USD Amount, rendered to dollars with toCredits (minor-units / scale).
          reason: saga.reason === null ? null : humanReason(saga.reason),
          payoutUsd: saga.payoutUsd === null ? null : toCredits(saga.payoutUsd),
        });
      }
      return { rows, total, offset, limit };
    },

    // Per-state payout tallies, counted in a single streaming pass over the saga list. REQUESTED
    // folds into RESERVED to match the board's columns (requestPayout opens directly in RESERVED).
    // This streams every saga but holds only four integers, never an array of sagas, so the board
    // shows accurate column counts without materializing the whole list.
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
      // Serve a fresh-enough cached snapshot if we have one. This read sums a balance over every
      // user and runs a full prove(), and the page frame asks for it on every navigation, so the
      // cache keeps a quiet browse from re-scanning the ledger each click. Any mutation clears the
      // cache (see invalidateSolvency), so the figure is never stale across a change the user made.
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

    // Platform account balances, read live from the ledger and shown as magnitudes (the Overview
    // reads as "how much sits in each account", not signed postings).
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
      // Worker postings (settlements, reversals, sweeps) move money, so the cached figure is stale;
      // the new postings are read from the engine's log on the next ledger page, not captured here.
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
