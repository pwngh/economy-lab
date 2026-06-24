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
import { currency } from '#src/accounts.ts';
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

type RecordMeta = {
  kind: TxnKind;
  listing: string;
  priceCredits: number;
  buyer: string;
  seller: string;
  paymentType: string;
};

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

  wallets(): Promise<WalletView[]>;
  ledger(): TxnView[];
  payouts(): Promise<PayoutView[]>;
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

  let txns: TxnView[] = [];
  let users = new Set<string>();

  let faultMode = false;
  let maturityDays = 0;
  let maxAttempts = 5;
  let idSeq = 0;

  // Every payout id the engine mints (recorded by the id generator below); the payout board loads
  // each saga from the store to render a card. Cleared on rebuild.
  let sagaIds: string[] = [];

  // Every "txn" id the engine mints, from user operations and worker postings alike. capturedTxnIds
  // marks the ones already in the feed; after a worker run we read back the rest from the ledger
  // (see captureWorkerPostings) so settlements and reversals show up too. Cleared on rebuild.
  let mintedTxnIds: string[] = [];
  let capturedTxnIds = new Set<string>();

  // What became of each terminal payout, harvested from the worker's ledger postings (the saga
  // record keeps neither): failure reason for a reversal, USD disbursed for a settlement. Used to
  // caption the payout cards.
  let sagaInfo = new Map<string, { reason?: string; usd?: number }>();

  // The engine's default SHA-256 hasher (Web Crypto), reused so the console hashes as the engine does.
  const digest: Digest = systemDigest();

  // Mints ids like "txn_1"/"pay_2", and records every "pay_" id into sagaIds for the payout board.
  const ids: Ids = {
    next: (prefix) => {
      const id = `${prefix}_${++idSeq}`;
      if (prefix === 'pay') {
        sagaIds.push(id);
      }
      if (prefix === 'txn') {
        mintedTxnIds.push(id);
      }
      return id;
    },
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

  // Exchange rates from VRChat's published Creator Economy model, not a 1:1 placeholder. buy is what
  // a user pays per credit (~120 credits/USD, $0.00833); par is the backing/cash-out value
  // (~200/USD, $0.005); payout equals par. The buy-vs-par gap is the platform's ~40% purchase fee.
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
    sagaIds = [];
    mintedTxnIds = [];
    capturedTxnIds = new Set<string>();
    sagaInfo = new Map<string, { reason?: string; usd?: number }>();

    const caps: Capabilities = await capabilitiesFromEnv(
      demoEnv(maturityDays, maxAttempts),
      { signer, processor, rates, pricing: flatFee() },
      { clock, ids, digest, logger, meter },
    );
    economy = createEconomy(caps);
    workerCtx = workerCtxFrom(caps);
    workerRef = createWorker(caps.store, workerCtx);
  }

  function usersOf(op: Operation): string[] {
    if (op.kind === 'spend') {
      const sellers = (op.recipients ?? []).map((r) => r.sellerId);
      return [op.buyerId, ...sellers];
    }
    if (
      op.kind === 'topUp' ||
      op.kind === 'requestPayout' ||
      op.kind === 'grantPromo'
    ) {
      return [op.userId];
    }
    return [];
  }

  // Posting legs -> render-ready leg views: labelled, tagged debit/credit (debit is positive minor),
  // signed for display. Shared by record() and viewFromPosting().
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

  // The N in a "txn_N" id: commit order, used to sort the feed newest-first.
  function txnSeq(id: string): number {
    const n = Number(id.slice(id.lastIndexOf('_') + 1));
    return Number.isFinite(n) ? n : 0;
  }

  // The first user account a posting touches (not a "vrchat:" one), so a worker posting can name
  // the user it concerns. Null if none.
  function userInLegs(legs: ReadonlyArray<Leg>): string | null {
    for (const leg of legs) {
      if (!leg.account.startsWith('vrchat:')) {
        const colon = leg.account.lastIndexOf(':');
        return colon >= 0 ? leg.account.slice(0, colon) : leg.account;
      }
    }
    return null;
  }

  // Record a committed user operation into the feed, and mark its txn id captured so the worker
  // sweep doesn't add it again.
  function record(outcome: Outcome, meta: RecordMeta): void {
    if (outcome.status !== 'committed') {
      return;
    }
    const tx = outcome.transaction;
    const id = tx.id ?? `txn_${txns.length}`;
    capturedTxnIds.add(id);
    txns.unshift({
      id,
      at: clock.now(),
      kind: meta.kind,
      label: LABELS[meta.kind] ?? meta.kind,
      paymentType: meta.paymentType,
      listing: meta.listing,
      priceCredits: meta.priceCredits,
      priceCurrency: 'CREDIT',
      buyer: meta.buyer,
      seller: meta.seller,
      legs: toLegViews(tx.legs ?? []),
      balancedTo: balanceOf(tx.legs ?? []),
    });
  }

  // Build a feed row from a worker posting (payout settle/fail, promo reclaim), read straight from
  // the stored posting so the amounts/legs are the engine's own, plus a plain-English note.
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
      buyer: 'VRChat',
      seller: user,
      legs: toLegViews(p.legs),
      balancedTo: balanceOf(p.legs),
      sagaId,
    };

    if (metaKind === 'payout.deadLetter') {
      const reason = humanReason(String(meta.reason ?? ''));
      if (sagaId) {
        sagaInfo.set(sagaId, { ...sagaInfo.get(sagaId), reason });
      }
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
    // USD companion of a settlement. Normally folded into the settle row (mergeCashInto); this is
    // the fallback if that pairing misses.
    if (metaKind === 'payout.settle.cash') {
      if (sagaId) {
        sagaInfo.set(sagaId, { ...sagaInfo.get(sagaId), usd: amount });
      }
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

  // Fold a USD "*.cash" posting into the event it completes, so a settlement or fee sweep is one
  // feed row whose expansion shows both sides. Headline stays the credit figure; the cash amount
  // goes into the note (and the payout board's "paid" caption for a settlement).
  function mergeCashInto(parent: TxnView, posting: Posting): void {
    parent.legs = [...parent.legs, ...toLegViews(posting.legs)];
    const first = posting.legs[0];
    const usd = first ? Math.abs(toCredits(first.amount)) : 0;
    const money = usd.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const sagaId = String((posting.meta as { sagaId?: string }).sagaId ?? '');
    if (parent.kind === 'payoutSettled') {
      if (sagaId) {
        sagaInfo.set(sagaId, { ...sagaInfo.get(sagaId), usd });
      }
      parent.note = `${parent.note} $${money} was paid out to ${parent.seller} from trust cash.`;
    } else if (parent.kind === 'feeSweep') {
      parent.note = `${parent.note} $${money} of matching cash moved to the platform's bank.`;
    } else {
      parent.note =
        `${parent.note ?? ''} $${money} of cash moved alongside.`.trim();
    }
  }

  // After a worker run, pull the txns it just minted into the feed (settlements, reversals, fee
  // sweeps). fromIndex is where the id list stood before the run, so we see only this run's ids and
  // never re-walk earlier ones. "*.cash" postings are merged into the event they complete; the rest
  // become rows. Then re-sort newest-first.
  async function captureWorkerPostings(fromIndex: number): Promise<void> {
    let added = false;
    let lastEvent: TxnView | null = null;
    for (let i = fromIndex; i < mintedTxnIds.length; i++) {
      const id = mintedTxnIds[i];
      if (capturedTxnIds.has(id)) {
        continue;
      }
      capturedTxnIds.add(id);
      const posting = await economy.read.posting(id);
      if (!posting) {
        continue;
      }
      const kind = String((posting.meta as { kind?: string }).kind ?? '');
      if (kind.endsWith('.cash') && lastEvent) {
        const cashSaga = String(
          (posting.meta as { sagaId?: string }).sagaId ?? '',
        );
        // Pair the cash leg with the event right before it: by saga when it has one, else by the
        // sweep that just posted. If it somehow doesn't line up, fall through to its own row.
        const pairs = cashSaga
          ? lastEvent.sagaId === cashSaga
          : lastEvent.kind === 'feeSweep';
        if (pairs) {
          mergeCashInto(lastEvent, posting);
          continue;
        }
      }
      const view = await viewFromPosting(id, posting);
      txns.push(view);
      lastEvent = view;
      added = true;
    }
    if (added) {
      txns.sort((a, b) => txnSeq(b.id) - txnSeq(a.id));
    }
  }

  let opSeq = 0;
  function key(prefix: string): string {
    return `${prefix}_${++opSeq}`;
  }

  async function submit(op: Operation, meta: RecordMeta): Promise<Outcome> {
    const outcome = await economy.submit(op);
    record(outcome, meta);
    // Only remember a user once they have a committed transaction. Tracking before the outcome —
    // or for a rejected one — would leave a phantom, empty-balance wallet row behind (for example
    // from a declined or malformed request), since wallets() and solvency() iterate this set.
    if (outcome.status === 'committed') {
      for (const u of usersOf(op)) {
        users.add(u);
      }
    }
    return outcome;
  }

  // Run every background job once and return the per-job batch summary. runJobs() folds it into the
  // one-line note the panel shows; the payout board instead reads each saga's own attempt count.
  async function runWorkerOnce(): Promise<
    Record<string, { ok: boolean; summary?: unknown }>
  > {
    const batch = await workerRef.runOnce({
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
    return batch as unknown as Record<
      string,
      { ok: boolean; summary?: unknown }
    >;
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
      submit(
        {
          kind: 'topUp',
          idempotencyKey: key('idem'),
          actor: { kind: 'system', service: 'console' },
          source: 'card',
          userId,
          amount: credits(amount),
        } as Operation,
        {
          kind: 'topUp',
          listing: 'Credit top-up',
          priceCredits: amount,
          buyer: userId,
          seller: 'VRChat',
          paymentType: 'Card',
        },
      ),

    purchase: ({ buyerId, sellerId, listing, credits: price }) =>
      submit(
        {
          kind: 'spend',
          idempotencyKey: key('idem'),
          actor: { kind: 'user', userId: buyerId },
          buyerId,
          sku: listing,
          price: credits(price),
          recipients: [{ sellerId, shareBps: 10_000 }],
          orderId: key('ord'),
        } as Operation,
        {
          kind: 'spend',
          listing,
          priceCredits: price,
          buyer: buyerId,
          seller: sellerId,
          paymentType: 'Credits',
        },
      ),

    requestPayout: ({ userId, credits: amount }) =>
      submit(
        {
          kind: 'requestPayout',
          idempotencyKey: key('idem'),
          actor: { kind: 'user', userId },
          userId,
          amount: credits(amount),
        } as Operation,
        {
          kind: 'requestPayout',
          listing: 'Payout to Tilia',
          priceCredits: amount,
          buyer: 'VRChat',
          seller: userId,
          paymentType: 'Tilia',
        },
      ),

    grantPromo: ({ userId, credits: amount }) =>
      submit(
        {
          kind: 'grantPromo',
          idempotencyKey: key('idem'),
          actor: { kind: 'system', service: 'marketing' },
          userId,
          amount: credits(amount),
          expiresAt: clock.now() + 30 * 24 * 60 * 60_000,
        } as Operation,
        {
          kind: 'grantPromo',
          listing: 'Promotional credits',
          priceCredits: amount,
          buyer: userId,
          seller: 'VRChat',
          paymentType: 'Promotion',
        },
      ),

    wallets: async () => {
      const out: WalletView[] = [];
      for (const userId of users) {
        const p = toCredits(await economy.read.balance(spendable(userId)));
        const e = toCredits(await economy.read.balance(earned(userId)));
        const m = toCredits(await economy.read.balance(promo(userId)));
        out.push({
          userId,
          purchased: p,
          earned: e,
          promotional: m,
          total: p + e + m,
        });
      }
      return out.sort((a, b) => b.total - a.total);
    },

    ledger: () => txns.slice(),

    payouts: async () => {
      const out: PayoutView[] = [];
      for (const id of sagaIds) {
        const saga = await economy.read.saga(id);
        if (!saga) {
          continue;
        }
        const info = sagaInfo.get(saga.id);
        out.push({
          id: saga.id,
          userId: saga.userId,
          reserveCredits: toCredits(saga.reserve),
          state: saga.state,
          providerRef: saga.providerRef,
          attempts: saga.attempts,
          dueAt: saga.dueAt,
          reason: info?.reason ?? null,
          payoutUsd: info?.usd ?? null,
        });
      }
      return out;
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
      let purchased = 0;
      let earnedTotal = 0;
      let promotional = 0;
      for (const userId of users) {
        purchased += toCredits(await economy.read.balance(spendable(userId)));
        earnedTotal += toCredits(await economy.read.balance(earned(userId)));
        promotional += toCredits(await economy.read.balance(promo(userId)));
      }
      const r = await economy.read.prove();
      const trustCash = await economy.read.balance(SYSTEM.TRUST_CASH);
      return {
        userCredits: purchased + earnedTotal + promotional,
        backed: r.backed,
        shortfallUsd: toCredits(r.shortfall),
        trustCashUsd: toCredits(trustCash),
        purchased,
        earned: earnedTotal,
        promotional,
      };
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
      txns = [];
      users = new Set<string>();
      opSeq = 0;
      await rebuild();
      await seed();
    },

    clear: async () => {
      faultMode = false;
      maturityDays = 0;
      maxAttempts = 5;
      txns = [];
      users = new Set<string>();
      opSeq = 0;
      await rebuild();
    },

    runJobs: async () => {
      // Mark where the txn-id list stands, so the capture below sees only this run's postings.
      const fromIndex = mintedTxnIds.length;
      const batch = await runWorkerOnce();
      // Fold the run's new postings (settlements, reversals) into the feed.
      await captureWorkerPostings(fromIndex);
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
      return notes.length ? notes.join(' · ') : 'No due items';
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
