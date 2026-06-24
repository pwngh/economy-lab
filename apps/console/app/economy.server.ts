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

// We wire createEconomy + createWorker by hand rather than using compose()/composeWorker(), so the
// economy and worker share one store (see rebuild()).
import {
  createEconomy,
  memoryStore,
  spendable,
  earned,
  promo,
  SYSTEM,
} from '#src/index.ts';

import { createWorker } from '#src/worker/index.ts';
import { systemSigner, jsonlLogger, systemDigest } from '#src/runtime.ts';
import { flatFee } from '#src/pricing.ts';
import { toAmount } from '#src/money.ts';
import { currency } from '#src/accounts.ts';
import { fault, ERROR_CODES } from '#src/errors.ts';
import { loadConfig as loadConfigImpl } from '#src/config.ts';
import { configuredRates } from '#src/adapters/rates.ts';

import type { AccountRef } from '#src/accounts.ts';

import type {
  Economy,
  Operation,
  Outcome,
  ProveReport,
  Capabilities,
} from '#src/index.ts';
// WorkerCtx lives in contract.ts (not re-exported from the root index), so import it from there.
import type { WorkerCtx } from '#src/contract.ts';
import type {
  Clock,
  Ids,
  Digest,
  Leg,
  Posting,
  Saga,
  Store,
} from '#src/ports.ts';
import type { Worker } from '#src/worker/index.ts';
import type { Amount } from '#src/money.ts';

// --- Public view types: render-ready shapes the pages receive ---

// Everything the ledger feed can show. The first four are user operations; the rest are postings
// the background worker makes (payout settled/reversed, cash leg, fee sweep, promo expiry). `other`
// is the catch-all for any future worker posting.
export type TxnKind =
  | 'topUp'
  | 'spend'
  | 'requestPayout'
  | 'grantPromo'
  | 'payoutSettled'
  | 'payoutReversed'
  | 'payoutCash'
  | 'feeSweep'
  | 'promoExpiry'
  | 'other';

// One leg of a posting, ready to render.
export interface LegView {
  account: string;
  label: string;
  side: 'debit' | 'credit';
  amount: string; // already formatted with a leading sign, e.g. "+50.00"
  currency: string;
}

// One recorded transaction, ready for the ledger feed.
export interface TxnView {
  id: string;
  at: number;
  kind: TxnKind;
  label: string;
  paymentType: string;
  listing: string;
  priceCredits: number;
  // Currency of the headline amount. Most postings are credits; a payout's cash leg is USD.
  priceCurrency: 'CREDIT' | 'USD';
  buyer: string;
  seller: string;
  legs: LegView[];
  // Plain-English note for postings whose legs don't explain themselves (mostly worker postings).
  // Empty for ordinary user operations.
  note?: string;
  // The payout saga this posting belongs to, if any; lets the feed link back to the payout board.
  sagaId?: string;
  // Sum of all the legs; 0 when the transaction balances.
  balancedTo: number;
}

// One user's three credit balances, plus their total. "Purchased" credits were bought with cash;
// "earned" credits are a seller's revenue from sales; "promotional" credits are marketing grants.
export interface WalletView {
  userId: string;
  purchased: number;
  earned: number;
  promotional: number;
  total: number;
}

// Result of the engine's integrity check ("prove"): which properties currently hold.
export interface ProveView {
  conserved: boolean;
  backed: boolean;
  noOverdraft: boolean;
  chainIntact: boolean;
  consistent: boolean;
  shortfallUsd: number;
  driftCount: number;
  allGreen: boolean;
}

// Whether real cash on hand covers what the platform owes users. Trust cash is the USD held in
// reserve to back spendable credits.
export interface SolvencyView {
  userCredits: number;
  backed: boolean;
  shortfallUsd: number;
  trustCashUsd: number;
  purchased: number;
  earned: number;
  promotional: number;
}

// One of the platform's own "house" ledger accounts, for the Overview's platform balances.
export interface PlatformAccountView {
  key: string;
  label: string;
  sublabel: string;
  value: number;
  currency: 'CREDIT' | 'USD';
}

// One payout, as a card on the board. A payout runs as a "saga": one request tracked across several
// steps over time (reserve the credits, hand them to the payment provider, then settle, or give up).
export interface PayoutView {
  id: string;
  userId: string;
  // Seller's credits set aside when the payout was requested.
  reserveCredits: number;
  state: Saga['state'];
  providerRef: string | null;
  // Times the worker has tried to advance this payout. Raised on both success and failure, so a
  // provider that stays down climbs to the cap and the payout is abandoned.
  attempts: number;
  dueAt: number;
  // Set at a terminal state, read back from the worker's ledger postings: failure reason (FAILED)
  // or USD disbursed (SETTLED). Null while in flight.
  reason: string | null;
  payoutUsd: number | null;
}

