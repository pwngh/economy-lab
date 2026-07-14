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
 * Bridges the web UI and the economy-lab engine. The whole engine runs in the visitor's tab over
 * the in-memory store — one private sandbox economy per tab (engine.ts owns the singleton), no
 * server behind it. The DB engines exist for the bench and conformance suites, not here.
 */

import { currency, isWalletAccount, ownerOf } from '#src/accounts.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { MemoryLedger } from '#src/adapters/memory.ts';
import { configuredRates } from '#src/adapters/rates.ts';
import { economyPaused } from '#src/config.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import {
  SYSTEM,
  capabilitiesFromEnv,
  createWorker,
  earned,
  economyFromCapabilities,
  promo,
  spendable,
  workerCtxFrom,
} from '#src/index.ts';
import { proveEconomy } from '#src/integrity.ts';
import { convertFloor } from '#src/money.ts';
import { flatFee } from '#src/pricing.ts';
import { jsonlLogger, systemDigest, systemSigner } from '#src/runtime.ts';
import { createServer } from '#src/server.ts';
import { handleWebhook } from '#src/webhooks.ts';
import { drainInbox } from '#src/worker/inbox.ts';
import { relayOutbox } from '#src/worker/relay.ts';

import type {
  Capabilities,
  Economy,
  Operation,
  Outcome,
  Principal,
  ProveReport,
  WorkerCtx,
} from '#src/index.ts';
import type {
  Clock,
  Digest,
  Dispatcher,
  EconomyEvent,
  Ids,
  Leg,
  Posting,
  Rates,
  Saga,
  Store,
} from '#src/ports.ts';
import type { PurchaseEvent } from '#src/webhooks.ts';
import type { Worker } from '#src/worker/index.ts';

import { DAY_MS, demoEnv, makeClock } from '~/demo';
import {
  LABELS,
  PLATFORM_ACCOUNTS,
  accountLabel,
  credits,
  humanReason,
  humanizeKind,
  toCredits,
} from '~/views';

import type {
  CheckpointView,
  FindHit,
  LegView,
  LineageLink,
  PayoutView,
  PipelineEvent,
  PipelineView,
  PlatformAccountView,
  ProveView,
  RaceResult,
  RateBoard,
  RelayResult,
  SagaDetail,
  SimSettings,
  SolvencyView,
  StatementView,
  StatusView,
  SubscriptionView,
  TxnKind,
  TxnView,
  WalletView,
  WebhookResult,
} from '~/views';

// Re-export the view shapes so route modules keep importing them from `~/economy`.
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
  StatusView,
  RaceResult,
  StatementView,
  LineageLink,
  CheckpointView,
  FindHit,
  RateBoard,
  SubscriptionView,
  SagaDetail,
  PipelineView,
  PipelineEvent,
  RelayResult,
  WebhookResult,
} from '~/views';

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

// A burst runs at least two spends and is capped so a hostile visitor cannot fan out unbounded work.
const MAX_BURST = 12;
function clampCount(n: number): number {
  return Math.min(MAX_BURST, Math.max(2, Math.floor(Number(n)) || 2));
}

// The genesis prevHash (a first link's "before"); never a real posting hash, so never a search hit.
const GENESIS_HASH = '0'.repeat(64);
// Bounds the account/chain walk a hash search does, so a pasted junk hash cannot fan out unbounded work.
const FIND_SCAN_MAX = 20_000;

// Rates are shown and set as USD per 1,000 credits — readable (8.33 to buy a credit, 5.00 to redeem
// one), where the per-1,000 form of a { rate, scale } is `rate / 10^scale * 1000`.
const DEFAULT_RATES = {
  buyRate: 8333n,
  buyScale: 6,
  parRate: 5n,
  parScale: 3,
  payoutRate: 5n,
  payoutScale: 3,
};
function rateToPerThousand(r: { rate: bigint; scale: number }): number {
  return (Number(r.rate) / 10 ** r.scale) * 1000;
}
function perThousandToRate(perThousand: number): {
  rate: bigint;
  scale: number;
} {
  return { rate: BigInt(Math.round(perThousand * 1000)), scale: 6 };
}

// The band a repriced rate must stay within (USD per 1,000 credits): par is pegged in a sane range,
// and the buy rate sits between par and a capped multiple of it, so the spread can neither invert
// (which would throw LEDGER_UNBALANCED on a deposit) nor run away.
const PAR_FLOOR = 1;
const PAR_CEIL = 50;
const MAX_SPREAD_MULTIPLE = 3;

// A hash query is either the full value or the truncated `prefix…suffix` display form; build the
// matcher for whichever was pasted. Comparison is case-insensitive.
function hashMatcher(query: string): (h: string) => boolean {
  const sep = query.includes('…') ? '…' : query.includes('...') ? '...' : null;
  if (sep) {
    const [prefix = '', suffix = ''] = query.split(sep);
    const p = prefix.trim().toLowerCase();
    const s = suffix.trim().toLowerCase();
    return (h) => {
      const low = h.toLowerCase();
      return p !== '' && s !== '' && low.startsWith(p) && low.endsWith(s);
    };
  }
  const q = query.toLowerCase();
  return (h) => h.toLowerCase() === q;
}

// Sort a burst's outcomes into the tally the board renders. A same-order duplicate and an
// idempotency replay both count as duplicates; a funds refusal counts as insufficient.
function tally(results: Outcome[], movedCredits: number): RaceResult {
  let committed = 0;
  let duplicates = 0;
  let insufficient = 0;
  let other = 0;
  for (const r of results) {
    if (r.status === 'committed') {
      committed++;
    } else if (r.status === 'duplicate') {
      duplicates++;
    } else if (r.reason === 'DUPLICATE_ORDER') {
      duplicates++;
    } else if (r.reason === 'INSUFFICIENT_FUNDS') {
      insufficient++;
    } else {
      other++;
    }
  }
  return {
    attempts: results.length,
    committed,
    duplicates,
    insufficient,
    other,
    movedCredits,
  };
}

