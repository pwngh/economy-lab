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

import { loadArchiveBoundary, proveChain } from '#src/chain.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';

import type { ArchiveBoundary } from '#src/chain.ts';
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
import { GENESIS_HEX } from '#src/ledger.ts';

import type {
  Digest,
  Ledger,
  CallOptions,
  Rate,
  Rates,
  Signer,
  Store,
  StoredLink,
} from '#src/ports.ts';

// Records one account whose cached running balance disagrees with the balance re-derived by
// summing its own debit and credit lines.
type Drift = { account: AccountRef; materialized: Amount; derived: Amount };

/**
 * What the thorough prover needs — a narrow pick of the Ports bag, so a host passes the whole
 * bag or hand-builds the fields. `digest` is required because the tamper check always
 * recomputes entry hashes; no path trusts a stored hash. `signer` authenticates the archival
 * boundary when one exists — proving an archived store without a signer faults rather than
 * vouching for an unverifiable boundary.
 */
export type ProvePorts = {
  store: Store;
  rates: Rates;
  digest: Digest;
  signer?: Signer;
};

// The hash chain is not checked in this fold — `chain.ts` `proveChain` does that.
type LedgerFold = {
  // Running total per currency. Debits are added and credits are subtracted, so it should
  // reach zero.
  signedByCurrency: Map<Currency, bigint>;

  // Total credits the platform owes users and must hold real USD against.
  custodialCreditMinor: bigint;

  // USD held in trust, summed over every TRUST_CASH shard row, since the logical account is the
  // sum over its shards.
  trustCashMinor: bigint;

  anyUserNegative: boolean;

  drift: Drift[];
};

/**
 * The thorough prover, reads only: it recomputes the entire hash chain to catch any altered entry,
 * unlike the lighter `economy.read.health`. An independent audit, not the enforcer — the DB enforces
 * these invariants (see db/*-schema.sql); this re-derives them from the legs to catch a bug in the
 * enforcement itself.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ The proof} for how the
 *   prover re-derives every invariant.
 *
 * @example
 * const report = await proveEconomy({
 *   store: ports.store, rates: ports.rates, digest: ports.digest, signer: ports.signer,
 * });
 * if (!allInvariantsHold(report)) {
 *   throw new Error('ledger integrity check failed'); // report says which property broke
 * }
 */
export async function proveEconomy(
  ports: ProvePorts,
  options?: CallOptions,
): Promise<ProveReport> {
  const { store } = ports;
  const boundary = await proveBoundary(ports, options);
  const fold = await foldLedger(
    store.ledger,
    balanceBaselines(boundary),
    options,
  );
  const required = backingRequiredMinor(
    fold.custodialCreditMinor,
    ports.rates.par('CREDIT'),
  );

  const shortfallMinor = backingShortfallMinor(required, fold.trustCashMinor);

  const chain = await proveChain(
    { ledger: store.ledger, digest: ports.digest, boundary },
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

async function proveBoundary(
  ports: ProvePorts,
  options?: CallOptions,
): Promise<ArchiveBoundary | null> {
  const checkpoints = ports.store.checkpoints;
  if (ports.signer !== undefined) {
    return loadArchiveBoundary(
      checkpoints,
      { digest: ports.digest, signer: ports.signer },
      options,
    );
  }
  const state =
    checkpoints.archiveState === undefined
      ? null
      : await checkpoints.archiveState(options);
  if (state !== null) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'This store has an archived prefix but the prover was built without a signer; the boundary cannot be authenticated.',
      { retryable: false },
    );
  }
  return null;
}

// The archived raw sums as balance-normal baselines: an account's derived balance is its
// archived portion plus its remaining legs. Raw sums are debit-positive; balance-normal flips
// the sign for credit-normal accounts, the same conversion accumulateLegs applies in reverse.
function balanceBaselines(
  boundary: ArchiveBoundary | null,
): ReadonlyMap<AccountRef, bigint> {
  const baselines = new Map<AccountRef, bigint>();
  if (boundary === null) {
    return baselines;
  }
  for (const [account, rawSum] of boundary.rawSums) {
    baselines.set(account, rawSum * (isDebitNormal(account) ? 1n : -1n));
  }
  return baselines;
}

