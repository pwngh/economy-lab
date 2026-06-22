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

// One account whose cached running balance (the per-account total the store keeps, read in
// constant time) disagrees with the balance re-derived by summing that account's individual
// debit and credit lines.
type Drift = { account: AccountRef; materialized: Amount; derived: Amount };

/**
 * What `proveEconomy` needs to run: the exchange rates, and a `digest` (a hashing function).
 *
 * It's a subset of the larger `Ctx` the rest of the app passes around, so code that already
 * has a full `Ctx` can pass it straight in. The `digest` is required because the tamper check
 * always recomputes the entry hashes from scratch — there's no cheaper path that only checks
 * the latest hash looks well-formed.
 */
export type ProveCtx = { rates: Rates; digest: Digest };

// What one pass over the ledger collects. The hash chain is NOT checked here — `chain.ts`
// `proveChain` does that on its own, so the chain is verified in just one place.
type LedgerFold = {
  // Running total per currency, with debits added and credits subtracted; should reach zero.
  signedByCurrency: Map<Currency, bigint>;

  // Total credits the platform owes users and must hold real USD against.
  custodialCreditMinor: bigint;

  // Set if any user account dropped below zero.
  anyUserNegative: boolean;

  // Every account whose materialized balance disagrees with the balance folded from its legs.
  drift: Drift[];
};

/**
 * Run all the consistency checks over the whole ledger and return the report.
 *
 * This is the thorough prover: it recomputes the entire hash chain to catch any altered entry.
 * The lighter prover in `economy.ts` (the one `economy.read.prove` calls) only checks that each
 * account's latest hash is well-formed, without recomputing it.
 *
 * Only reads — through `store`, `ctx.rates`, and `chain.ts` `proveChain` — and never writes.
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
  // `TRUST_CASH` is the real USD the platform actually holds. Compare it to the USD needed to
  // back all those credits; if it falls short, that gap is the shortfall (zero means backed).
  let trustCash = await store.ledger.balance(SYSTEM.TRUST_CASH, options);
  let shortfallMinor =
    trustCash.minor < required ? required - trustCash.minor : 0n;

  // Check that no stored entry was altered. `proveChain` walks each account's entries in
  // order, recomputes the hash for each one, and checks it against the hash stored with that
  // entry (and that each entry links to the one before it). This is the only place the chain
  // is checked, so the result is reused as-is below.
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
// The conservation total and the per-account derived balance are both built from the individual
// entries, not from the stored balances, so a balance saved wrong can't hide a real imbalance and
// instead surfaces as drift. Backing and overdraft read each account's stored balance directly,
// which is cheaper and is what they are meant to vouch for.
async function foldLedger(
  ledger: Ledger,
  options?: Options,
): Promise<LedgerFold> {
  let signedByCurrency = new Map<Currency, bigint>();
  let custodialCreditMinor = 0n;
  let anyUserNegative = false;
  let drift: Drift[] = [];
  // Every account the `heads()` fold already visited, so the phantom-row pass below knows which
  // `balanceAccounts()` rows have no backing posting and still need a derived-0 comparison.
  let seen = new Set<AccountRef>();

  for await (let [account] of ledger.heads()) {
    seen.add(account);
    // Folding the legs serves two checks at once: the per-currency conservation total (built
    // from the entries so a mis-saved balance can't hide a real imbalance) and the per-account
    // derived balance compared just below against the cached running balance the store keeps.
    let derivedMinor = await accumulateLegs(
      ledger,
      account,
      signedByCurrency,
      options,
    );

    let balance = await ledger.balance(account, options);
    // R32: a materialized balance row that has drifted from what its legs sum to — a read model
    // that diverged from the source of truth (a mis-saved or directly-edited balance). The legs
    // are authoritative; the materialized figure is the cache that may be wrong.
    pushIfDrifted(account, balance, derivedMinor, drift);
    // Add up the credits the platform must back with real USD. `classify` tags an account
    // "custodial" when its balance is a credit a user could actually spend or withdraw —
    // users' spendable accounts. Credits that are revenue-share the platform
    // still owes, promotional grants, or amounts reserved for a pending payout are NOT custodial
    // and don't count here, because they aren't user-spendable yet. Custodial balances are all
    // in credits, so the `currency === 'CREDIT'` check just blocks a stray USD balance from
    // entering this credits-only total.
    if (classify(account) === 'custodial' && currency(account) === 'CREDIT') {
      custodialCreditMinor += balance.minor;
    }
    if (isWalletAccount(account) && balance.minor < 0n) {
      anyUserNegative = true;
    }
  }
  // R33: the `heads()` fold above only visits accounts with ≥1 posting, so a balance row with NO
  // backing posting (a phantom or stale row a direct DB edit or a half-applied write could leave
  // behind) would otherwise be invisible. Enumerate every materialized balance row and, for any
  // account the legs fold never touched, compare its stored balance against a derived 0 — the
  // legs say it should not exist, so any non-zero materialized figure is drift. This reuses the
  // same per-account comparison as R32, so a legs-less row surfaces in the same `drift` array.
  for await (let account of ledger.balanceAccounts(options)) {
    if (seen.has(account)) {
      continue;
    }
    let balance = await ledger.balance(account, options);
    pushIfDrifted(account, balance, 0n, drift);
  }
  return { signedByCurrency, custodialCreditMinor, anyUserNegative, drift };
}

// Folds one account's entries into the per-currency conservation totals AND returns that
// account's balance re-derived from its legs (the value `ledger.balance` is supposed to match).
//
// Each statement entry's amount is already signed the way it changed THIS account's balance, so
// summing those amounts reproduces the materialized balance — that running sum is the returned
// derived total. For the conservation fold, each account also has a "normal" side it grows on
// (`isDebitNormal` is true for accounts that grow on a debit): a debit-normal entry already
// equals the original debit, a credit-normal one needs its sign flipped to recover that debit.
// Summed across every account, those signed amounts must come to zero in each currency if the
// books balance.
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

// Record one account as drifted when its cached running balance (the per-account total the store
// keeps, read in constant time) disagrees with the balance its legs derive to. Shared by both
// directions: an account WITH postings whose materialized total
// diverged (R32), and a phantom/stale balance row with NO backing posting, which derives to 0
// (R33). The legs are the source of truth; the materialized figure is the cache that may be wrong.
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

// How much USD must back a given amount of credits: multiply the credit amount by the par
// rate (the fixed credit-to-USD exchange rate) and round down.
//
// The rate is stored as an integer `par.rate` plus a `par.scale`, where the true rate is
// par.rate / 10^scale — e.g. rate 50 with scale 2 means 0.50 USD per credit — so dividing the
// product by 10^scale here gives the real result.
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
 * True only when every integrity check on the report passed at once: debits and credits
 * conserved in each currency, real USD backing every owed credit, no account overdrawn, no
 * stored entry altered (the hash chain still verifies), and every cached balance still
 * agreeing with the lines it sums. Each is a yes/no field on the report; a caller wanting one
 * check reads the field directly (e.g. `report.conserved`).
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

// A time range wide enough to include every entry ever recorded, so asking for an account's
// statement over this range returns its whole history.
// (Times are epoch milliseconds, counted from 1970; the upper end is not included.)
let FULL_RANGE = {
  from: Number.MIN_SAFE_INTEGER,
  to: Number.MAX_SAFE_INTEGER,
};