// One payout saga as a board card. The terminal captions (failure reason / USD paid) come from the
// saga's own terminal-outcome fields, not a posting-meta side channel.
function sagaView(saga: Saga): PayoutView {
  return {
    id: saga.id,
    userId: saga.userId,
    reserveCredits: toCredits(saga.reserve),
    state: saga.state,
    providerRef: saga.providerRef,
    attempts: saga.attempts,
    dueAt: saga.dueAt,
    reason: saga.reason === null ? null : humanReason(saga.reason),
    payoutUsd: saga.payoutUsd === null ? null : toCredits(saga.payoutUsd),
  };
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
  // `actor` overrides who submits, so the acting-as switcher can provoke the authorization gate;
  // `orderId` is reusable so a resubmit provokes DUPLICATE_ORDER; `giftTo` names an entitlement
  // recipient other than the buyer. All default to the ordinary self-purchase.
  purchase(input: {
    buyerId: string;
    sellerId: string;
    listing: string;
    credits: number;
    actor?: Principal;
    orderId?: string;
    giftTo?: string;
  }): Promise<Outcome>;
  requestPayout(input: {
    userId: string;
    credits: number;
    actor?: Principal;
  }): Promise<Outcome>;
  grantPromo(input: { userId: string; credits: number }): Promise<Outcome>;
  // Operator reversal of a stuck payout: returns the reserve to the seller's earned balance. The
  // engine refuses a settled or still-live-submitted saga (a thrown SAGA.INVALID_TRANSITION).
  reversePayout(input: {
    sagaId: string;
    userId: string;
    reason: string;
  }): Promise<Outcome>;
  // One payout drilled open: the card plus every ledger posting carrying its saga id.
  sagaDetail(id: string): Promise<SagaDetail | null>;
  // Settle every submitted payout, simulating the provider's settlement report (the payout.settled
  // webhook): SUBMITTED -> SETTLED, the reserve realized and the seller paid out of trust cash.
  settleSubmitted(): Promise<{ settled: number }>;

  // Fire `count` purchases at one engine in a burst: `raceOrder` reuses one order id (one commits,
  // the rest replay DUPLICATE_ORDER), `drainWallet` uses fresh ids against a thin wallet (the funds
  // gate holds). The in-memory store is a single writer, so the burst runs one submit at a time;
  // the same guarantee under true parallelism is what the conformance race suite proves.
  raceOrder(input: {
    buyerId: string;
    sellerId: string;
    listing: string;
    credits: number;
    count: number;
  }): Promise<RaceResult>;
  drainWallet(input: {
    buyerId: string;
    sellerId: string;
    listing: string;
    credits: number;
    count: number;
  }): Promise<RaceResult>;

  // Heavy lists are read one bounded page at a time.
  wallets(page?: Partial<PageReq>): Promise<Page<WalletView>>;
  // One user's wallet, read directly, so the detail panel can show a user who isn't on the current
  // page. Null when the user holds no wallet account.
  wallet(userId: string): Promise<WalletView | null>;
  ledger(page?: Partial<PageReq>): Promise<Page<TxnView>>;
  payouts(page?: Partial<PageReq>): Promise<Page<PayoutView>>;
  payoutCounts(): Promise<PayoutCounts>;
  prove(): Promise<ProveView>;
  // The thorough prover (src/integrity.ts): re-derives the whole hash chain and every balance
  // from the raw lines — the audit that catches tampering the light read.prove() shape check
  // cannot. Heavier by design; the page defers it behind the light report.
  proveFull(): Promise<ProveView>;
  // Integrity theater: corrupt a stored posting / plant an unexplained balance, so the visitor
  // can watch the full prover catch each one. Heal by reset().
  tamper(): Promise<{ txnId: string; account: string }>;
  seedDrift(): Promise<{ account: string }>;

  // Subscriptions: open one (refused while another is active for the same user/sku/seller),
  // cancel by id, and list the ones this tab opened — re-read live, so the worker's renewal
  // sweep shows up as state and nextDueAt changes.
  subscribe(input: {
    userId: string;
    sellerId: string;
    sku: string;
    credits: number;
    periodDays: number;
  }): Promise<Outcome>;
  cancelSubscription(input: { subscriptionId: string }): Promise<Outcome>;
  subscriptions(): Promise<SubscriptionView[]>;
  solvency(): Promise<SolvencyView>;
  platformAccounts(): Promise<PlatformAccountView[]>;
  status(): Promise<StatusView>;
  // Whether a user holds the entitlement for a sku — the gift flow lands it on the recipient, not
  // the buyer.
  entitled(userId: string, sku: string): Promise<boolean>;

  // The ledger explorer drill, over the promoted read surface: one posting by id, an account's
  // statement, its tamper-evident hash chain, and the latest signed checkpoint.
  posting(txnId: string): Promise<TxnView | null>;
  statement(account: string): Promise<StatementView>;
  lineage(account: string): Promise<LineageLink[]>;
  checkpoint(): Promise<CheckpointView | null>;
  // Resolve any ledger identifier to a drill target: a txn id, an account, a chain hash (a posting's
  // `hash`/`prevHash`), a Merkle root, or a checkpoint signature. Accepts the truncated `prefix…suffix`
  // display form. Null when nothing matches.
  find(query: string): Promise<FindHit | null>;

  // The event pipeline: outbox -> relay -> inbox. `pipeline` reads what the relay has delivered so
  // far; `runRelay` delivers pending outbox rows through a console capture dispatcher; `postWebhook`
  // applies an inbound provider event once, so a redelivery of the same event id posts nothing.
  pipeline(): PipelineView;
  runRelay(): Promise<RelayResult>;
  postWebhook(input: {
    eventId: string;
    userId: string;
    credits: number;
  }): Promise<WebhookResult>;

  // The engine's own HTTP service (src/server.ts createServer), bound to this tab's economy, so
  // POST /submit runs a wire operation through the same ledger the UI drives.
  httpFetch(request: Request): Promise<Response>;

  advanceTime(ms: number): void;
  now(): number;

  settings(): SimSettings;
  setFault(on: boolean): void;
  setMaturityDays(days: number): Promise<void>;
  setMaxAttempts(n: number): Promise<void>;
  // Gate knobs: arm the four gates the demo relaxes by default. Each mutates the shared config in
  // place, the same way setMaturityDays does, so the next submit sees it without a rebuild.
  setVelocityLimit(credits: number): Promise<void>;
  setMaintenance(on: boolean): Promise<void>;
  setPayoutMinimum(credits: number): Promise<void>;
  setPayoutIntervalDays(days: number): Promise<void>;
  // The treasury rate desk. Repricing is governed: `rateBoard` reports the live rates + lock state +
  // what blocks a change; `unlockRates` opens the desk only when no payout is in flight (and pauses
  // the economy); `setRates` applies bounded buy/par (payout follows par) while unlocked; `lockRates`
  // re-locks and resumes.
  rateBoard(): Promise<RateBoard>;
  unlockRates(): Promise<{ ok: boolean; message: string }>;
  setRates(input: { buyPerThousand: number; parPerThousand: number }): {
    ok: boolean;
    message: string;
  };
  lockRates(): Promise<{ ok: boolean; message: string }>;

  reset(): Promise<void>; // rebuild engine + re-seed the demo (re-seeds the configured store)
  clear(): Promise<void>; // rebuild engine, empty, no seed (removes all users)
  runJobs(): Promise<string>;
  close(): Promise<void>;
}

