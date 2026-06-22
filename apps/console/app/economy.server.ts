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
 * economy.server.ts — the bridge between the web UI and the real economy-lab engine.
 *
 * Its job: give the page loaders and form actions one simple set of functions to read from and
 * write to the engine, while keeping the engine (and its database wiring) entirely on the server.
 *
 * The engine runs HERE, on the Node server, not in the browser — the project calls this "remote
 * mode". The `.server` suffix is a React Router rule: a module named `*.server.ts` is never sent to
 * the browser, so the database and crypto code it pulls in stays server-side. Page loaders read
 * through the functions below; form actions call the ones that change state.
 *
 * What this file exposes (the "console facade"): the four operations a user can record
 * (deposit / purchase / request a payout / grant promotional credits); read views the pages render
 * (wallet balances, the ledger feed, the integrity report, a solvency summary); a live payout board
 * (every payout's saga is loaded straight from the store — see below for what a "saga" is); and the
 * simulation controls (advance the clock, run the background worker, simulate a payment-provider
 * outage, change settings, reset or clear the demo).
 *
 * Two deliberate design choices:
 *
 *  1. All state lives in a single long-lived object on the server (a module singleton). Because it
 *     is not in the browser page, a browser refresh keeps everything — there is no client-side log
 *     of actions to replay. "Reset" rebuilds the engine and re-seeds the demo; "Clear" rebuilds it
 *     empty.
 *  2. The data store is chosen from an environment variable: an in-memory store by default, or a
 *     real Postgres/MySQL database when DATABASE_URL is set. Running against a real database is the
 *     same engine with real database adapters, and it keeps its data across server restarts.
 *
 * The engine is imported by relative path from the frozen project source (`../../../src/index.ts`).
 * Vite compiles that TypeScript for the server, and the engine's core is written to run on the
 * server unchanged. The database driver is loaded only when DATABASE_URL is set, so the default
 * in-memory path pulls in nothing extra.
 */

// Why this file wires the engine by hand instead of calling the library's one-shot host helpers
// (compose / composeWorker): each of those helpers builds its OWN data store from the environment,
// and a fresh in-memory store is created on every call. This app needs the economy AND the
// background worker to share ONE store, so the worker can see the payouts the economy created. If
// we called the two helpers separately they would each get a different, empty store and never see
// each other's data. So we reuse the helpers' store-selection rule (selectStore below copies it
// from src/index.ts), pick the store once, and wire both sides over that single store through the
// public createEconomy / createWorker entry points.
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

// --- Public view types: the plain, render-ready shapes the pages receive --------------

// Everything the ledger feed can show. The first four are the operations a user records directly
// (a top-up — buying credits with cash; a spend — a purchase; a payout request — cashing earned
// credits out to real money; and a promotional grant). The rest are postings the BACKGROUND WORKER
// makes on its own as payouts and promos run their course — a payout settling, a failed payout
// returning its reserve to the seller, the cash leaving trust on a settlement, an expired promo
// being reclaimed. The engine records these as real ledger transactions; the feed surfaces them so
// the books shown here match the books the engine keeps. `other` is the catch-all for any future
// worker posting, so nothing is ever silently dropped from the feed.
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

// One line of a double-entry posting, ready to show. Every posting has at least two lines that
// cancel out: a "debit" line and a "credit" line of equal size, so the books always balance.
export interface LegView {
  account: string;
  label: string;
  side: 'debit' | 'credit';
  amount: string; // already formatted with a leading sign, e.g. "+50.00"
  currency: string;
}

// One recorded transaction, ready for the ledger feed: what kind it was, when, who was involved,
// and the lines that make it up.
export interface TxnView {
  id: string;
  at: number;
  kind: TxnKind;
  label: string;
  paymentType: string;
  listing: string;
  priceCredits: number;
  // The currency the headline amount is in. Most postings move credits; a payout's cash leg moves
  // USD. The feed renders the amount with the matching unit (Cr / $) so the column never lies.
  priceCurrency: 'CREDIT' | 'USD';
  buyer: string;
  seller: string;
  legs: LegView[];
  // A plain-English note for postings whose meaning isn't obvious from the legs alone — chiefly the
  // worker's own postings (why a payout reversed, what a settlement did). Empty for the everyday
  // user operations, whose legs already tell the whole story.
  note?: string;
  // The payout saga this posting belongs to, when it is one — lets the feed link a row back to the
  // payout board.
  sagaId?: string;
  // The sum of all the lines. It is 0 when the transaction balances (every debit matched by an
  // equal credit); any other number would mean money was created or lost, which never happens.
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

// The result of the engine's integrity check ("prove"): for each property the books are meant to
// hold, whether it currently holds. See the Integrity page for what each property means.
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

// A summary of whether real cash on hand covers what the platform owes its users. "Trust cash" is
// real USD the platform holds in reserve to back the credits users can spend.
export interface SolvencyView {
  userCredits: number;
  backed: boolean;
  shortfallUsd: number;
  trustCashUsd: number;
  purchased: number;
  earned: number;
  promotional: number;
}

// One of the platform's own "house" ledger accounts, for the Overview's platform balances: the
// credits the platform has issued, set aside, or earned, and the real USD it holds. These are the
// counterparts to users' wallets — read straight from the ledger, the same numbers the books keep.
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
  // The seller's credits set aside the moment the payout was requested, waiting to be paid out.
  reserveCredits: number;
  state: Saga['state'];
  providerRef: string | null;
  // How many times the worker has tried to push this payout to its next step. The engine raises
  // this on both a successful AND a failed provider submit, so a provider that stays down climbs to
  // the cap and the payout is given up on (see runJobs / the Payouts page).
  attempts: number;
  dueAt: number;
  // Set once the saga reaches a terminal state, read back from the worker's own ledger postings
  // (the saga itself doesn't retain them): the failure reason for a FAILED payout, and the USD
  // actually disbursed for a SETTLED one. Null while the payout is still in flight.
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

// Turn a raw failure code (as the engine records it in a dead-letter posting's metadata) into a
// short human phrase for the feed and the payout board. Unknown codes fall back to a tidied form of
// the code itself, so a new failure mode still reads sensibly rather than as a raw constant.
function humanReason(code: string): string {
  const known: Record<string, string> = {
    [ERROR_CODES.PROVIDER_FAILURE]: 'provider failure',
    'payout.timeout': 'provider timeout',
  };
  return known[code] ?? code.replace(/[._]/g, ' ').toLowerCase();
}

// Make a readable title out of a posting's raw metadata kind, for any background posting the feed
// doesn't give bespoke wording (e.g. a treasury fee sweep). A trailing ".cash" — the USD companion
// many movements post — becomes a "(cash)" suffix; the rest becomes spaced, sentence-cased words.
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
// These are the platform-wide accounts that money flows through (as opposed to a user's own wallet).
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

// The platform's own ledger accounts shown on the Overview, in reading order: what the platform has
// issued and owes, what it has set aside, what it has earned, and the real cash behind it all. Each
// is read live from the ledger by `platformAccounts()` below. (Receivable and opening-equity are
// left off — they stay at zero in the normal demo flow and would only add noise.)
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

// Turn an account id into a readable label. A platform account has a fixed name (see above). A
// user account is written as "<userId>:<kind>" — for example "usr_nova:earned" — so we split off
// the kind and show it as "<userId> · Earned".
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

// A clock the simulation controls. Time does not advance on its own — it only moves when the
// Simulation panel advances it — so the demos play out the same way every time. The economy, the
// store, and the background worker all share this one clock object, so advancing it is seen
// everywhere at once.
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

// The configuration for the demo, expressed the way the engine reads it: as environment variables.
// Most limits are relaxed so the everyday flow always goes through. The one knob the demo plays
// with is the "maturity horizon" — a waiting period before earned credits can be cashed out (it
// models the delay before a sale is final enough to pay out on). Only the `default` horizon is
// raised, because that is the one a seller's earned credits fall under; the card and crypto
// horizons stay at 0, so deposits and purchases always clear and only the payout side is gated.
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

  // Every payout id the engine mints, recorded by the id generator below. The payout board uses
  // this list to load each saga from the store and show it as a card. Cleared on every rebuild.
  let sagaIds: string[] = [];

  // Every ledger transaction id the engine mints (prefix "txn"), recorded by the id generator
  // below — both the ones a user operation produces AND the ones the background worker produces on
  // its own. `capturedTxnIds` marks the ones already in the feed (user operations, recorded inline);
  // after each worker run we read back any minted-but-not-yet-captured ids straight from the ledger
  // (see captureWorkerPostings) so settlements and failure reversals appear in the feed too. Both
  // are cleared on every rebuild.
  let mintedTxnIds: string[] = [];
  let capturedTxnIds = new Set<string>();

  // What became of each payout once it reached a terminal state, harvested from the worker's own
  // ledger postings (the saga record itself keeps neither): the failure reason for a reversal and
  // the USD disbursed for a settlement. The payout board reads this to caption its cards.
  let sagaInfo = new Map<string, { reason?: string; usd?: number }>();

  // The SHA-256 hashing service the engine uses to seal ledger entries — the engine's own default
  // hasher (Web Crypto SHA-256), reused here so the console hashes exactly as the engine does.
  const digest: Digest = systemDigest();

  // The id generator. It mints ids like "txn_1", "pay_2", and also records every payout id (the
  // "pay_" ones) into sagaIds, so the payout board can later load each one from the store.
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

  // A stand-in for the outside payment provider (the demo calls it Tilia), with an outage switch.
  // When the "Tilia down" toggle is on, every attempt to send a payout throws a retryable failure —
  // exactly the kind of error the worker is built to handle: it retries, then, once a payout has
  // failed too many times, gives up on it and returns the set-aside credits to the seller. When the
  // toggle is off, it returns a fake provider reference for the payment. The switch is read live, so
  // flipping it takes effect on the very next worker run without rebuilding the engine.
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

  // Exchange rates, set to VRChat's published Creator Economy model rather than a 1:1 placeholder.
  // `par` is what one credit is worth in USD when checking that real cash backs spendable credits:
  // $0.01, so 100 credits = $1. `payout` is the less favourable rate earned credits cash out at:
  // $0.005, so 200 credits = $1. The gap between the two is the platform's cut, about 50%.
  const rates = configuredRates({
    parRate: 1n,
    parScale: 2,
    payoutRate: 5n,
    payoutScale: 3,
  });

  // The key the engine uses to sign ledger checkpoints (a fixed demo key — never a real secret).
  const signer = systemSigner({
    signingKey: '00112233445566778899aabbccddeeff',
  });

  // A logger that throws its output away, so the dev terminal isn't flooded by background diagnostic
  // lines (the demo injects faults on purpose, which would otherwise log on every worker run). We
  // still use the library's real logger type rather than an empty stub, to match how production runs.
  const logger = jsonlLogger({ out: () => {}, err: () => {} });
  // A metrics sink that throws its output away — the demo doesn't collect metrics.
  const meter = { count: () => {}, observe: () => {} };

  // Build (or rebuild) the engine + worker over ONE env-selected store, so both read identical
  // state. memoryStore by default; a real pg/mysql adapter when DATABASE_URL is set ("remote mode
  // = real adapters on the server"). The controllable clock, the id-capturing ids, the SHA-256
  // digest, and the toggleable processor/rates/vault/signer are injected so the demos drive the
  // engine deterministically.
  //
  // Why not call the library's compose()/composeWorker() directly here? Each of them selects its
  // OWN store from env, and the memory store is a fresh instance per call — so composing the
  // economy and the worker separately would hand them two different (empty) stores, and the worker
  // would never see the economy's sagas. We use compose()'s own selection LOGIC (mirrored in
  // selectStore below, identical to src/index.ts) to pick the store once, then wire BOTH the
  // economy (via createEconomy, the public entry point that takes the full Capabilities) and the
  // worker (via createWorker) over that single instance. compose()/composeWorker() stay imported
  // and remain the right call for a single-purpose host; this app needs the shared-store assembly.
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

  // Build the env-selected store exactly as compose() does (mirrors selectStore in src/index.ts),
  // so the economy and the worker share one instance. memoryStore by default; pg/mysql when
  // DATABASE_URL is set — and the driver is imported ONLY then, so the default path pulls in
  // nothing extra.
  async function selectStore(
    env: Record<string, string | undefined>,
  ): Promise<Store> {
    const url = env.DATABASE_URL;
    if (url === undefined || url === '') {
      return memoryStore({ digest, clock });
    }
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      const { postgresStore } = await import('#src/adapters/postgres.ts');
      return postgresStore({ url, digest });
    }
    if (url.startsWith('mysql://')) {
      const { createMysqlPool, mysqlStore } =
        await import('#src/adapters/mysql.ts');
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

  // Turn a posting's raw legs into the render-ready leg views the feed shows: each line labelled,
  // tagged debit or credit (a debit carries a positive minor amount), and signed for display.
  // Shared by user operations (record) and worker postings (viewFromPosting) so both read alike.
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

  // The sum of a posting's lines in minor units. 0 means the posting balances; anything else would
  // mean money was created or lost (it never is).
  function balanceOf(legs: ReadonlyArray<Leg>): number {
    return legs.reduce((sum, leg) => sum + Number(leg.amount.minor), 0);
  }

  // The monotonic sequence number inside a "txn_N" id — the order the engine committed it, used to
  // sort the feed newest-first regardless of when each row was added.
  function txnSeq(id: string): number {
    const n = Number(id.slice(id.lastIndexOf('_') + 1));
    return Number.isFinite(n) ? n : 0;
  }

  // The first user account a posting touches (a "<user>:<kind>" account, not a "vrchat:" platform
  // account), so a worker posting can name the user it concerns. Null when it touches none.
  function userInLegs(legs: ReadonlyArray<Leg>): string | null {
    for (const leg of legs) {
      if (!leg.account.startsWith('vrchat:')) {
        const colon = leg.account.lastIndexOf(':');
        return colon >= 0 ? leg.account.slice(0, colon) : leg.account;
      }
    }
    return null;
  }

  // Record a committed user operation into the ledger feed, and mark its transaction id captured so
  // the worker-posting sweep below doesn't add it a second time.
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

  // Build a feed row from a posting the background worker made on its own (a payout settling or
  // failing, an expired promo reclaimed). Read straight from the stored posting, so the amounts and
  // legs are the engine's own — not reconstructed — and given a plain-English note explaining what
  // the posting did, which the legs alone don't convey. Returns the seller/user the posting concerns.
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
    // The USD companion of a settlement. Normally folded into its settle row by the capture step
    // (see mergeCashInto); this stands alone only if that pairing ever misses, so it's never lost.
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
    // Any other background posting the worker makes. Surfaced rather than hidden (the ledger is meant
    // to be complete), with a humanized title and a system-side detail line, since these move
    // platform money between platform accounts, not a user's.
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

  // Fold a USD "*.cash" posting into the event it completes, so a settlement (or a fee sweep) reads
  // as ONE feed row whose expansion shows both the credit side and the cash side — instead of two
  // near-identical rows. The headline amount stays the credit figure; the cash amount goes into the
  // note (and, for a settled payout, into the payout board's "paid" caption).
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

  // After a worker run, pull the ledger transactions the worker just made — and only those — into
  // the feed (a payout settling, a failed payout returning its reserve, a treasury fee sweep).
  // `fromIndex` is where the txn-id list stood before the run, so the sweep sees exactly the ids the
  // run minted: it never re-walks earlier transactions, and it never surfaces the *secondary*
  // postings of a user operation (e.g. a deposit's USD cash leg), which record() leaves out on
  // purpose to keep one row per user action. A "*.cash" posting is merged into the event it just
  // completed rather than shown on its own. Each new posting is read back as the engine committed
  // it, then the feed is re-sorted newest-first by commit order.
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

  // Run every background job once and return the per-job batch summary (which job ran, and what
  // it acted on). runJobs() folds this into the one-line note the Simulation panel shows. The
  // payout board doesn't read this summary — it loads each saga's own attempt count from the
  // store (see payouts() and PayoutView.attempts), which the engine's worker raises on every
  // failed retryable submit.
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

  // Seed a demo economy that has already LIVED a little, so the ledger shows the full real-world
  // lifecycle on first load — not just the operations a user types, but everything the background
  // worker does in production: payouts settling (the credit + the USD cash legs), the treasury
  // sweeping its marketplace fees, and a provider outage forcing a payout to reverse its reserve
  // back to the seller. The board ends with a mix of settled, failed, and in-flight payouts, and
  // the clock a couple of days in. Amounts are taken as fractions of the seller's ACTUAL earned
  // balance (read back from the ledger), so the script can't outrun what a seller has to cash out.
  async function seed(): Promise<void> {
    // Day 0 — the everyday operations. At the demo's par rate a credit is worth $0.01, so the two
    // deposits put $80 of real cash into trust; purchases are priced like real marketplace items and
    // leave the two sellers (nova, pixel) with earned credits to cash out.
    await api.deposit({ userId: 'usr_alice', credits: 5000 }); // a $50 credit bundle
    await api.deposit({ userId: 'usr_bjorn', credits: 3000 }); // a $30 credit bundle
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

    // Two payouts that go all the way through. Request both, then run the worker twice with a day in
    // between: the first run hands them to the provider (RESERVED → SUBMITTED), the second settles
    // them (SUBMITTED → SETTLED), posting the reserve→revenue credit leg, the trust→bank USD cash
    // leg, and triggering the treasury fee sweep — exactly the postings a real settlement makes.
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

    // A payout that fails. With the provider down and the retry cap at 1, the next run abandons it
    // and reverses the reserve back to nova's earned balance — the failure path, on the ledger.
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

    // One more payout left mid-flight (RESERVED), so the board isn't all terminal — the user can run
    // the jobs themselves and watch it move.
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

    // The platform's own account balances, read live from the ledger. Shown as magnitudes (each
    // account has a natural side — trust cash is held as a positive figure, revenue accrues on the
    // credit side — and the Overview reads as "how much sits in each account", not signed postings).
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

    // A knob change to maturity/attempts means a new config. Because createEconomy snapshots
    // config at construction, the simplest honest path is to rebuild the engine and replay the
    // recorded ledger feed back in — but that loses saga state. Instead we mutate the live config
    // object in place (the running engine and worker both hold it by reference), exactly like the
    // in-browser console does, so the change takes effect on the next submit / worker run.
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
      // Mark where the minted-txn list stands, so the capture below sees only the postings THIS
      // run creates (settlements, failure reversals) and not any earlier secondary postings.
      const fromIndex = mintedTxnIds.length;
      const batch = await runWorkerOnce();
      // The worker just posted any settlements / failure reversals straight to the ledger; fold
      // those new postings into the feed so the Ledger page reflects what the run did.
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

// --- module singleton --------------------------------------------------------------

// The facade is built once per server process and reused across requests, so state survives a
// browser refresh for free (it lives here, not in the page). A `globalThis` slot keeps the single
// instance across Vite dev hot-reloads of this module, so an HMR update doesn't silently re-seed.
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
