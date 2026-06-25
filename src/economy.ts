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

import { fault, rejected, ERROR_CODES } from '#src/errors.ts';
import { balance as ledgerBalance } from '#src/ledger.ts';
import {
  compare,
  decodeAmount,
  encodeAmount,
  isNegative,
  toAmount,
} from '#src/money.ts';
import {
  SYSTEM,
  classify,
  currency,
  earned,
  isDebitNormal,
  isWalletAccount,
  ownerOf,
  promo,
  spendable,
  accountsOf,
} from '#src/accounts.ts';
import { REGISTRY } from '#src/operations/registry.ts';
import { attemptMinor, riskSubject, VELOCITY_CURRENCY } from '#src/trust.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Amount, Currency } from '#src/money.ts';
import type {
  Ctx,
  Economy,
  Operation,
  Outcome,
  ProveReport,
} from '#src/contract.ts';
import type {
  Attempt,
  Capabilities,
  EconomyEvent,
  Ledger,
  Options,
  Rate,
  Store,
  Unit,
} from '#src/ports.ts';

// Re-export the public `Economy` type (declared in contract.ts) so callers and test support can
// import it from this factory.
export type { Economy } from '#src/contract.ts';

type Handler = (operation: Operation, unit: Unit, ctx: Ctx) => Promise<Outcome>;
type Registry = Partial<Record<Operation['kind'], Handler>>;

/**
 * Build an {@link Economy} from the injected capabilities (store, clock, ids, etc.).
 *
 * @example
 * const economy = createEconomy(capabilities);
 * const outcome = await economy.submit(operation);
 */
export function createEconomy(capabilities: Capabilities): Economy {
  let store = capabilities.store;
  let ctx = contextOf(capabilities);
  let registry = REGISTRY;

  return {
    submit: (operation, options) =>
      submit({ store, registry, ctx }, operation, options),
    read: {
      balance: (account, options) =>
        cachedBalance(ctx, store.ledger, account, options),
      statement: (account, range, options) =>
        store.ledger.statement(account, range, options),
      posting: (txnId, options) => store.ledger.posting(txnId, options),
      saga: (id, options) => store.sagas.load(id, options),
      entitled: (userId, sku, options) =>
        store.entitlements.owns(userId, sku, options),
      accounts: (options) => store.ledger.balanceAccounts(options),
      payouts: (options) => store.sagas.list(options),
      prove: (options) => proveEconomy(store, ctx, options),
    },
    close: () => store.close(),
  };
}

type Pipeline = { store: Store; registry: Registry; ctx: Ctx };

type Step = {
  pipeline: Pipeline;
  unit: Unit;
  operation: Operation;
  options?: Options;
};

// Capabilities a handler may read at runtime: everything except the store (handlers get the
// per-transaction view) and the scheduler/dispatcher (kept by this factory). `cache` is undefined
// when no cache was injected, leaving every read path unchanged.
function contextOf(capabilities: Capabilities): Ctx {
  return {
    clock: capabilities.clock,
    ids: capabilities.ids,
    digest: capabilities.digest,
    signer: capabilities.signer,
    processor: capabilities.processor,
    config: capabilities.config,
    pricing: capabilities.pricing,
    rates: capabilities.rates,
    logger: capabilities.logger,
    meter: capabilities.meter,
    cache: capabilities.cache,
  };
}

// --- Read-through balance cache ----------------------------------------------------

// Cache key for one account's balance. `bal:` prefix avoids collisions in a shared cache.
function cacheKey(account: AccountRef): string {
  return `bal:${account}`;
}

