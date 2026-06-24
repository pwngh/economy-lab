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
// functions that map raw ledger/engine data into them. No engine state lives here — economy.server.ts
// holds the live economy and calls into these.

import { toAmount } from '#src/money.ts';
import { SYSTEM } from '#src/accounts.ts';
import { ERROR_CODES } from '#src/errors.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
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

// --- Mapping helpers ---------------------------------------------------------------

// Amounts are stored as whole "minor units" to stay exact (no floating-point rounding). One credit
// is 100 minor units, the same way one dollar is 100 cents.
const SCALE = 100;

// The human label shown for each kind of operation in the ledger feed.
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

// Turn a raw failure code into a short human phrase. Unknown codes fall back to a tidied version
// of the code itself.
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
