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

// Presentation layer for the console: the render-ready view shapes the pages receive, plus the pure
// functions that map raw ledger/engine data into them. No engine state lives here — economy.ts
// holds the live economy and calls into these.

import { SYSTEM } from '#src/accounts.ts';
import { ERROR_CODES } from '#src/errors.ts';
import { toAmount } from '#src/money.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Amount } from '#src/money.ts';
import type { Saga } from '#src/ports.ts';

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
  // Every account whose cached balance disagrees with the one re-added from its legs, with both
  // figures, so the gap's size and direction render beside the flag.
  drift: { account: string; cachedCredits: number; derivedCredits: number }[];
  allGreen: boolean;
}

// Whether real cash on hand covers what the platform owes users. Trust cash is the USD held in
// reserve to back spendable credits.
export interface SolvencyView {
  userCredits: number;
  backed: boolean;
  // USD that trust cash must cover: the custodial (purchased) credits valued at par.
  backingUsd: number;
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
  // Set at a terminal state: failure reason (FAILED) or USD disbursed (SETTLED). Null while in
  // flight.
  reason: string | null;
  payoutUsd: number | null;
}

// The current state of the simulation controls, for the topbar clock, Controls page, and the market page's
// gate controls to render. The gate knobs are read live from the engine config, so they never
// drift from what the next submit will see.
export interface SimSettings {
  faultMode: boolean;
  maturityHorizonDays: number;
  maxPayoutAttempts: number;
  velocityLimitCredits: number;
  maintenancePaused: boolean;
  payoutMinimumCredits: number;
  payoutIntervalDays: number;
  now: number;
}

// The treasury's rate desk: the live rates (USD per 1,000 credits) plus the state that governs a
// change. Repricing is a locked operation — you unlock only when the economy is quiesced (no payout
// in flight), which pauses everyday writes; the new rates are bounded; re-locking resumes.
export interface RateBoard {
  buyPerThousand: number;
  parPerThousand: number;
  payoutPerThousand: number;
  spreadPerThousand: number;
  locked: boolean;
  // Payouts that would settle at the new rate if repriced now (RESERVED/SUBMITTED); must be 0.
  inFlightPayouts: number;
  paused: boolean;
  // The band a new rate may be set within, in USD per 1,000 credits.
  parFloor: number;
  parCeil: number;
  maxSpreadMultiple: number;
}

// The economy's live pause state, for the maintenance banner. Times are simulated-clock epochs.
export interface StatusView {
  paused: boolean;
  pauseStart: number | null;
  pauseEnd: number | null;
  resumesAt: number | null;
}

// The tally of a try-to-break-it burst: how many of `attempts` concurrent spends committed, how
// many the ledger refused as duplicates or short of funds, and how far the balance actually moved.
export interface RaceResult {
  attempts: number;
  committed: number;
  duplicates: number;
  insufficient: number;
  // Any refusal that is neither a duplicate nor a funds shortfall — e.g. a gate the visitor armed
  // before the burst. Counted so committed + refusals always sums to attempts.
  other: number;
  movedCredits: number;
}

// --- Ledger explorer drill: statement -> posting -> hash chain -> checkpoint ---

// One entry of an account's statement: the posting that touched it and by how much.
export interface StatementEntry {
  txnId: string;
  credits: number;
  at: number;
}

// An account, its current balance, its label, and the postings that touched it.
export interface StatementView {
  account: string;
  label: string;
  balance: number;
  currency: 'CREDIT' | 'USD';
  entries: StatementEntry[];
}

// One link of an account's tamper-evident hash chain: the posting, the head hash before and after,
// and this account's net movement in it. `prevHash` of the first is the fixed genesis.
export interface LineageLink {
  txnId: string;
  prevHash: string;
  hash: string;
  credits: number;
}

// The latest signed checkpoint: the Merkle root over every account head, its signature, and the
// count of heads it covers.
export interface CheckpointView {
  root: string;
  signature: string;
  count: number;
  at: number;
  v: number;
}