// The cache is best-effort: a Redis blip must degrade to a direct ledger read, never fail a request
// the ledger can still serve (see the Cache port — every miss is safe). Run a cache op; on any error
// log it and fall back, so a `get` becomes a miss and a `set`/`invalidate` a no-op rather than an
// outage. The Redis adapter raises a retryable STORE.FAILURE on a driver error; this is where that
// is absorbed, so adding a cache can only speed reads, never make them fail.
async function bestEffortCache<T>(
  ctx: Ctx,
  op: 'get' | 'set' | 'invalidate',
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.log('warn', 'economy.cache.degraded', {
      op,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

// Read an account's balance through `ctx.cache` when present, else just `ledger.balance(account,
// options)`. On a miss, read the ledger, store, and return. Stored as the `encodeAmount` string
// (which carries the currency), so the exact bigint minor-unit value survives a string-only cache.
// Only the public `read.balance` routes through here; reads inside a write transaction (holding a
// lock) stay direct, so a transaction never sees a stale cached value.
async function cachedBalance(
  ctx: Ctx,
  ledger: Ledger,
  account: AccountRef,
  options?: Options,
): Promise<Amount> {
  let cache = ctx.cache;
  if (!cache) {
    return ledger.balance(account, options);
  }
  let key = cacheKey(account);
  let hit = await bestEffortCache<string | null>(
    ctx,
    'get',
    () => cache.get(key),
    null,
  );
  if (hit !== null) {
    return amountFromCache(hit);
  }
  let fresh = await ledger.balance(account, options);
  await bestEffortCache<void>(
    ctx,
    'set',
    () => cache.set(key, encodeAmount(fresh)),
    undefined,
  );
  return fresh;
}

// Rebuild an Amount from its cached `encodeAmount` form (`'CREDIT:12.34'`): currency before the
// colon, decimal after. Same split the wire and postgres adapters use.
function amountFromCache(encoded: string): Amount {
  let colon = encoded.indexOf(':');
  let cur = encoded.slice(0, colon) as Currency;
  return decodeAmount(encoded.slice(colon + 1), cur);
}

// --- Request-processing pipeline ---------------------------------------------------

// Run one operation end to end. Order matters:
//   1. authorize first, so a forbidden request is rejected before any work;
//   2. then do the money work in one all-or-nothing transaction (see `runOnion`).
// The risk-velocity attempt is recorded inside that transaction's `screenRisk` step (via the trust
// store's atomic `record`, serialized per subject, not undone by a rollback), so it counts at check
// time. This closes the velocity-limit TOCTOU: the old design read the windowed total before the
// work and bumped it after the commit, so N concurrent same-subject submits all read the same
// pre-bump total and slipped past the limit.
async function submit(
  pipeline: Pipeline,
  operation: Operation,
  options?: Options,
): Promise<Outcome> {
  validateOperation(operation);
  authorize(operation);

  let outcome = await pipeline.store.transaction(
    (unit) => runOnion({ pipeline, unit, operation, options }),
    options,
  );

  await invalidateCache(pipeline, operation, outcome);
  return outcome;
}

// Largest amount, in minor units, any single operation may move. Generous, but blocks
// overflow-scale values from a typo or a hostile caller.
let MAX_OP_AMOUNT_MINOR = 1_000_000_000_000_000n;

// Reject a malformed operation before any work begins, caught once here rather than in each handler.
// Enforces three things for every kind:
//   - a non-empty idempotency key, so distinct requests can't collapse into one "duplicate"
//     (dropping a second purchase/payout/refund);
//   - no user wallet account with a blank owner (an empty user id builds a ":spendable"-style
//     account and leaves a phantom, ownerless wallet);
//   - an in-range money amount (positive, or merely non-zero for a two-way `adjust`, within the
//     ceiling above).
// Handlers still re-check what is specific to them (currency, sufficiency, business rules).
function validateOperation(operation: Operation): void {
  if (
    typeof operation.idempotencyKey !== 'string' ||
    operation.idempotencyKey.trim() === ''
  ) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'operation is missing a non-empty idempotencyKey',
      { detail: { kind: operation.kind } },
    );
  }

  for (let account of accountsOf(operation)) {
    if (isWalletAccount(account) && ownerOf(account).trim() === '') {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'operation names a wallet account with a blank user id',
        { detail: { kind: operation.kind } },
      );
    }
  }

  assertAmountInRange(operation);
}

// The money amount an operation moves, or null for kinds that move none (they reference an existing
// transaction, order, or subscription instead).
function operationAmount(operation: Operation): Amount | null {
  switch (operation.kind) {
    case 'topUp':
    case 'requestPayout':
    case 'grantPromo':
    case 'clawback':
    case 'adjust':
      return operation.amount;
    case 'spend':
    case 'subscribe':
      return operation.price;
    default:
      return null;
  }
}