export async function buildEngine(): Promise<ConsoleEngine> {
  const clock = makeClock();

  let economy: Economy;
  let workerRef: Worker;
  let workerCtx: WorkerCtx;
  // The store the economy and worker share; the pipeline page reaches it directly (outbox/inbox
  // have no read surface to promote onto Economy.read).
  let store: Store;

  let faultMode = false;
  let maturityDays = 0;
  let maxAttempts = 5;
  let idSeq = 0;

  // What the relay has delivered through the console capture dispatcher, newest first, for the
  // pipeline page. In-memory and per-tab; reset on rebuild.
  let deliveredEvents: PipelineEvent[] = [];

  // The subscriptions this tab opened (the store has no list-all read); each is re-read live.
  let subIds: string[] = [];

  // Mutation mutex: two in-flight mutations would otherwise interleave engine calls (a reset
  // racing a jobs run corrupts demo state). Mutations queue on one promise chain; reads run free. A mutation that itself calls another (reset re-seeds) runs inline, not re-queued, so
  // it never waits on the lock it already holds.
  let mutationChain: Promise<unknown> = Promise.resolve();
  let inMutation = false;
  function mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (inMutation) {
      return fn();
    }
    const run = async (): Promise<T> => {
      inMutation = true;
      try {
        return await fn();
      } finally {
        inMutation = false;
      }
    };
    const result = mutationChain.then(run, run);
    // The next mutation waits for this one to settle, success or failure; the caller still sees the
    // rejection through `result`, but one failed mutation must not break the queue for the next.
    mutationChain = result.catch(() => undefined);
    return result;
  }

  // Memoized chrome reads: the page frame asks for solvency() (every user's balances plus a
  // prove()) and the light prove() on every navigation, and live mode every few seconds. Both are
  // cached for a short TTL and cleared on every mutation, so a figure is never stale across a
  // change the user made.
  const READ_TTL_MS = 5_000;
  let solvencyCache: { at: number; value: SolvencyView } | null = null;
  let proveCache: { at: number; value: ProveView } | null = null;
  function invalidateReadCaches(): void {
    solvencyCache = null;
    proveCache = null;
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
  // redemption/settlement rate, and payout settles at par. The buy-vs-par gap is the platform spread.
  // Only `buy` is adjustable at runtime (setBuyRate): par and payout stay fixed because backing and
  // settlement value credits at par live, and a mid-flight par/payout change could break solvency.
  let ratesConfig = { ...DEFAULT_RATES };
  let builtRates = configuredRates(ratesConfig);
  function rebuildRates(): void {
    builtRates = configuredRates(ratesConfig);
  }
  // A stable Rates port over a rebuildable configuredRates. Swapping in a fresh build on a rate
  // change gives whole new frozen Rate objects — a new rateId embeds the value — so a synchronous
  // reader never sees a torn rate and the recorded rateId stays a faithful function of the value.
  const rates: Rates = {
    payout: (from, to, at, options) => builtRates.payout(from, to, at, options),
    par: (c) => builtRates.par(c),
    buy: (c) => builtRates.buy(c),
  };
  // Rates are locked by default: a change is a governed operation (unlockRates), not a live knob.
  let ratesUnlocked = false;

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
    // A reset restores the default spread and re-locks the rate desk, like every other knob
    // returns to its seed value.
    ratesConfig = { ...DEFAULT_RATES };
    rebuildRates();
    ratesUnlocked = false;

    const caps: Capabilities = await capabilitiesFromEnv(
      demoEnv(maturityDays, maxAttempts),
      { signer, processor, rates, pricing: flatFee() },
      { clock, ids, digest, logger, meter },
    );
    economy = economyFromCapabilities(caps);
    workerCtx = workerCtxFrom(caps);
    workerRef = createWorker(caps.store, workerCtx);
    store = caps.store;
    deliveredEvents = [];
    subIds = [];
  }

  // User ids derived live from read.accounts() via isWalletAccount/ownerOf, so the account-id
  // shape is never re-encoded here.
  async function userIds(eco: Economy): Promise<string[]> {
    const ids = new Set<string>();
    for await (const account of eco.read.accounts()) {
      if (isWalletAccount(account)) {
        ids.add(ownerOf(account));
      }
    }
    return [...ids];
  }

  // The credits a buyer can spend: promo draws first, then purchased, so a spend moves either.
  async function spendPower(userId: string): Promise<number> {
    const p = toCredits(await economy.read.balance(spendable(userId)));
    const m = toCredits(await economy.read.balance(promo(userId)));
    return p + m;
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
        // "Cr" to match every other credit figure; the raw "CREDIT" code collides with the
        // double-entry "credit" side on this very row.
        currency: currency(leg.account) === 'USD' ? 'USD' : 'Cr',
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

  // The seller in a sale is whoever's earned balance it credits — not userInLegs, which returns the
  // buyer's debit leg first and would name the buyer on both sides of the arrow.
  function earnedOwnerInLegs(legs: ReadonlyArray<Leg>): string | null {
    for (const leg of legs) {
      if (leg.account.endsWith(':earned')) {
        return leg.account.slice(0, leg.account.lastIndexOf(':'));
      }
    }
    return null;
  }

  // Build a feed row from a stored posting — user operation or worker posting alike — plus a
  // plain-English note where the legs don't explain themselves. Reads the saga through the caller's
  // captured engine, so a streamed page never mixes old postings with a rebuilt saga table.
  async function viewFromPosting(
    eco: Economy,
    id: string,
    p: Posting,
  ): Promise<TxnView> {
    const meta = p.meta as { kind?: string; sagaId?: string; reason?: string };
    const metaKind = String(meta.kind ?? '');
    const first = p.legs[0];
    const amount = first ? Math.abs(toCredits(first.amount)) : 0;
    const priceCurrency =
      first && currency(first.account) === 'USD' ? 'USD' : 'CREDIT';
    const sagaId = meta.sagaId ? String(meta.sagaId) : undefined;
    const sagaUser = sagaId ? (await eco.read.saga(sagaId))?.userId : null;
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
      // The arrow points at whoever receives the credits (as a purchase points buyer -> seller);
      // a deposit issues the Cr to the user, so Platform -> user, not the reverse.
      return {
        ...base,
        kind: 'topUp',
        label: LABELS.topUp,
        paymentType: 'Card',
        listing: 'Credit top-up',
        buyer: 'Platform',
        seller: user,
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
        seller: earnedOwnerInLegs(p.legs) ?? user,
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
      // A grant gives promo credits to the user, so the arrow runs Platform -> user.
      return {
        ...base,
        kind: 'grantPromo',
        label: LABELS.grantPromo,
        paymentType: 'Promotion',
        listing: 'Promotional credits',
        buyer: 'Platform',
        seller: user,
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

  function toProveView(r: ProveReport): ProveView {
    return {
      conserved: r.conserved,
      backed: r.backed,
      noOverdraft: r.noOverdraft,
      chainIntact: r.chainIntact,
      consistent: r.consistent,
      shortfallUsd: toCredits(r.shortfall),
      drift: r.drift.map((d) => ({
        account: d.account,
        cachedCredits: toCredits(d.materialized),
        derivedCredits: toCredits(d.derived),
      })),
      allGreen:
        r.conserved &&
        r.backed &&
        r.noOverdraft &&
        r.chainIntact &&
        r.consistent,
    };
  }

  async function submit(op: Operation): Promise<Outcome> {
    const outcome = await economy.submit(op);
    // Any committed operation changes balances, so the cached solvency figure is now stale.
    invalidateReadCaches();
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

    // A running subscription: bjorn pays nova weekly. The worker's sweep renews it as time
    // advances and lapses it once his wallet runs dry — the card shows both live.
    await api.subscribe({
      userId: 'usr_bjorn',
      sellerId: 'usr_nova',
      sku: 'Skyline Weekly Pass',
      credits: 150,
      periodDays: 7,
    });

    // A seller's current earned balance, in credits — so a payout request never exceeds it.
    const earnedOf = async (userId: string) =>
      toCredits(await economy.read.balance(earned(userId)));
    const fraction = async (userId: string, f: number) =>
      Math.max(1, Math.floor((await earnedOf(userId)) * f));

    // A completed payout: requested, submitted by the worker once due, then settled by the
    // provider's report — the full RESERVED -> SUBMITTED -> SETTLED arc.
    await api.requestPayout({
      userId: 'usr_nova',
      credits: await fraction('usr_nova', 0.35),
    });
    api.advanceTime(DAY_MS);
    await api.runJobs();
    await api.settleSubmitted();

    // A payout left in flight at SUBMITTED, awaiting its settlement report.
    await api.requestPayout({
      userId: 'usr_pixel',
      credits: await fraction('usr_pixel', 0.6),
    });
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
      mutate(() =>
        submit({
          kind: 'topUp',
          idempotencyKey: key('idem'),
          actor: { kind: 'system', service: 'console' },
          source: 'card',
          userId,
          amount: credits(amount),
        } as Operation),
      ),

    purchase: ({
      buyerId,
      sellerId,
      listing,
      credits: price,
      actor,
      orderId,
      giftTo,
    }) =>
      mutate(() =>
        submit({
          kind: 'spend',
          idempotencyKey: key('idem'),
          actor: actor ?? { kind: 'user', userId: buyerId },
          buyerId,
          sku: listing,
          price: credits(price),
          recipients: [{ sellerId, shareBps: 10_000 }],
          orderId: orderId ?? key('ord'),
          ...(giftTo ? { giftTo } : {}),
        } as Operation),
      ),

    requestPayout: ({ userId, credits: amount, actor }) =>
      mutate(() =>
        submit({
          kind: 'requestPayout',
          idempotencyKey: key('idem'),
          actor: actor ?? { kind: 'user', userId },
          userId,
          amount: credits(amount),
        } as Operation),
      ),

    grantPromo: ({ userId, credits: amount }) =>
      mutate(() =>
        submit({
          kind: 'grantPromo',
          idempotencyKey: key('idem'),
          actor: { kind: 'system', service: 'marketing' },
          userId,
          amount: credits(amount),
          expiresAt: clock.now() + 30 * 24 * 60 * 60_000,
        } as Operation),
      ),

    // The console acts as the operator: reversePayout is privileged, and the engine gates a settled
    // or still-live-submitted saga on its own.
    reversePayout: ({ sagaId, userId, reason }) =>
      mutate(() =>
        submit({
          kind: 'reversePayout',
          idempotencyKey: key('idem'),
          actor: { kind: 'operator', operatorId: 'ops_console' },
          userId,
          sagaId,
          reason,
        } as Operation),
      ),

    // Stand in for the provider's settlement report: settle every submitted payout at once. The
    // engine's settlePayout is system-only and idempotent per saga, so a re-run settles nothing new.
    settleSubmitted: () =>
      mutate(async () => {
        const eco = economy;
        const submittedIds: string[] = [];
        for await (const saga of eco.read.payouts()) {
          if (saga.state === 'SUBMITTED') {
            submittedIds.push(saga.id);
          }
        }
        let settled = 0;
        for (const sagaId of submittedIds) {
          const outcome = await submit({
            kind: 'settlePayout',
            idempotencyKey: key('idem'),
            actor: { kind: 'system', service: 'reconcile' },
            sagaId,
          } as Operation);
          if (outcome.status === 'committed') {
            settled++;
          }
        }
        return { settled };
      }),

    // One shared order id across the burst: the ledger's pre-claim lets exactly one commit and
    // rejects the rest DUPLICATE_ORDER, so the balance moves once no matter how many are fired.
    raceOrder: ({ buyerId, sellerId, listing, credits: price, count }) =>
      mutate(async () => {
        const before = await spendPower(buyerId);
        const orderId = key('ord');
        const results: Outcome[] = [];
        for (let i = 0; i < clampCount(count); i++) {
          results.push(
            await submit({
              kind: 'spend',
              idempotencyKey: key('idem'),
              actor: { kind: 'user', userId: buyerId },
              buyerId,
              sku: listing,
              price: credits(price),
              recipients: [{ sellerId, shareBps: 10_000 }],
              orderId,
            } as Operation),
          );
        }
        const after = await spendPower(buyerId);
        return tally(results, before - after);
      }),

    // Fresh order ids against a thin wallet: no duplicate to catch them, so the funds gate is the
    // only limiter — it commits what the balance covers and rejects the rest INSUFFICIENT_FUNDS.
    drainWallet: ({ buyerId, sellerId, listing, credits: price, count }) =>
      mutate(async () => {
        const before = await spendPower(buyerId);
        const results: Outcome[] = [];
        for (let i = 0; i < clampCount(count); i++) {
          results.push(
            await submit({
              kind: 'spend',
              idempotencyKey: key('idem'),
              actor: { kind: 'user', userId: buyerId },
              buyerId,
              sku: listing,
              price: credits(price),
              recipients: [{ sellerId, shareBps: 10_000 }],
              orderId: key('ord'),
            } as Operation),
          );
        }
        const after = await spendPower(buyerId);
        return tally(results, before - after);
      }),

    // Ordered by user id: paging stays stable, and sorting needs no balance reads — only the
    // page's users get their three balances read.
    wallets: async (req) => {
      // Capture the engine once: a concurrent reset() swaps the binding, and a read must see one
      // consistent snapshot, never a mix of the old and rebuilt economies.
      const eco = economy;
      const { offset, limit } = clampPage(req);
      const ids = (await userIds(eco)).sort();
      const slice = ids.slice(offset, offset + limit);
      const rows: WalletView[] = [];
      for (const userId of slice) {
        const p = toCredits(await eco.read.balance(spendable(userId)));
        const e = toCredits(await eco.read.balance(earned(userId)));
        const m = toCredits(await eco.read.balance(promo(userId)));
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
      const eco = economy;
      const p = toCredits(await eco.read.balance(spendable(userId)));
      const e = toCredits(await eco.read.balance(earned(userId)));
      const m = toCredits(await eco.read.balance(promo(userId)));
      const total = p + e + m;
      const exists = await userIds(eco).then((ids) => ids.includes(userId));
      if (!exists) {
        return null;
      }
      return { userId, purchased: p, earned: e, promotional: m, total };
    },

    // Newest first, streamed from the engine's posting log: views are built only for the page
    // window, the rest of the pass just counts toward `total`. Reading the log (not a side feed)
    // is why a direct-to-DB write — e.g. the bench's — shows up here.
    ledger: async (req) => {
      const eco = economy;
      const { offset, limit } = clampPage(req);
      const rows: TxnView[] = [];
      let total = 0;
      for await (const posting of eco.read.postings()) {
        const index = total++;
        if (index < offset || rows.length >= limit) {
          continue;
        }
        rows.push(await viewFromPosting(eco, posting.txnId, posting));
      }
      return { rows, total, offset, limit };
    },

    // Newest first, streamed from the saga list; views are built only for the page window. The
    // terminal captions (failure reason / USD paid) come from the saga's own terminal-outcome
    // fields, not a posting-meta side channel.
    payouts: async (req) => {
      const eco = economy;
      const { offset, limit } = clampPage(req);
      const rows: PayoutView[] = [];
      let total = 0;
      for await (const saga of eco.read.payouts()) {
        const index = total++;
        if (index < offset || rows.length >= limit) {
          continue;
        }
        rows.push(sagaView(saga));
      }
      return { rows, total, offset, limit };
    },

    // REQUESTED folds into RESERVED to match the board's columns (requestPayout opens directly in
    // RESERVED).
    payoutCounts: async () => {
      const eco = economy;
      const counts: PayoutCounts = {
        RESERVED: 0,
        SUBMITTED: 0,
        SETTLED: 0,
        FAILED: 0,
      };
      for await (const saga of eco.read.payouts()) {
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

    // The saga and every posting that carries its id — the reserve, its submit/settle, and any
    // reversal. The scan is bounded so a hostile visitor cannot make one drill walk an unbounded log.
    sagaDetail: async (id) => {
      const eco = economy;
      const saga = await eco.read.saga(id);
      if (saga === null) {
        return null;
      }
      const postings: TxnView[] = [];
      let scanned = 0;
      let truncated = false;
      for await (const p of eco.read.postings()) {
        if (scanned++ >= 2000) {
          truncated = true;
          break;
        }
        const meta = p.meta as { sagaId?: unknown };
        if (String(meta.sagaId ?? '') === id) {
          postings.push(await viewFromPosting(eco, p.txnId, p));
        }
      }
      return {
        saga: sagaView(saga),
        postings,
        reversible: saga.state === 'RESERVED' || saga.state === 'SUBMITTED',
        truncated,
      };
    },

    // The light prover: a shape check, cheap enough for the chrome ticker on every navigation
    // (proveFull is the one that recomputes hashes). Memoized on the same short TTL as solvency so
    // a burst of navigations or live-mode ticks re-runs neither.
    prove: async () => {
      const now = clock.now();
      if (proveCache && now - proveCache.at < READ_TTL_MS) {
        return proveCache.value;
      }
      const value = toProveView(await economy.read.prove());
      proveCache = { at: now, value };
      return value;
    },

    proveFull: () => proveEconomy(store, { rates, digest }).then(toProveView),

    // Corrupt the newest posting's first leg in place, through the memory store's documented test
    // back door — an after-the-fact edit that leaves the recorded chain untouched, exactly what
    // the chain walk must catch. The victim is named so the page can point at the damage. (The
    // tab sandbox is always the memory store; the DB engines never load here.)
    tamper: () =>
      mutate(async () => {
        let victim: { txnId: string; account: string } | null = null;
        for await (const p of economy.read.postings()) {
          const first = p.legs[0];
          if (first) {
            victim = { txnId: p.txnId, account: first.account };
            break;
          }
        }
        if (victim === null) {
          throw fault(ERROR_CODES.CONFIG_INVALID, 'No posting to tamper with.');
        }
        (store.ledger as MemoryLedger).__tamper(victim.txnId, (legs) => {
          const leg = legs[0];
          if (leg) {
            legs[0] = {
              ...leg,
              amount: { ...leg.amount, minor: leg.amount.minor + 100n },
            };
          }
        });
        invalidateReadCaches();
        return victim;
      }),

    // Plant a cached balance no posting explains — the stray row the consistency check reports as
    // drift, with both figures.
    seedDrift: () =>
      mutate(async () => {
        const account = 'usr_ghost:spendable';
        (store.ledger as MemoryLedger).__seedBalance(
          account as AccountRef,
          credits(123),
        );
        invalidateReadCaches();
        return { account };
      }),

    subscribe: ({ userId, sellerId, sku, credits: price, periodDays }) =>
      mutate(async () => {
        const outcome = await submit({
          kind: 'subscribe',
          idempotencyKey: key('idem'),
          actor: { kind: 'user', userId },
          userId,
          sellerId,
          sku,
          price: credits(price),
          periodMs: Math.max(1, Math.round(periodDays)) * DAY_MS,
        } as Operation);
        // The outcome carries no subscription id; the store's active-lookup names the one just
        // opened, so the card can track it.
        if (outcome.status === 'committed') {
          const sub = await store.subscriptions.activeFor(
            userId,
            sku,
            sellerId,
          );
          if (sub !== null && !subIds.includes(sub.id)) {
            subIds.push(sub.id);
          }
        }
        return outcome;
      }),

    // Cancellation acts as the subscription's own user, the same authorization a real client has.
    cancelSubscription: ({ subscriptionId }) =>
      mutate(async () => {
        const sub = await store.subscriptions.load(subscriptionId);
        if (sub === null) {
          throw fault(ERROR_CODES.CONFIG_INVALID, 'Unknown subscription.');
        }
        return submit({
          kind: 'cancelSubscription',
          idempotencyKey: key('idem'),
          actor: { kind: 'user', userId: sub.userId },
          subscriptionId,
        } as Operation);
      }),

    subscriptions: async () => {
      const rows: SubscriptionView[] = [];
      for (const id of subIds) {
        const sub = await store.subscriptions.load(id);
        if (sub !== null) {
          rows.push({
            id: sub.id,
            userId: sub.userId,
            sellerId: sub.sellerId,
            sku: sub.sku,
            priceCredits: toCredits(sub.price),
            periodDays: sub.periodMs / DAY_MS,
            period: sub.period,
            state: sub.state,
            nextDueAt: sub.nextDueAt,
          });
        }
      }
      return rows;
    },

    solvency: async () => {
      const eco = economy;
      const now = clock.now();
      if (solvencyCache && now - solvencyCache.at < READ_TTL_MS) {
        return solvencyCache.value;
      }
      let purchased = 0;
      let earnedTotal = 0;
      let promotional = 0;
      for (const userId of await userIds(eco)) {
        purchased += toCredits(await eco.read.balance(spendable(userId)));
        earnedTotal += toCredits(await eco.read.balance(earned(userId)));
        promotional += toCredits(await eco.read.balance(promo(userId)));
      }
      const r = await eco.read.prove();
      const trustCash = await eco.read.balance(SYSTEM.TRUST_CASH);
      // What trust cash must cover: only the custodial (purchased) credits, valued at par — the
      // same basis the engine's backing check uses. Earned and promo credits are not trust-backed.
      const backingUsd = toCredits(
        convertFloor(credits(purchased), rates.par('CREDIT'), 'USD'),
      );
      const value: SolvencyView = {
        userCredits: purchased + earnedTotal + promotional,
        backed: r.backed,
        backingUsd,
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
      const eco = economy;
      const out: PlatformAccountView[] = [];
      for (const a of PLATFORM_ACCOUNTS) {
        const bal = await eco.read.balance(a.account);
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

    entitled: (userId, sku) => economy.read.entitled(userId, sku),

    posting: async (txnId) => {
      const eco = economy;
      const p = await eco.read.posting(txnId);
      return p ? viewFromPosting(eco, txnId, p) : null;
    },

    // An account's postings and its live balance. The wide range covers the whole demo history.
    statement: async (account) => {
      const eco = economy;
      const ref = account as AccountRef;
      const [s, bal] = await Promise.all([
        eco.read.statement(ref, { from: 0, to: clock.now() + DAY_MS }),
        eco.read.balance(ref),
      ]);
      return {
        account,
        label: accountLabel(account),
        balance: toCredits(bal),
        currency: currency(ref) === 'USD' ? 'USD' : 'CREDIT',
        entries: s.entries.map((e) => ({
          txnId: e.txnId,
          credits: toCredits(e.amount),
          at: e.postedAt,
        })),
      };
    },

    // The account's tamper-evident chain, each link carrying this account's net movement.
    lineage: async (account) => {
      const eco = economy;
      const links: LineageLink[] = [];
      for await (const link of eco.read.lineage(account as AccountRef)) {
        const credits = link.legs
          .filter((leg) => leg.account === account)
          .reduce((sum, leg) => sum + toCredits(leg.amount), 0);
        links.push({
          txnId: link.txnId,
          prevHash: link.prevHash,
          hash: link.hash,
          credits,
        });
      }
      return links;
    },

    checkpoint: async () => {
      const c = await economy.read.checkpoint();
      return c === null
        ? null
        : {
            root: c.root,
            signature: c.signature,
            count: c.count,
            at: c.at,
            v: c.v,
          };
    },

    // Resolve one query to a drill target. A `txn_` id or an account with a ':' is matched by shape;
    // anything else is treated as a hash and matched against the checkpoint (root/signature) and then
    // every account's chain (each link's hash/prevHash). The account/chain scan is bounded.
    find: async (raw) => {
      const eco = economy;
      const query = raw.trim();
      if (query === '') {
        return null;
      }

      if (query.startsWith('txn_')) {
        const p = await eco.read.posting(query);
        return p ? { kind: 'txn', txnId: query } : null;
      }

      if (query.includes(':')) {
        // Newest posting that touched the account, so the drill opens on a real row.
        let txnId: string | null = null;
        let scanned = 0;
        for await (const link of eco.read.lineage(query as AccountRef)) {
          txnId = link.txnId;
          if (scanned++ >= FIND_SCAN_MAX) {
            break;
          }
        }
        return txnId ? { kind: 'account', account: query, txnId } : null;
      }

      const matches = hashMatcher(query);
      const cp = await eco.read.checkpoint();
      if (cp) {
        if (matches(cp.root)) {
          return { kind: 'checkpoint', field: 'root', checkpoint: cp };
        }
        if (matches(cp.signature)) {
          return { kind: 'checkpoint', field: 'signature', checkpoint: cp };
        }
      }
      let scanned = 0;
      for await (const account of eco.read.accounts()) {
        for await (const link of eco.read.lineage(account)) {
          if (scanned++ >= FIND_SCAN_MAX) {
            return null;
          }
          if (matches(link.hash)) {
            return { kind: 'link', txnId: link.txnId, account, field: 'hash' };
          }
          if (link.prevHash !== GENESIS_HASH && matches(link.prevHash)) {
            return {
              kind: 'link',
              txnId: link.txnId,
              account,
              field: 'prevHash',
            };
          }
        }
      }
      return null;
    },

    pipeline: () => ({ delivered: deliveredEvents }),

    // Claim pending outbox rows and deliver them through a console-side capture dispatcher that
    // records the payloads rather than sending them anywhere (the sandbox makes no outbound calls).
    runRelay: () =>
      mutate(async () => {
        const captured: PipelineEvent[] = [];
        const dispatcher: Dispatcher = async (event: EconomyEvent) => {
          captured.push({
            id: event.id,
            type: event.type,
            subject: event.subject,
            at: event.occurredAt,
            audience: event.audience,
          });
        };
        const summary = await relayOutbox(store, workerCtx, {
          dispatcher,
          limit: 100,
        });
        deliveredEvents = [...captured, ...deliveredEvents].slice(0, 50);
        return {
          relayed: summary.relayed.length,
          failed: summary.failed.length,
          deadLettered: summary.deadLettered.length,
        };
      }),

    // A verified inbound provider event: handleWebhook enqueues it (deduped on the event id), then
    // draining the inbox applies it. A redelivery of the same event id is a duplicate that applies
    // nothing, so the top-up posts exactly once.
    postWebhook: ({ eventId, userId, credits: creditsAmount }) =>
      mutate(async () => {
        const event: PurchaseEvent = {
          provider: 'console',
          eventId,
          kind: 'purchase',
          userId,
          amount: credits(creditsAmount),
          source: 'card',
        };
        const ack = await handleWebhook(store, { ids, clock }, event);
        const drained = await drainInbox(store, workerCtx, {
          economy,
          now: clock.now(),
          limit: 100,
        });
        invalidateReadCaches();
        return { status: ack.status, applied: drained.applied.length > 0 };
      }),

    // Serialized with UI mutations (the memory store is a single writer); the solvency cache is
    // dropped after, since a submitted operation may have moved balances.
    httpFetch: (request) =>
      mutate(async () => {
        const response = await createServer(economy)(request);
        invalidateReadCaches();
        return response;
      }),

    // Derived live from the pause window and the clock, so the banner and the ECONOMY_PAUSED gate
    // always agree.
    status: async () => {
      const s = economy.read.status();
      return {
        paused: s.paused,
        pauseStart: s.pauseStart,
        pauseEnd: s.pauseEnd,
        resumesAt: s.resumesAt,
      };
    },

    advanceTime: (ms) => {
      clock.advance(ms);
      // Maturity and the backing check are time-sensitive, and the cache is keyed on the clock, so
      // drop it after a jump rather than trust a snapshot taken at an earlier time.
      invalidateReadCaches();
    },
    now: () => clock.now(),

    // Gate knobs read live from the shared config, so the Controls page never drifts from the next submit.
    settings: () => ({
      faultMode,
      maturityHorizonDays: maturityDays,
      maxPayoutAttempts: maxAttempts,
      velocityLimitCredits: Number(workerCtx.config.velocityLimitMinor) / 100,
      maintenancePaused: economyPaused(clock.now(), workerCtx.config),
      payoutMinimumCredits:
        Number(workerCtx.config.payoutMinimumEarnedMinor) / 100,
      payoutIntervalDays: workerCtx.config.payoutMinIntervalMs / DAY_MS,
      now: clock.now(),
    }),

    setFault: (on) => {
      faultMode = on;
    },

    // createEconomy snapshots config at construction, but the engine and worker hold the config
    // object by reference, so we mutate it in place; the change takes effect on the next submit or
    // worker run, without a rebuild that would lose saga state.
    setMaturityDays: (days) =>
      mutate(async () => {
        maturityDays = Math.max(0, Math.round(days));
        workerCtx.config.maturityHorizonMs = {
          card: 0,
          crypto: 0,
          default: maturityDays * DAY_MS,
        };
      }),

    setMaxAttempts: (n) =>
      mutate(async () => {
        maxAttempts = Math.max(1, Math.round(n));
        workerCtx.config.maxPayoutAttempts = maxAttempts;
      }),

    // Velocity ceiling in credits; the gate compares against minor units.
    setVelocityLimit: (creditsAmount) =>
      mutate(async () => {
        workerCtx.config.velocityLimitMinor = BigInt(
          Math.max(0, Math.round(creditsAmount * 100)),
        );
      }),

    // The rate desk, read live. `inFlightPayouts` is what must reach zero before a change is safe:
    // settlement prices reserved credits at the live rate, so a payout mid-flight would settle wrong.
    rateBoard: async () => {
      const eco = economy;
      const buyPerThousand = rateToPerThousand(rates.buy('CREDIT'));
      const parPerThousand = rateToPerThousand(rates.par('CREDIT'));
      let inFlightPayouts = 0;
      for await (const saga of eco.read.payouts()) {
        if (
          saga.state === 'REQUESTED' ||
          saga.state === 'RESERVED' ||
          saga.state === 'SUBMITTED'
        ) {
          inFlightPayouts++;
        }
      }
      return {
        buyPerThousand,
        parPerThousand,
        payoutPerThousand: parPerThousand,
        spreadPerThousand: buyPerThousand - parPerThousand,
        locked: !ratesUnlocked,
        inFlightPayouts,
        paused: economyPaused(clock.now(), workerCtx.config),
        parFloor: PAR_FLOOR,
        parCeil: PAR_CEIL,
        maxSpreadMultiple: MAX_SPREAD_MULTIPLE,
      };
    },

    // Open the rate desk — only when nothing is mid-settlement — and pause everyday writes for the
    // repricing window, so no new activity is priced against a rate that is about to change.
    unlockRates: () =>
      mutate(async () => {
        const eco = economy;
        let inFlight = 0;
        for await (const saga of eco.read.payouts()) {
          if (
            saga.state === 'REQUESTED' ||
            saga.state === 'RESERVED' ||
            saga.state === 'SUBMITTED'
          ) {
            inFlight++;
          }
        }
        if (inFlight > 0) {
          return {
            ok: false,
            message: `Cannot reprice with ${inFlight} payout${inFlight === 1 ? '' : 's'} in flight — settle or reverse them first, so none settles at the new rate.`,
          };
        }
        workerCtx.config.pauseStartMs = clock.now();
        workerCtx.config.pauseEndMs = clock.now() + DAY_MS;
        ratesUnlocked = true;
        invalidateReadCaches();
        return {
          ok: true,
          message:
            'Rate desk unlocked and everyday writes paused. Set the new rates, then re-lock to resume.',
        };
      }),

    // Apply bounded buy/par (payout follows par) while the desk is open. Par changes re-value backing
    // at the new peg, so the solvency cache is dropped. A fresh value-embedded rateId is minted.
    setRates: ({ buyPerThousand, parPerThousand }) => {
      if (!ratesUnlocked) {
        return {
          ok: false,
          message: 'The rate desk is locked. Unlock it first.',
        };
      }
      if (
        !Number.isFinite(buyPerThousand) ||
        !Number.isFinite(parPerThousand) ||
        buyPerThousand <= 0 ||
        parPerThousand <= 0
      ) {
        return { ok: false, message: 'Both rates must be positive numbers.' };
      }
      if (parPerThousand < PAR_FLOOR || parPerThousand > PAR_CEIL) {
        return {
          ok: false,
          message: `The redemption rate must be between $${PAR_FLOOR.toFixed(2)} and $${PAR_CEIL.toFixed(2)} per 1,000 credits.`,
        };
      }
      if (buyPerThousand < parPerThousand) {
        return {
          ok: false,
          message: 'The buy rate cannot fall below the redemption rate.',
        };
      }
      if (buyPerThousand > parPerThousand * MAX_SPREAD_MULTIPLE) {
        return {
          ok: false,
          message: `The buy rate cannot exceed ${MAX_SPREAD_MULTIPLE}× the redemption rate.`,
        };
      }
      const buy = perThousandToRate(buyPerThousand);
      const par = perThousandToRate(parPerThousand);
      ratesConfig = {
        ...ratesConfig,
        buyRate: buy.rate,
        buyScale: buy.scale,
        parRate: par.rate,
        parScale: par.scale,
        payoutRate: par.rate,
        payoutScale: par.scale,
      };
      rebuildRates();
      invalidateReadCaches();
      return {
        ok: true,
        message: `Rates set — buy $${buyPerThousand.toFixed(2)}, redemption $${parPerThousand.toFixed(2)} per 1,000 credits. Re-lock to resume.`,
      };
    },

    // Re-lock the desk and resume everyday writes.
    lockRates: () =>
      mutate(async () => {
        ratesUnlocked = false;
        workerCtx.config.pauseStartMs = null;
        workerCtx.config.pauseEndMs = null;
        return {
          ok: true,
          message: 'Rate desk locked and everyday writes resumed.',
        };
      }),

    // A one-day maintenance window opening at the current clock, so advancing a day clears it the
    // same way advancing past the maturity horizon clears FUNDS_IMMATURE.
    setMaintenance: (on) =>
      mutate(async () => {
        workerCtx.config.pauseStartMs = on ? clock.now() : null;
        workerCtx.config.pauseEndMs = on ? clock.now() + DAY_MS : null;
      }),

    setPayoutMinimum: (creditsAmount) =>
      mutate(async () => {
        workerCtx.config.payoutMinimumEarnedMinor = BigInt(
          Math.max(0, Math.round(creditsAmount * 100)),
        );
      }),

    setPayoutIntervalDays: (days) =>
      mutate(async () => {
        workerCtx.config.payoutMinIntervalMs =
          Math.max(0, Math.round(days)) * DAY_MS;
      }),

    reset: () =>
      mutate(async () => {
        faultMode = false;
        maturityDays = 0;
        maxAttempts = 5;
        opSeq = 0;
        invalidateReadCaches();
        await rebuild();
        await seed();
      }),

    clear: () =>
      mutate(async () => {
        faultMode = false;
        maturityDays = 0;
        maxAttempts = 5;
        opSeq = 0;
        invalidateReadCaches();
        await rebuild();
      }),

    runJobs: () =>
      mutate(async () => {
        const { batch } = await runWorkerOnce();
        // Worker postings move money, so the cached solvency figure is stale.
        invalidateReadCaches();
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
      }),

    close: () => economy.close(),
  };

  await rebuild();
  await seed();
  return api;
}