// A ledger-search hit: what a query (txn id, account, chain hash, Merkle root, or checkpoint
// signature) resolved to, and where the explorer should drill.
export type FindHit =
  | { kind: 'txn'; txnId: string }
  | { kind: 'account'; account: string; txnId: string }
  | { kind: 'link'; txnId: string; account: string; field: 'hash' | 'prevHash' }
  | {
      kind: 'checkpoint';
      field: 'root' | 'signature';
      checkpoint: CheckpointView;
    };

// One subscription this tab opened, re-read live from the store, so the renewal sweep shows up
// as state and next-due changes.
export interface SubscriptionView {
  id: string;
  userId: string;
  sellerId: string;
  sku: string;
  priceCredits: number;
  periodDays: number;
  period: number;
  state: 'ACTIVE' | 'LAPSED' | 'CANCELED';
  nextDueAt: number;
}

// One payout saga drilled open: the card and every ledger posting that carries its saga id.
export interface SagaDetail {
  saga: PayoutView;
  postings: TxnView[];
  // Whether the saga can still be reversed (RESERVED or SUBMITTED; a terminal saga cannot).
  reversible: boolean;
  // The posting scan hit its bound, so the list may be partial (a large ledger only).
  truncated: boolean;
}

// --- Event pipeline: outbox -> relay -> inbox ---

// One event the relay delivered through the console's capture dispatcher.
export interface PipelineEvent {
  id: string;
  type: string;
  // A user id (usr_...) or transaction id (txn_...) the event is about.
  subject: string;
  at: number;
  audience: 'internal' | 'client';
}

// The pipeline page state: the events the relay has delivered so far in this tab.
export interface PipelineView {
  delivered: PipelineEvent[];
}

// The result of a relay run: how many outbox rows it delivered, failed, or dead-lettered.
export interface RelayResult {
  relayed: number;
  failed: number;
  deadLettered: number;
}

// The result of an inbound webhook: whether the provider event was newly accepted or a duplicate,
// and whether draining the inbox applied a posting (a duplicate applies nothing).
export interface WebhookResult {
  status: 'accepted' | 'duplicate';
  applied: boolean;
}

// --- Mapping helpers ---------------------------------------------------------------

// Amounts are stored as whole "minor units" to stay exact (no floating-point rounding). One credit
// is 100 minor units, the same way one dollar is 100 cents.
const SCALE = 100;

export const LABELS: Record<TxnKind, string> = {
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

// Unknown codes fall back to a tidied version of the code itself.
export function humanReason(code: string): string {
  const known: Record<string, string> = {
    [ERROR_CODES.PROVIDER_FAILURE]: 'provider failure',
    'payout.timeout': 'provider timeout',
  };
  return known[code] ?? code.replace(/[._]/g, ' ').toLowerCase();
}

// Readable title for a background posting kind the feed doesn't word specially. A trailing ".cash"
// becomes a "(cash)" suffix; the rest becomes spaced, sentence-cased words.
export function humanizeKind(kind: string): string {
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
  'platform:stored_value': 'Stored value (spendable credits in circulation)',
  'platform:revenue': 'Platform revenue',
  'platform:held': 'Escrow (funds held until a sale completes)',
  'platform:payout_reserve':
    'Payout reserve (credits set aside for a pending payout)',
  'platform:promo_float': 'Promotional float (credits granted, not yet spent)',
  'platform:trust_cash': 'Trust cash (USD backing user credits)',
  'platform:receivable': 'Receivable (money owed to the platform)',
  'platform:usd_clearing': 'USD clearing (cash in transit to or from the bank)',
  'platform:opening_equity': 'Opening equity (starting balance)',
};

// The platform's own ledger accounts shown on the Overview, in reading order. Receivable and
// opening-equity are omitted: they stay at zero in the demo flow.
export const PLATFORM_ACCOUNTS: {
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

export function credits(n: number): Amount {
  return toAmount('CREDIT', BigInt(Math.round(n * SCALE)));
}

export function toCredits(a: Amount): number {
  return Number(a.minor) / SCALE;
}

// Readable label for an account id. Platform accounts have fixed names (above); a user account
// "<userId>:<kind>" is split into "<userId> · <Kind>".
export function accountLabel(account: string): string {
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