// Reject an operation whose money amount is non-positive or beyond the ceiling. A manual `adjust`
// may debit or credit, so it only has to be non-zero; every other movement must be strictly
// positive.
function assertAmountInRange(operation: Operation): void {
  let amount = operationAmount(operation);
  if (amount === null) {
    return;
  }
  let signOk =
    operation.kind === 'adjust' ? amount.minor !== 0n : amount.minor > 0n;
  if (!signOk) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      'operation amount must be a positive value',
      { detail: { kind: operation.kind, amount: encodeAmount(amount) } },
    );
  }
  let magnitude = amount.minor < 0n ? -amount.minor : amount.minor;
  if (magnitude > MAX_OP_AMOUNT_MINOR) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      'operation amount exceeds the maximum allowed',
      { detail: { kind: operation.kind, amount: encodeAmount(amount) } },
    );
  }
}

// Drop the cached balance of every account a committed transaction touched, so the next read
// recomputes from the ledger instead of serving the stale pre-posting figure. No-op with no cache
// injected, or when the outcome wasn't a commit (rejected/duplicate changed no balance). Touched
// accounts are `accountsOf(operation)` (the set `lockAccounts` locks), de-duplicated so each key is
// invalidated once.
async function invalidateCache(
  pipeline: Pipeline,
  operation: Operation,
  outcome: Outcome,
): Promise<void> {
  let cache = pipeline.ctx.cache;
  if (!cache || outcome.status !== 'committed') {
    return;
  }
  for (let account of new Set(accountsOf(operation))) {
    await bestEffortCache<void>(
      pipeline.ctx,
      'invalidate',
      () => cache.invalidate(cacheKey(account)),
      undefined,
    );
  }
}

// The transaction body: checks plus the money posting. The idempotency key makes a retry run at most
// once (a repeat with the same key is recognized and not re-applied). Returning `rejected` or
// throwing a fault rolls back, leaving the key unused, so the caller can retry a rejected request
// under the same key.
async function runOnion(step: Step): Promise<Outcome> {
  let { unit, operation, options } = step;
  let claim = await unit.idempotency.claim(operation.idempotencyKey, options);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  let funds = await screenFunds(step);
  if (funds) {
    return funds;
  }
  let risk = await screenRisk(step);
  if (risk) {
    return risk;
  }

  await lockAccounts(step);
  let handler = resolveHandler(step.pipeline.registry, operation);
  let outcome = await handler(operation, unit, step.pipeline.ctx);
  if (outcome.status === 'committed') {
    await unit.idempotency.record(
      operation.idempotencyKey,
      outcome.transaction,
      options,
    );
    await emitEvents(step, outcome);
  }
  return outcome;
}

// Decide whether the caller may run this operation; throw an UNAUTHORIZED fault if not. End-user
// rule: they may run an operation only if every account it debits belongs to them. Debiting someone
// else's account is forbidden; paying into another user's account, or moving the balancing amount
// through a platform account, is fine. Privileged-only operations (grants, manual operator
// corrections) are off-limits to end users. Runs before the operation is claimed.
function authorize(operation: Operation): void {
  let actor = operation.actor;
  if (actor.kind === 'operator') {
    // Human operator running manual corrections; postings are fully audited and record the reason.
    return;
  }
  if (actor.kind === 'system') {
    // Trusted internal service. Full access for now; per-service permission lists come later.
    return;
  }
  if (RESTRICTED_TO_PRIVILEGED.has(operation.kind)) {
    throw unauthorized(
      operation,
      'operation requires a system or operator principal',
    );
  }
  for (let account of debitedUserAccounts(operation)) {
    if (!ownedBy(account, actor.userId)) {
      throw unauthorized(operation, 'a user may not debit another account');
    }
  }
}

// The user accounts this operation debits, the only ones the ownership check cares about. Narrower
// than `accountsOf` (which lists every account to lock): platform accounts and any user account
// being paid into are left out, since only a drained account has to belong to the caller.
function debitedUserAccounts(operation: Operation): AccountRef[] {
  if (operation.kind === 'spend') {
    return [promo(operation.buyerId), spendable(operation.buyerId)];
  }
  if (operation.kind === 'subscribe') {
    return [promo(operation.userId), spendable(operation.userId)];
  }
  if (operation.kind === 'requestPayout') {
    return [earned(operation.userId)];
  }
  return [];
}