// The current state of the simulation controls, for the Simulation panel to render.
export interface SimSettings {
  faultMode: boolean;
  maturityHorizonDays: number;
  maxPayoutAttempts: number;
  now: number;
}

// --- constants ---------------------------------------------------------------------

// Amounts are stored as whole "minor units" to stay exact (no floating-point rounding). One credit
// is 100 minor units, the same way one dollar is 100 cents.
const SCALE = 100;
const DAY_MS = 86_400_000;

// The human label shown for each kind of operation in the ledger feed.
const LABELS: Record<TxnKind, string> = {
  topUp: 'Deposit',
  spend: 'Purchase',
  requestPayout: 'Payout',
  grantPromo: 'Promotional grant',
  payoutSettled: 'Payout settled',
  payoutReversed: 'Payout reversed',
  payoutCash: 'Payout cash-out',
  feeSweep: 'Fee sweep',
  promoExpiry: 'Promo expired',
  other: 'Ledger posting',
};

// Turn a raw failure code into a short human phrase. Unknown codes fall back to a tidied version
// of the code itself.
function humanReason(code: string): string {
  const known: Record<string, string> = {
    [ERROR_CODES.PROVIDER_FAILURE]: 'provider failure',
    'payout.timeout': 'provider timeout',
  };
  return known[code] ?? code.replace(/[._]/g, ' ').toLowerCase();
}

// Readable title for a background posting kind the feed doesn't word specially. A trailing ".cash"
// becomes a "(cash)" suffix; the rest becomes spaced, sentence-cased words.
function humanizeKind(kind: string): string {
  if (!kind) {
    return 'Background posting';
  }
  const cash = kind.endsWith('.cash');
  const base = (cash ? kind.slice(0, -'.cash'.length) : kind)
    .replace(/[._]/g, ' ')
    .trim();
  const titled = base.charAt(0).toUpperCase() + base.slice(1);
  return cash ? `${titled} (cash)` : titled;
}

// Friendly names for the platform's internal accounts, so the ledger never shows a raw account id.
const ACCOUNT_LABELS: Record<string, string> = {
  'vrchat:stored_value': 'Stored value (spendable credits in circulation)',
  'vrchat:revenue': 'Platform revenue',
  'vrchat:held': 'Escrow (funds held until a sale completes)',
  'vrchat:payout_reserve':
    'Payout reserve (credits set aside for a pending payout)',
  'vrchat:promo_float': 'Promotional float (credits granted, not yet spent)',
  'vrchat:trust_cash': 'Trust cash (USD backing user credits)',
  'vrchat:receivable': 'Receivable (money owed to the platform)',
  'vrchat:usd_clearing': 'USD clearing (cash in transit to or from the bank)',
  'vrchat:opening_equity': 'Opening equity (starting balance)',
};

// The platform's own ledger accounts shown on the Overview, in reading order; read live by
// platformAccounts() below. (Receivable and opening-equity are omitted: they stay at zero in the
// demo flow.)
const PLATFORM_ACCOUNTS: {
  key: string;
  account: AccountRef;
  label: string;
  sublabel: string;
}[] = [
  {
    key: 'storedValue',
    account: SYSTEM.STORED_VALUE,
    label: 'Stored value',
    sublabel: 'Spendable credits in circulation',
  },
  {
    key: 'reserve',
    account: SYSTEM.PAYOUT_RESERVE,
    label: 'Payout reserve',
    sublabel: 'Credits set aside for pending payouts',
  },
  {
    key: 'promoFloat',
    account: SYSTEM.PROMO_FLOAT,
    label: 'Promotional float',
    sublabel: 'Granted promo credits not yet spent',
  },
  {
    key: 'revenue',
    account: SYSTEM.REVENUE,
    label: 'Platform revenue',
    sublabel: 'Fees awaiting the periodic treasury sweep',
  },
  {
    key: 'trustCash',
    account: SYSTEM.TRUST_CASH,
    label: 'Trust cash',
    sublabel: 'Real USD held to back user credits',
  },
  {
    key: 'usdClearing',
    account: SYSTEM.USD_CLEARING,
    label: 'USD clearing',
    sublabel: 'Cash in transit to or from the bank',
  },
];

function credits(n: number): Amount {
  return toAmount('CREDIT', BigInt(Math.round(n * SCALE)));
}

function toCredits(a: Amount): number {
  return Number(a.minor) / SCALE;
}

