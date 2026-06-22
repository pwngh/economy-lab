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

import { proveChain } from '#src/chain.ts';
import { toAmount } from '#src/money.ts';
import {
  classify,
  currency,
  isDebitNormal,
  isWalletAccount,
  SYSTEM,
} from '#src/accounts.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { ProveReport } from '#src/contract.ts';
import type {
  Digest,
  Ledger,
  Options,
  Rate,
  Rates,
  Store,
} from '#src/ports.ts';

// One account whose cached running balance disagrees with the balance re-derived by summing
// its individual debit and credit lines.
type Drift = { account: AccountRef; materialized: Amount; derived: Amount };

/**
 * What `proveEconomy` needs: exchange rates and a `digest` (hashing function). Subset of the
 * app-wide `Ctx`, so a full `Ctx` can be passed straight in. `digest` is required because the
 * tamper check always recomputes entry hashes from scratch; there's no latest-hash-only path.
 */
export type ProveCtx = { rates: Rates; digest: Digest };

// What one pass over the ledger collects. The hash chain is not checked here; `chain.ts`
// `proveChain` does that, so the chain is verified in one place.
type LedgerFold = {
  // Running total per currency, debits added and credits subtracted; should reach zero.
  signedByCurrency: Map<Currency, bigint>;

  // Total credits the platform owes users and must hold real USD against.
  custodialCreditMinor: bigint;

  // Set if any user account dropped below zero.
  anyUserNegative: boolean;

  // Every account whose materialized balance disagrees with the balance folded from its legs.
  drift: Drift[];
};

/**
 * Run all consistency checks over the whole ledger and return the report.
 *
 * Thorough prover: recomputes the entire hash chain to catch any altered entry. The lighter
 * prover in `economy.ts` (`economy.read.prove`) only checks each account's latest hash is
 * well-formed, without recomputing it.
 *
 * Read-only, through `store`, `ctx.rates`, and `chain.ts` `proveChain`.
 *
 * @example
 *   let report = await proveEconomy(store, { rates: fixedRates(), digest });
 *   report.conserved && report.chainIntact; // the books balance and no entry was altered
 */
export async function proveEconomy(
  store: Store,
  ctx: ProveCtx,
  options?: Options,
): Promise<ProveReport> {
  let fold = await foldLedger(store.ledger, options);
  let required = backingRequiredMinor(
    fold.custodialCreditMinor,
    ctx.rates.par('CREDIT'),
  );
  // `TRUST_CASH` is the real USD the platform holds. Compare to the USD needed to back all
  // those credits; a shortfall is the gap (zero means backed).
  let trustCash = await store.ledger.balance(SYSTEM.TRUST_CASH, options);
  let shortfallMinor =
    trustCash.minor < required ? required - trustCash.minor : 0n;

  // Check no stored entry was altered. `proveChain` walks each account's entries in order,
  // recomputes each hash and checks it against the stored hash (and that each entry links to
  // the previous one). Only place the chain is checked; result reused as-is below.
  let chain = await proveChain(
    { ledger: store.ledger, digest: ctx.digest },
    options,
  );

  return {
    conserved: everyCurrencyBalances(fold.signedByCurrency),
    backed: shortfallMinor === 0n,
    noOverdraft: !fold.anyUserNegative,
    chainIntact: chain.intact,
    consistent: fold.drift.length === 0,
    drift: fold.drift,
    shortfall: toAmount('USD', shortfallMinor),
  };
}

// --- One pass over the ledger (foldLedger) -----------------------------------------

// Walks every account ever posted to and collects what the integrity checks need.
//
// The conservation total and per-account derived balance are built from the entries, not the
// stored balances, so a mis-saved balance surfaces as drift instead of hiding a real imbalance.
// Backing and overdraft read the stored balance directly, which is cheaper and is what they
// vouch for.
async function foldLedger(
  ledger: Ledger,
  options?: Options,
): Promise<LedgerFold> {
  let signedByCurrency = new Map<Currency, bigint>();
  let custodialCreditMinor = 0n;
  let anyUserNegative = false;
  let drift: Drift[] = [];
  // Accounts the `heads()` fold visited, so the phantom-row pass below knows which
  // `balanceAccounts()` rows have no backing posting and still need a derived-0 comparison.
  let seen = new Set<AccountRef>();

  for await (let [account] of ledger.heads()) {
    seen.add(account);
    // Folding the legs serves two checks: the per-currency conservation total and the
    // per-account derived balance, compared below against the cached running balance.
    let derivedMinor = await accumulateLegs(
      ledger,
      account,
      signedByCurrency,
      options,
    );

    let balance = await ledger.balance(account, options);
    // R32: materialized balance row that drifted from what its legs sum to (a mis-saved or
    // directly-edited balance). Legs are authoritative; the materialized figure is the cache.
    pushIfDrifted(account, balance, derivedMinor, drift);
    // Sum the credits the platform must back with real USD. `classify` tags an account
    // "custodial" when its balance is a credit a user can spend or withdraw. Revenue-share
    // still owed, promotional grants, and amounts reserved for a pending payout are not
    // custodial (not user-spendable yet). Custodial balances are all credits, so the
    // `currency === 'CREDIT'` check blocks a stray USD balance from this credits-only total.
    if (classify(account) === 'custodial' && currency(account) === 'CREDIT') {
      custodialCreditMinor += balance.minor;
    }
    if (isWalletAccount(account) && balance.minor < 0n) {
      anyUserNegative = true;
    }
  }
  // R33: the `heads()` fold only visits accounts with >=1 posting, so a balance row with no
  // backing posting (a phantom or stale row from a direct DB edit or half-applied write) would
  // be invisible. Enumerate every materialized balance row and, for any account the legs fold
  // never touched, compare its stored balance against a derived 0; the legs say it should not
  // exist, so any non-zero figure is drift. Reuses the R32 comparison, so a legs-less row
  // surfaces in the same `drift` array.
  for await (let account of ledger.balanceAccounts(options)) {
    if (seen.has(account)) {
      continue;
    }
    let balance = await ledger.balance(account, options);
    pushIfDrifted(account, balance, 0n, drift);
  }
  return { signedByCurrency, custodialCreditMinor, anyUserNegative, drift };
}