// Check up front that every account can cover what the operation will take; return a `rejected`
// outcome (not throw) if one falls short, before any money is posted. The required amount per account
// comes from the same calculation the handler uses to post, so pre-check and posting can't disagree.
// Returns null when funds are fine.
//
// Courtesy pre-check, not the enforcer. No-overdraft is enforced by the database (the
// user_account_non_negative CHECK in db/*-schema.sql). This exists so an overspend returns a clean
// `rejected` outcome — submit()'s ordinary "no" — instead of the engine throwing a constraint
// violation. The engine is the backstop; this is the kind error.
async function screenFunds(step: Step): Promise<Outcome | null> {
  let { unit, operation, options } = step;
  for (let need of await fundsNeeded(unit, operation)) {
    let have = await unit.ledger.balance(need.account, options);
    if (compare(have, need.amount) < 0) {
      return rejected('INSUFFICIENT_FUNDS', {
        account: need.account,
        required: encodeAmount(need.amount),
        available: encodeAmount(have),
      });
    }
  }
  return null;
}

// How much each user account must hold for the operation to go through. Only `spend` can run a user
// short: a purchase draws promo first then spendable, so promo never overdraws (only spent to zero)
// and spendable is the one account that can be too low. Returns the exact spendable amount the
// purchase will draw; every other operation returns nothing to check.
async function fundsNeeded(
  unit: Unit,
  operation: Operation,
): Promise<ReadonlyArray<{ account: AccountRef; amount: Amount }>> {
  if (operation.kind !== 'spend') {
    return [];
  }
  let promoBalance = await unit.ledger.balance(promo(operation.buyerId));
  let plan = planSpend(operation.price, promoBalance);
  return [
    { account: spendable(operation.buyerId), amount: plan.spendablePart },
  ];
}

// Risk check: would this operation push the user past their recent-spending limit? Records this
// attempt and reads back the windowed total in one atomic per-subject step (`trust.record`), then
// denies if that total (which already includes this attempt) is over the limit. Recording at check
// time, not reading first and bumping after the commit, closes the velocity-limit TOCTOU: two
// concurrent same-subject submits can't both read a stale pre-bump total and pass. The record goes
// straight through the trust store (not the transaction's view), so even a denied attempt, or one
// whose transaction later rolls back, still counts against the limit; the limit can't be probed for
// free. Returns `rejected` when over the limit, else null.
async function screenRisk(step: Step): Promise<Outcome | null> {
  let { pipeline, operation, options } = step;
  let subject = riskSubject(operation);
  if (subject === null) {
    return null;
  }
  // Record this attempt with a fixed `committed` tag and the amount it would move. The outcome tag is
  // write-only (the limit logic sums every attempt's amount regardless of tag), so a fixed tag at
  // check time is faithful. The returned velocity already includes this attempt, so compare the raw
  // windowed total against the limit, without re-adding this attempt's amount (would double-count).
  let attempt: Attempt = {
    idempotencyKey: operation.idempotencyKey,
    amount: toAmount(VELOCITY_CURRENCY, attemptMinor(operation)),
    at: pipeline.ctx.clock.now(),
    outcome: 'committed',
  };
  let velocity = await pipeline.store.trust.record(subject, attempt, options);
  if (velocity.spent.minor > pipeline.ctx.config.velocityLimitMinor) {
    return rejected('RISK_DENIED', { subject });
  }
  return null;
}

// Lock every account the operation will touch before posting, so two operations on the same accounts
// can't interleave and corrupt a balance. Locked in a fixed order (default string `.sort()`, whose
// raw character-code order is identical on every machine, unlike a locale-aware comparison), so
// operations sharing an account grab locks in the same order. That prevents a deadlock where each
// operation waits on a lock the other holds.
//
// This is app-side concurrency control, deliberately, and the one invariant the database is not the
// primary enforcer of. The write runs at the engine's default isolation, not SERIALIZABLE, so this
// fixed-order locking — not the engine — is what serializes contending operations. The engine
// enforces each invariant's content (conservation, balances, continuity); this enforces their
// interleaving. The pairing is exercised by test/conformance/concurrency.adversarial.test.ts (N
// parallel same-account spends still conserve and never overdraw). We may replace this with SERIALIZABLE
// + retry-on-conflict in the future.
async function lockAccounts(step: Step): Promise<void> {
  let { unit, operation, options } = step;
  let sorted = [...new Set(accountsOf(operation))].sort();
  for (let account of sorted) {
    await unit.ledger.lock(account, options);
  }
}