// Readable label for an account id. Platform accounts have fixed names (above); a user account
// "<userId>:<kind>" is split into "<userId> · <Kind>".
function accountLabel(account: string): string {
  if (ACCOUNT_LABELS[account]) {
    return ACCOUNT_LABELS[account];
  }
  const colon = account.lastIndexOf(':');
  const user = colon >= 0 ? account.slice(0, colon) : account;
  const kind = colon >= 0 ? account.slice(colon + 1) : '';
  const kindLabel =
    kind === 'spendable'
      ? 'Purchased'
      : kind === 'earned'
        ? 'Earned'
        : kind === 'promo'
          ? 'Promotional'
          : kind;
  return `${user} · ${kindLabel}`;
}

// A clock the simulation controls. Time only advances when the panel advances it; the economy,
// store, and worker all share this one clock object.
function makeClock(): Clock & {
  advance: (ms: number) => void;
  set: (t: number) => void;
} {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

// Demo config, as the engine reads it (env vars). Most limits are relaxed so the everyday flow
// always goes through. The maturity horizon is the one knob the demo exercises: only the default
// horizon is raised (the one earned credits fall under), so card/crypto clear at once and only
// payouts are gated.
function demoEnv(
  maturityDays: number,
  maxAttempts: number,
): Record<string, string> {
  return {
    WEBHOOK_SECRET: 'console',
    SIGNING_SECRET: 'console',
    REPLAY_WINDOW_MS: String(5 * 60_000),
    MAX_PAYOUT_ATTEMPTS: String(maxAttempts),
    PLATFORM_FEE_BPS: '1530', // ~15.3%, VRChat's real marketplace transaction fee
    VELOCITY_LIMIT_MINOR: String(100_000_000),
    VELOCITY_WINDOW_MS: String(60 * 60_000),
    MATURITY_HORIZON_CARD_MS: '0',
    MATURITY_HORIZON_CRYPTO_MS: '0',
    MATURITY_HORIZON_DEFAULT_MS: String(maturityDays * DAY_MS),
    SLA_PENDING_MS: String(30_000),
    SLA_SUBMITTED_MS: String(120_000),
    SLA_DEFAULT_MS: String(60_000),
    PAYOUT_MIN_EARNED_MINOR: '0',
    PAYOUT_MIN_INTERVAL_MS: '0',
    MAX_OUTBOX_ATTEMPTS: '10',
    MAX_SUBSCRIPTION_ATTEMPTS: '10',
    MAX_PAYOUT_AGE_MS: String(86_400_000),
    ...(process.env.DATABASE_URL
      ? { DATABASE_URL: process.env.DATABASE_URL }
      : {}),
  };
}

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
  let storeRef: Store;
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
  // state — compose()/composeWorker() would each pick their own store, leaving the worker blind to
  // the economy's sagas. selectStore (below) mirrors compose()'s selection logic. The injected
  // clock/ids/digest/processor/rates/signer let the demo drive the engine deterministically.
  async function rebuild(): Promise<void> {
    idSeq = 0;
    clock.set(0);
    sagaIds = [];
    mintedTxnIds = [];
    capturedTxnIds = new Set<string>();
    sagaInfo = new Map<string, { reason?: string; usd?: number }>();

    const env = demoEnv(maturityDays, maxAttempts);
    const config = loadConfigImpl(env);

    const store = await selectStore(env);
    storeRef = store;

    const caps: Capabilities = {
      store,
      clock,
      ids,
      digest,
      signer,
      processor,
      rates,
      logger,
      meter,
      pricing: flatFee(),
      config,
    };
    economy = createEconomy(caps);

    workerCtx = {
      clock,
      ids,
      digest,
      signer,
      processor,
      rates,
      logger,
      meter,
      config,
    };
    workerRef = createWorker(store, workerCtx);
  }

  // Pick the store from env the way compose() does. memoryStore by default; pg/mysql when
  // DATABASE_URL is set, with the driver imported only then.
  async function selectStore(
    env: Record<string, string | undefined>,
  ): Promise<Store> {
    const url = env.DATABASE_URL;
    if (url === undefined || url === '') {
      return memoryStore({ digest, clock });
    }
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      const { postgresStore } = await import('#src/engines/postgres.ts');
      return postgresStore({ url, digest });
    }
    if (url.startsWith('mysql://')) {
      const { createMysqlPool, mysqlStore } =
        await import('#src/engines/mysql.ts');
      const pool = await createMysqlPool(url);
      return mysqlStore({ pool, digest, clock });
    }
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'DATABASE_URL must be a postgres:// or mysql:// DSN.',
    );
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
    const sagaUser = sagaId
      ? (await storeRef.sagas.load(sagaId))?.userId
      : null;
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
      const posting = await storeRef.ledger.posting(id);
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
        const saga = await storeRef.sagas.load(id);
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