// The conservation total and the derived balances are built from the entries, not the stored
// balances, so a mis-saved balance surfaces as drift instead of hiding a real imbalance. Backing
// and overdraft read the stored balance directly — the figure they vouch for. The archival
// baselines seed each account's derived balance with its verified archived portion; the
// conservation total deliberately stays remaining-legs-only (whole postings net to zero, so any
// remainder does too, and the mover proves the archived portion netted to zero when it signed).
async function foldLedger(
  ledger: Ledger,
  baselines: ReadonlyMap<AccountRef, bigint>,
  options?: CallOptions,
): Promise<LedgerFold> {
  const signedByCurrency = new Map<Currency, bigint>();
  const backing: BackingTotals = {
    custodialCreditMinor: 0n,
    trustCashMinor: 0n,
  };
  let anyUserNegative = false;
  const drift: Drift[] = [];
  const seen = new Set<AccountRef>();

  for await (const [account] of ledger.heads()) {
    seen.add(account);
    const derivedMinor =
      (baselines.get(account) ?? 0n) +
      (await accumulateLegs(ledger, account, signedByCurrency, options));

    const balance = await ledger.balance(account, options);
    pushIfDrifted(account, balance, derivedMinor, drift);
    foldBackingAccount(backing, account, balance.minor);
    if (isWalletAccount(account) && balance.minor < 0n) {
      anyUserNegative = true;
    }
  }
  // R33: the `heads()` fold only visits accounts with at least one posting, so a phantom balance
  // row (a direct DB edit or half-applied write) is invisible to it. Enumerate every balance row
  // and compare any unvisited account's stored balance against its derived value — the archival
  // baseline for a fully-archived account (all its postings moved cold), 0 otherwise. Backing
  // and overdraft fold here too: a fully-archived account's balance is still real money.
  for await (const account of ledger.balanceAccounts(options)) {
    if (seen.has(account)) {
      continue;
    }
    const balance = await ledger.balance(account, options);
    pushIfDrifted(account, balance, baselines.get(account) ?? 0n, drift);
    if (baselines.has(account)) {
      foldBackingAccount(backing, account, balance.minor);
      if (isWalletAccount(account) && balance.minor < 0n) {
        anyUserNegative = true;
      }
    }
  }
  return { signedByCurrency, ...backing, anyUserNegative, drift };
}

// `derivedBalances` hands back per-currency sums already signed the way they changed this
// account's balance, folded by the store itself, so no legs travel here. The conservation total
// needs the original debit-positive sign back: debit-normal keeps its sign, credit-normal flips it.
async function accumulateLegs(
  ledger: Ledger,
  account: AccountRef,
  signedByCurrency: Map<Currency, bigint>,
  options?: CallOptions,
): Promise<bigint> {
  const sign = isDebitNormal(account) ? 1n : -1n;
  let derivedMinor = 0n;
  for (const derived of await ledger.derivedBalances(account, options)) {
    derivedMinor += derived.minor;
    const rawMinor = derived.minor * sign;
    const cur = derived.currency;
    signedByCurrency.set(cur, (signedByCurrency.get(cur) ?? 0n) + rawMinor);
  }
  return derivedMinor;
}

// Shared by both drift checks: a materialized total that diverged from its legs (R32) and a
// phantom balance row with no backing posting, which derives to 0 (R33). Legs are the source of
// truth; the materialized figure is the cache.
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

// --- The backing figures (shared with economy.ts and worker/treasury.ts) -----------

/**
 * The two sums the backing check needs from one pass over the accounts: the credits the platform
 * owes users and the USD held in trust to back them.
 */
export type BackingTotals = {
  custodialCreditMinor: bigint;
  trustCashMinor: bigint;
};