// After a successful posting, queue the matching notification event (e.g. "credits topped up").
// Written into the outbox in the same transaction as the posting, so it ships only if the posting
// committed: a rollback leaves no stray event, a commit always has its event queued.
async function emitEvents(
  step: Step,
  outcome: Extract<Outcome, { status: 'committed' }>,
): Promise<void> {
  let { unit, operation, options } = step;
  let ctx = step.pipeline.ctx;
  let descriptor = EVENTS[operation.kind];
  if (!descriptor) {
    return;
  }
  let event: EconomyEvent = {
    id: ctx.ids.next('evt'),
    type: descriptor.type,
    version: 1,
    occurredAt: outcome.transaction.postedAt,
    subject: descriptor.subject(operation, outcome),
    // Each event kind builds its own payload from the operation and committed result, so a consumer
    // learns what happened without re-fetching the transaction. A client-bound event carries only an
    // allow-listed, PII-free summary (deny-by-default: a builder must opt a field in).
    data: descriptor.data(operation, outcome),
    audience: descriptor.audience,
  };
  await unit.outbox.enqueue(
    { id: ctx.ids.next('obx'), event, status: 'pending', attempts: 0 },
    options,
  );
}

// --- Funds plan (shared by screenFunds and the spend handler) ----------------------

type SpendPlan = { promoPart: Amount; spendablePart: Amount };

// How a purchase is paid for: promo balance first, then spendable. The promo part is min(price,
// available promo); the spendable part is the rest. Both the up-front funds check and the posting
// call this, so they can't disagree on how much comes from each account.
function planSpend(price: Amount, promoBalance: Amount): SpendPlan {
  let available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  let promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount(price.currency, promoMinor),
    spendablePart: toAmount(price.currency, price.minor - promoMinor),
  };
}

// --- Integrity check ---------------------------------------------------------------

/**
 * Walk every account once and report whether the ledger still holds its core guarantees; see the
 * {@link ProveReport} fields for what each flag means.
 *
 * This is now an independent audit, not the primary guard. The database enforces conservation,
 * no-overdraft, chain continuity, and balance integrity at write time (db/*-schema.sql), so a
 * violation should be unrepresentable; prove() re-derives every balance from the legs and re-checks
 * regardless — an out-of-band cross-check that also catches a bug in the engine enforcement itself.
 *
 * `backed` checks the platform holds enough real cash to cover what it owes users: sums the
 * custodial credit balances — the credits in users' spendable accounts (classify() labels only these
 * "custodial") — converts to USD at the fixed CREDIT-to-USD rate, and checks the cash account holds
 * at least that much.
 *
 * `chainIntact` here is only a shape check on each account's latest hash; the full replay
 * re-verifying every posting lives in integrity.ts.
 */
async function proveEconomy(
  store: Store,
  ctx: Ctx,
  options?: Options,
): Promise<ProveReport> {
  let fold = await foldLedger(store);
  let required = backingRequired(fold.custodialCredit, ctx.rates.par('CREDIT'));
  let trustCash = await ledgerBalance(store.ledger, SYSTEM.TRUST_CASH, options);
  let shortfallMinor =
    trustCash.minor < required ? required - trustCash.minor : 0n;

  return {
    conserved: [...fold.signedByCurrency.values()].every((sum) => sum === 0n),
    backed: shortfallMinor === 0n,
    noOverdraft: !fold.anyUserNegative,
    chainIntact: fold.chainIntact,
    consistent: fold.drift.length === 0,
    drift: fold.drift,
    shortfall: toAmount('USD', shortfallMinor),
  };
}

type LedgerDrift = {
  account: AccountRef;
  materialized: Amount;
  derived: Amount;
};

type LedgerFold = {
  signedByCurrency: Map<Currency, bigint>;
  custodialCredit: bigint;
  anyUserNegative: boolean;
  chainIntact: boolean;
  drift: LedgerDrift[];
};