// Folds one account's entries into the per-currency conservation totals and returns that
// account's balance re-derived from its legs (the value `ledger.balance` should match).
//
// Each statement entry's amount is already signed the way it changed this account's balance, so
// summing them reproduces the materialized balance; that running sum is the returned derived
// total. For the conservation fold, each account has a "normal" side it grows on (`isDebitNormal`
// true for debit-growing accounts): a debit-normal entry already equals the original debit, a
// credit-normal one needs its sign flipped to recover it. Summed across every account, those
// signed amounts must come to zero in each currency if the books balance.
async function accumulateLegs(
  ledger: Ledger,
  account: AccountRef,
  signedByCurrency: Map<Currency, bigint>,
  options?: Options,
): Promise<bigint> {
  let sign = isDebitNormal(account) ? 1n : -1n;
  let derivedMinor = 0n;
  let page = await ledger.statement(account, FULL_RANGE, options);
  for (let entry of page.entries) {
    derivedMinor += entry.amount.minor;
    let rawMinor = entry.amount.minor * sign;
    let cur = entry.amount.currency;
    signedByCurrency.set(cur, (signedByCurrency.get(cur) ?? 0n) + rawMinor);
  }
  return derivedMinor;
}

// Record one account as drifted when its cached running balance disagrees with the balance its
// legs derive to. Shared by both cases: an account with postings whose materialized total
// diverged (R32), and a phantom/stale balance row with no backing posting, which derives to 0
// (R33). Legs are the source of truth; the materialized figure is the cache that may be wrong.
function pushIfDrifted(
  account: AccountRef,
  materialized: Amount,
  derivedMinor: bigint,
  drift: Drift[],
): void {
  if (materialized.minor !== derivedMinor) {
    drift.push({
      account,
      materialized,
      derived: toAmount(currency(account), derivedMinor),
    });
  }
}

// USD that must back a given amount of credits: credit amount times the par rate (fixed
// credit-to-USD rate), rounded down.
//
// The rate is stored as integer `par.rate` plus `par.scale`, true rate = par.rate / 10^scale
// (e.g. rate 50, scale 2 means 0.50 USD per credit), so dividing the product by 10^scale gives
// the real result.
function backingRequiredMinor(custodialCreditMinor: bigint, par: Rate): bigint {
  return (custodialCreditMinor * par.rate) / 10n ** BigInt(par.scale);
}

// True when debits and credits cancel to zero in every currency.
// An empty ledger has nothing to add up, so it passes.
function everyCurrencyBalances(
  signedByCurrency: Map<Currency, bigint>,
): boolean {
  for (let total of signedByCurrency.values()) {
    if (total !== 0n) {
      return false;
    }
  }
  return true;
}

// --- The all-checks roll-up (imported by test/integrity.test.ts) -------------------

/**
 * True only when every integrity check passed: debits and credits conserved per currency, real
 * USD backing every owed credit, no account overdrawn, no stored entry altered (hash chain
 * verifies), and every cached balance agreeing with the lines it sums. Each is a field on the
 * report; for one check, read the field directly (e.g. `report.conserved`).
 */
export function allInvariantsHold(report: ProveReport): boolean {
  return (
    report.conserved &&
    report.backed &&
    report.noOverdraft &&
    report.chainIntact &&
    report.consistent
  );
}

// Time range wide enough to include every entry ever recorded, so a statement over this range
// returns an account's whole history. (Times are epoch ms; upper end exclusive.)
let FULL_RANGE = {
  from: Number.MIN_SAFE_INTEGER,
  to: Number.MAX_SAFE_INTEGER,
};