// `classify` owns what counts as custodial. Every custodial balance is a credit, so the
// `currency === 'CREDIT'` check keeps a stray USD balance out of this credits-only total.
function isCustodialCredit(account: AccountRef): boolean {
  return classify(account) === 'custodial' && currency(account) === 'CREDIT';
}

function isTrustCashShard(account: AccountRef): boolean {
  return baseOf(account) === SYSTEM.TRUST_CASH;
}

/**
 * Folds one account's stored balance into the backing totals. The provers call this from their own
 * heads walk, which also gathers other figures; a caller that needs only the backing sums walks
 * via {@link backingTotals} instead.
 */
export function foldBackingAccount(
  totals: BackingTotals,
  account: AccountRef,
  balanceMinor: bigint,
): void {
  if (isCustodialCredit(account)) {
    totals.custodialCreditMinor += balanceMinor;
  }
  if (isTrustCashShard(account)) {
    totals.trustCashMinor += balanceMinor;
  }
}

/**
 * One pass over the chain heads that sums only the backing figures, reading a balance just for the
 * accounts that count. `balanceOf` is injected so a caller inside a transaction can walk the
 * store's heads while reading balances through its own unit.
 */
export async function backingTotals(
  heads: AsyncIterable<readonly [AccountRef, string]>,
  balanceOf: (account: AccountRef) => Promise<Amount>,
): Promise<BackingTotals> {
  const totals: BackingTotals = {
    custodialCreditMinor: 0n,
    trustCashMinor: 0n,
  };
  for await (const [account] of heads) {
    if (isCustodialCredit(account) || isTrustCashShard(account)) {
      foldBackingAccount(totals, account, (await balanceOf(account)).minor);
    }
  }
  return totals;
}

/**
 * The USD that must back a given amount of credits: the amount times the par rate (the fixed
 * CREDIT-to-USD rate), rounded down via `convertFloor` so no caller can disagree with the money
 * module. The one backing conversion; both provers and the treasury sweep import it.
 */
export function backingRequiredMinor(
  custodialCreditMinor: bigint,
  par: Rate,
): bigint {
  return convertFloor(toAmount('CREDIT', custodialCreditMinor), par, 'USD')
    .minor;
}

/** Returns the USD short of the requirement, clamped to zero when cash is fully held. */
export function backingShortfallMinor(
  requiredMinor: bigint,
  trustCashMinor: bigint,
): bigint {
  return trustCashMinor < requiredMinor ? requiredMinor - trustCashMinor : 0n;
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
 * Rolls a {@link ProveReport} into one verdict: true only when all five flags hold — conserved,
 * backed, no overdraft, chain intact, and consistent. The one-line gate for CI and audit
 * scripts that only need pass/fail; the report itself says which property broke.
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

/**
 * Locates the chain link carrying `hash`, walking every account's lineage through the public
 * read surface — a bounded forensic lookup, not an indexed query. Case-insensitive exact match;
 * the genesis prevHash never matches (it is not a posting hash). Null on a miss, or once
 * `scanMax` links (default 20 000) have been walked.
 */
export async function findByHash(
  read: {
    accounts(options?: CallOptions): AsyncIterable<AccountRef>;
    lineage(
      account: AccountRef,
      options?: CallOptions,
    ): AsyncIterable<StoredLink>;
  },
  hash: string,
  options?: CallOptions & { scanMax?: number },
): Promise<{
  account: AccountRef;
  link: StoredLink;
  field: 'hash' | 'prevHash';
} | null> {
  const target = hash.toLowerCase();
  const scanMax = options?.scanMax ?? 20_000;
  let scanned = 0;
  for await (const account of read.accounts(options)) {
    for await (const link of read.lineage(account, options)) {
      scanned += 1;
      if (scanned > scanMax) {
        return null;
      }
      if (link.hash.toLowerCase() === target) {
        return { account, link, field: 'hash' };
      }
      if (
        link.prevHash !== GENESIS_HEX &&
        link.prevHash.toLowerCase() === target
      ) {
        return { account, link, field: 'prevHash' };
      }
    }
  }
  return null;
}