// Lighter twin of integrity.ts foldLedger/accumulateLegs (the thorough prover); keep the two in sync.
// Visit every account ever posted to (the ledger lists them by the latest hash in each account's
// hash-chain) and gather the figures the integrity check needs in one pass.
//
// For each account, recompute the balance by summing its recorded debit and credit entries (source
// of truth) rather than the store's cached running balance, which can be wrong. Add each recomputed
// total into a per-currency running sum signed by the side it grows on: positive for debit-normal,
// negative for credit-normal. A healthy ledger sums to zero in each currency; a non-zero total means
// money was created or destroyed. Separately, when the cached running balance disagrees with the
// recomputed total, report that account as a mismatch instead of folding it into the sum.
async function foldLedger(store: Store): Promise<LedgerFold> {
  let signedByCurrency = new Map<Currency, bigint>();
  let custodialCredit = 0n;
  let anyUserNegative = false;
  let chainIntact = true;
  let drift: LedgerDrift[] = [];

  for await (let [account, head] of store.ledger.heads()) {
    let bal = await store.ledger.balance(account);
    let cur = currency(account);
    // Recompute this account's balance by summing its recorded entries (each already signed the way it
    // changed this account), so the conservation total is built from source-of-truth entries, not the
    // cached running balance. Compared just below to catch a cached balance that no longer matches its
    // entries.
    let derivedMinor = await deriveBalanceMinor(store, account);
    let sign = isDebitNormal(account) ? 1n : -1n;
    signedByCurrency.set(
      cur,
      (signedByCurrency.get(cur) ?? 0n) + derivedMinor * sign,
    );
    if (bal.minor !== derivedMinor) {
      drift.push({
        account,
        materialized: bal,
        derived: toAmount(cur, derivedMinor),
      });
    }
    if (classify(account) === 'custodial' && cur === 'CREDIT') {
      custodialCredit += bal.minor;
    }
    if (isWalletAccount(account) && isNegative(bal)) {
      anyUserNegative = true;
    }
    if (!isWellFormedHead(head)) {
      chainIntact = false;
    }
  }
  // TODO: only accounts that have been posted to (the ones heads() returns) are checked here. A
  // stored balance row with no backing posting would slip through. The thorough prover already
  // covers this via ledger.balanceAccounts() (see integrity.ts foldLedger, R33); port that pass
  // here if this prover needs the same guarantee.
  return {
    signedByCurrency,
    custodialCredit,
    anyUserNegative,
    chainIntact,
    drift,
  };
}

// Mirrors integrity.ts's per-account leg sum; the thorough prover's accumulateLegs is the fuller twin.
// Recompute an account's balance in minor units by summing every statement entry, each already
// signed the way it changed this account. Reproduces what `ledger.balance` should return; comparing
// the two detects a stale cached balance.
async function deriveBalanceMinor(
  store: Store,
  account: AccountRef,
): Promise<bigint> {
  let derivedMinor = 0n;
  let page = await store.ledger.statement(account, PROVE_RANGE);
  for (let entry of page.entries) {
    derivedMinor += entry.amount.minor;
  }
  return derivedMinor;
}

// Range wide enough to cover every entry ever recorded, so a statement over it returns the account's
// whole history. Lower bound inclusive, upper exclusive, matching how the ledger reads a range
// elsewhere.
let PROVE_RANGE = {
  from: Number.MIN_SAFE_INTEGER,
  to: Number.MAX_SAFE_INTEGER,
};

// Convert a credit total into the USD that must back it, in cents, at the fixed CREDIT-to-USD rate.
// The rate is a pair of exact integers (true value `rate` / 10^`scale`), so multiply by `rate` and
// divide by that power of ten. Bigint division drops the remainder, rounding down, so the platform
// never reports needing less cash than it actually does.
function backingRequired(custodialCredit: bigint, par: Rate): bigint {
  return (custodialCredit * par.rate) / 10n ** BigInt(par.scale);
}

// --- Small helpers ----------------------------------------------------------------

// Velocity pieces (riskSubject, attemptMinor, trust.record) are documented at screenRisk above; the
// store applies config.velocityWindowMs when summing a subject's windowed attempts.

// Find the handler for this operation's kind. A missing entry throws a malformed-operation fault.
function resolveHandler(registry: Registry, operation: Operation): Handler {
  let handler = registry[operation.kind];
  if (!handler) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `no handler is registered for operation ${operation.kind}.`,
      { detail: { kind: operation.kind } },
    );
  }
  return handler;
}

function ownedBy(account: AccountRef, userId: string): boolean {
  return account.startsWith(`${userId}:`);
}

// Whether an account's latest entry hash has the expected shape: 64 lowercase hex chars (a hex
// SHA-256). The cheap shape check `chainIntact` uses; does not verify the hash matches the entry it
// covers.
function isWellFormedHead(head: string): boolean {
  return /^[0-9a-f]{64}$/.test(head);
}

function unauthorized(operation: Operation, message: string) {
  return fault(ERROR_CODES.UNAUTHORIZED, message, {
    detail: { kind: operation.kind, actor: operation.actor.kind },
  });
}

