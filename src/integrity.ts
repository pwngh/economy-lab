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
import { convertFloor, toAmount } from '#src/money.ts';
import {
  baseOf,
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

// Records one account whose cached running balance disagrees with the balance re-derived by
// summing its own debit and credit lines.
type Drift = { account: AccountRef; materialized: Amount; derived: Amount };

/**
 * Holds what `proveEconomy` needs: exchange rates and a `digest` hashing function. This is a
 * subset of the app-wide `Ctx`, so a full `Ctx` can be passed straight in. The `digest` is
 * required because the tamper check always recomputes entry hashes from scratch. There is no
 * cheaper path that trusts the latest stored hash.
 */
export type ProveCtx = { rates: Rates; digest: Digest };

// Collects what one pass over the ledger gathers. The hash chain is not checked here. `chain.ts`
// `proveChain` does that, so the chain is verified in one place.
type LedgerFold = {
  // Running total per currency. Debits are added and credits are subtracted, so it should
  // reach zero.
  signedByCurrency: Map<Currency, bigint>;

  // Total credits the platform owes users and must hold real USD against.
  custodialCreditMinor: bigint;

  // USD held in trust, summed over every TRUST_CASH shard row, since the logical account is the
  // sum over its shards.
  trustCashMinor: bigint;

  // True if any user account dropped below zero.
  anyUserNegative: boolean;

  // Every account whose materialized balance disagrees with the balance folded from its legs.
  drift: Drift[];
};

/**
 * Runs all consistency checks over the whole ledger and returns the report. Reads only.
 *
 * This is the thorough prover: it recomputes the entire hash chain to catch any altered entry,
 * unlike the lighter `economy.read.prove`. It is an independent audit, not the enforcer — the DB
 * enforces these invariants (see db/*-schema.sql); this re-derives them from the legs to catch a
 * bug in the enforcement itself, so it never guards the write path.
 *
 * @example
 *   const report = await proveEconomy(store, { rates: fixedRates(), digest });
 *   report.conserved && report.chainIntact; // the books balance and no entry was altered
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ The proof} for how the
 *   prover re-derives every invariant.
 */
export async function proveEconomy(
  store: Store,
  ctx: ProveCtx,
  options?: Options,
): Promise<ProveReport> {
  const fold = await foldLedger(store.ledger, options);
  const required = backingRequiredMinor(
    fold.custodialCreditMinor,
    ctx.rates.par('CREDIT'),
  );

  const shortfallMinor =
    fold.trustCashMinor < required ? required - fold.trustCashMinor : 0n;

  // Check that no stored entry was altered. `proveChain` walks each account's entries in order.
  // It recomputes each hash, checks it against the stored hash, and confirms that each entry
  // links to the previous one. This is the only place the chain is checked, and the result is
  // reused as-is below.
  const chain = await proveChain(
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
// The conservation total and the per-account derived balance are built from the entries, not the
// stored balances, so a mis-saved balance surfaces as drift instead of hiding a real imbalance.
// Backing and overdraft read the stored balance directly, which is cheaper and is the figure
// they vouch for.
async function foldLedger(
  ledger: Ledger,
  options?: Options,
): Promise<LedgerFold> {
  const signedByCurrency = new Map<Currency, bigint>();
  let custodialCreditMinor = 0n;
  let trustCashMinor = 0n;
  let anyUserNegative = false;
  const drift: Drift[] = [];
  // Tracks the accounts the `heads()` fold visited. The phantom-row pass below uses this to find
  // which `balanceAccounts()` rows have no backing posting and still need a derived-zero check.
  const seen = new Set<AccountRef>();

  for await (const [account] of ledger.heads()) {
    seen.add(account);
    // Folding the legs serves two checks. It feeds the per-currency conservation total, and it
    // produces the per-account derived balance compared below against the cached running balance.
    const derivedMinor = await accumulateLegs(
      ledger,
      account,
      signedByCurrency,
      options,
    );

    const balance = await ledger.balance(account, options);
    // R32: materialized balance row that drifted from what its legs sum to (a mis-saved or
    // directly-edited balance). Legs are authoritative; the materialized figure is the cache.
    pushIfDrifted(account, balance, derivedMinor, drift);
    // Sum the credits the platform must back with real USD. `classify` tags an account
    // "custodial" when its balance is a credit a user can spend or cash out. Revenue-share still
    // owed, promotional grants, and amounts reserved for a pending payout are not custodial,
    // because none are user-spendable yet. Every custodial balance is a credit, so the
    // `currency === 'CREDIT'` check keeps a stray USD balance out of this credits-only total.
    if (classify(account) === 'custodial' && currency(account) === 'CREDIT') {
      custodialCreditMinor += balance.minor;
    }
    // Trust cash is one logical account split across shard rows, so the backing check compares
    // required USD against the sum over every TRUST_CASH shard this pass visits, not one bare row.
    if (baseOf(account) === SYSTEM.TRUST_CASH) {
      trustCashMinor += balance.minor;
    }
    if (isWalletAccount(account) && balance.minor < 0n) {
      anyUserNegative = true;
    }
  }
  // R33: the `heads()` fold only visits accounts with at least one posting. A balance row with
  // no backing posting would be invisible to it. Such a row is a phantom or stale row left by a
  // direct DB edit or a half-applied write. So enumerate every materialized balance row, and for
  // any account the legs fold never touched, compare its stored balance against a derived 0. The
  // legs say the account should not exist, so any non-zero figure is drift. This reuses the R32
  // comparison, so a legs-less row surfaces in the same `drift` array.
  for await (const account of ledger.balanceAccounts(options)) {
    if (seen.has(account)) {
      continue;
    }
    const balance = await ledger.balance(account, options);
    pushIfDrifted(account, balance, 0n, drift);
  }
  return {
    signedByCurrency,
    custodialCreditMinor,
    trustCashMinor,
    anyUserNegative,
    drift,
  };
}

// Folds one account's entries into the per-currency conservation totals and returns that
// account's balance re-derived from its legs. That returned value is the figure `ledger.balance`
// should match.
//
// Each entry's amount is already signed the way it changed this account's balance, so summing
// the amounts reproduces the materialized balance, which is the returned derived total. The
// conservation total needs the original debit instead, recovered by sign. A debit-normal account
// (`isDebitNormal`) keeps its sign, and a credit-normal account flips it. Summed across all
// accounts, these must reach zero per currency.
async function accumulateLegs(
  ledger: Ledger,
  account: AccountRef,
  signedByCurrency: Map<Currency, bigint>,
  options?: Options,
): Promise<bigint> {
  const sign = isDebitNormal(account) ? 1n : -1n;
  let derivedMinor = 0n;
  const page = await ledger.statement(account, FULL_RANGE, options);
  for (const entry of page.entries) {
    derivedMinor += entry.amount.minor;
    const rawMinor = entry.amount.minor * sign;
    const cur = entry.amount.currency;
    signedByCurrency.set(cur, (signedByCurrency.get(cur) ?? 0n) + rawMinor);
  }
  return derivedMinor;
}

// Records one account as drifted when its cached running balance disagrees with the balance its
// legs derive to. Both cases share this helper. The first is an account with postings whose
// materialized total diverged (R32). The second is a phantom or stale balance row with no
// backing posting, which derives to 0 (R33). The legs are the source of truth, and the
// materialized figure is the cache that may be wrong.
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

// Returns the USD that must back a given amount of credits. It is the credit amount times the par
// rate (the fixed CREDIT-to-USD rate), rounded down.
//
// The rate is stored as an integer `par.rate` plus a `par.scale`, where the true rate equals
// par.rate / 10^scale. `convertFloor` applies exactly that multiply-and-divide with the rounding
// mode named, so this prover and the money module can never disagree on the conversion.
function backingRequiredMinor(custodialCreditMinor: bigint, par: Rate): bigint {
  return convertFloor(toAmount('CREDIT', custodialCreditMinor), par, 'USD')
    .minor;
}

function everyCurrencyBalances(
  signedByCurrency: Map<Currency, bigint>,
): boolean {
  for (const total of signedByCurrency.values()) {
    if (total !== 0n) {
      return false;
    }
  }
  return true;
}

// --- The all-checks roll-up (imported by test/integrity.test.ts) -------------------

/**
 * Returns true only when every integrity check passed. That means debits and credits are
 * conserved per currency, real USD backs every owed credit, no account is overdrawn, no stored
 * entry was altered (the hash chain verifies), and every cached balance agrees with the lines it
 * sums. Each check is a field on the report. To read one check, read its field directly, such as
 * `report.conserved`.
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

const FULL_RANGE = {
  from: Number.MIN_SAFE_INTEGER,
  to: Number.MAX_SAFE_INTEGER,
};