// Operations an end user may never run: granting/revoking entitlements, granting promo credits, and
// the manual operator-only corrections (adjust and reverse). Revoking an entitlement names an
// arbitrary account the caller need not own and posts no debit the ownership check could catch, so
// gate on a system or operator principal here.
let RESTRICTED_TO_PRIVILEGED = new Set<Operation['kind']>([
  'grantPromo',
  'grantEntitlement',
  'revokeEntitlement',
  // topUp mints spendable credits — only the trusted payment path (verified processor webhook) may
  // issue; never an end user.
  'topUp',
  'adjust',
  'reverse',
  // refund makes the buyer whole by debiting the seller's earned balance — self-serve is a fraud
  // vector; platform-initiated only.
  'refund',
  // A bank chargeback / fraud recovery: reclaims credits from a user's spendable balance and, for an
  // order-tied chargeback, claims the shared `reversed:${orderId}` key (which would block a later
  // legitimate refund of that order). It takes money out of an account the actor need not own (the
  // ownership rule below doesn't cover it), so like adjust and reverse it must be a system service or
  // operator, never an end user.
  'clawback',
  // A manual payout reversal hands the reserved credits back to the seller and force-fails a payout
  // already in flight. An emergency action run by hand, never by an end user, so like adjust and
  // reverse it is restricted to a system service or human operator.
  'reversePayout',
]);

// The committed outcome an event builder is handed: events emit only after the posting committed, so
// the transaction is always present.
type Committed = Extract<Outcome, { status: 'committed' }>;

// For each operation kind that announces itself, the event to emit on commit: the event name, the
// audience (`client` for an end user, `internal` for back-office consumers), how to derive the
// subject (which user the event is about), and how to build the payload. A client event carries only
// an allow-listed, PII-free summary (a builder must opt a field in); an internal event may carry
// richer detail. Both builders get the committed result, so either can be derived from the entries
// that actually posted; refund needs this, since its operation names only an orderId, not the buyer.
let EVENTS: Partial<
  Record<
    Operation['kind'],
    {
      type: string;
      audience: 'internal' | 'client';
      subject: (operation: Operation, outcome: Committed) => string;
      data: (
        operation: Operation,
        outcome: Committed,
      ) => Record<string, unknown>;
    }
  >
> = {
  topUp: {
    type: 'economy.credits.topped_up',
    audience: 'client',
    subject: (operation) => userSubject(operation),
    data: (operation, outcome) => txnData(operation, outcome),
  },
  grantPromo: {
    type: 'economy.promo.granted',
    audience: 'client',
    subject: (operation) => userSubject(operation),
    data: (operation, outcome) => txnData(operation, outcome),
  },
  spend: {
    type: 'economy.sale.completed',
    audience: 'client',
    subject: (operation) => userSubject(operation),
    data: (operation, outcome) => spendData(operation, outcome),
  },
  // A refund's operation carries only the orderId, so recover the buyer from the posting: the
  // reversing entry credits the buyer's own spendable or promo account, the only user-owned,
  // non-earned entry in it. Sent to the client, since the buyer is told their sale was reversed.
  refund: {
    type: 'economy.sale.refunded',
    audience: 'client',
    subject: (operation, outcome) => refundBuyer(outcome),
    data: (operation, outcome) => ({
      txnId: outcome.transaction.id,
      orderId: opOf<'refund'>(operation).orderId,
      buyerId: refundBuyer(outcome),
    }),
  },
  // An operator or fraud-system action that reclaims credits after a chargeback. Internal-only, not
  // the customer, so the payload may carry richer detail (the reclaimed amount and the disputed
  // order) alongside the transaction id.
  clawback: {
    type: 'economy.credits.clawed_back',
    audience: 'internal',
    subject: (operation) => opOf<'clawback'>(operation).userId,
    data: (operation, outcome) => {
      let op = opOf<'clawback'>(operation);
      let data: Record<string, unknown> = {
        txnId: outcome.transaction.id,
        userId: op.userId,
        amount: encodeAmount(op.amount),
      };
      if (op.orderId !== undefined) {
        data.orderId = op.orderId;
      }
      return data;
    },
  },
  // A payout request. The seller is told their cashout was accepted; the requested amount is safe to
  // send to the client, since it is the seller's own earned credits.
  requestPayout: {
    type: 'economy.payout.requested',
    audience: 'client',
    subject: (operation) => opOf<'requestPayout'>(operation).userId,
    data: (operation, outcome) => {
      let op = opOf<'requestPayout'>(operation);
      return {
        txnId: outcome.transaction.id,
        userId: op.userId,
        amount: encodeAmount(op.amount),
      };
    },
  },
  // The start of a subscription, emitted when subscribe commits. Later lifecycle events (renewed,
  // lapsed) come from the billing worker; this one fires once, up front. Period 1 is the first billed
  // period.
  subscribe: {
    type: 'economy.subscription.started',
    audience: 'client',
    subject: (operation) => opOf<'subscribe'>(operation).userId,
    data: (operation, outcome) => {
      let op = opOf<'subscribe'>(operation);
      return {
        txnId: outcome.transaction.id,
        userId: op.userId,
        sku: op.sku,
        period: 1,
      };
    },
  },
  // A cancellation. Commits without moving money (cancel only flips the subscription's state, no
  // entries), but `emitEvents` fires for any committed outcome, so the event still emits. The
  // subscriptionId is the only identifier the operation carries; no userId, sku, or period.
  cancelSubscription: {
    type: 'economy.subscription.canceled',
    audience: 'client',
    subject: (operation) =>
      opOf<'cancelSubscription'>(operation).subscriptionId,
    data: (operation, outcome) => ({
      txnId: outcome.transaction.id,
      subscriptionId: opOf<'cancelSubscription'>(operation).subscriptionId,
    }),
  },
  // A payout reversal an operator runs by hand. Internal-only, not the customer, since it is an
  // emergency manual action. Same event shape as the reversal the billing worker emits automatically,
  // so a consumer sees one consistent event whether a payout was force-failed by the worker or pulled
  // back by an operator. The seller is the subject.
  reversePayout: {
    type: 'economy.payout.reversed',
    audience: 'internal',
    subject: (operation) => opOf<'reversePayout'>(operation).userId,
    data: (operation) => {
      let op = opOf<'reversePayout'>(operation);
      return { sagaId: op.sagaId, reason: op.reason };
    },
  },
};

// Default payload for kinds with nothing to summarize beyond the txn id.
function txnData(
  _operation: Operation,
  outcome: Committed,
): Record<string, unknown> {
  return { txnId: outcome.transaction.id };
}

// A sale's event payload: the txn id, plus the gift flag and recipient when the buyer bought for
// someone else (VRChat's `isGift`). Only added for a real gift (recipient differs from the buyer),
// so a self-purchase keeps the minimal payload.
function spendData(
  operation: Operation,
  outcome: Committed,
): Record<string, unknown> {
  let base = txnData(operation, outcome);
  if (
    operation.kind === 'spend' &&
    operation.giftTo !== undefined &&
    operation.giftTo !== operation.buyerId
  ) {
    return { ...base, isGift: true, giftTo: operation.giftTo };
  }
  return base;
}

// Narrow the operation union to one kind. The submit pipeline only ever calls a descriptor whose key
// equals `operation.kind`, so the cast is safe; it lets the field reads below typecheck without
// re-discriminating on `kind`. The kind is passed explicitly (e.g. `opOf<'refund'>(operation)`)
// because it can't be inferred from the argument.
function opOf<K extends Operation['kind']>(
  operation: Operation,
): Extract<Operation, { kind: K }> {
  return operation as Extract<Operation, { kind: K }>;
}

// Recover the refunded buyer from the entries of the reversing transaction. A spend takes money out
// of the buyer's own spendable and/or promo accounts, so reversing it credits those same accounts; a
// seller only ever receives credits into their `:earned` account. So the buyer is the user behind the
// single spendable-or-promo wallet entry. Read the userId off that entry's account id (the part
// before the `:kind` suffix) rather than the operation, which carries no buyerId.
function refundBuyer(outcome: Committed): string {
  for (let leg of outcome.transaction.legs) {
    if (!isWalletAccount(leg.account)) {
      continue;
    }
    let colon = leg.account.lastIndexOf(':');
    let kind = leg.account.slice(colon + 1);
    if (kind === 'spendable' || kind === 'promo') {
      return leg.account.slice(0, colon);
    }
  }
  return 'unknown';
}

function userSubject(operation: Operation): string {
  if (operation.kind === 'spend') {
    return operation.buyerId;
  }
  if (operation.kind === 'topUp' || operation.kind === 'grantPromo') {
    return operation.userId;
  }
  return 'unknown';
}
