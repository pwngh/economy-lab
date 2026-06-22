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

// Re-export the public `Economy` type from where it is declared (contract.ts), so callers and
// the test support can import the surface type from this factory, the module that builds it.
export type { Economy } from '#src/contract.ts';

type Handler = (operation: Operation, unit: Unit, ctx: Ctx) => Promise<Outcome>;
type Registry = Partial<Record<Operation['kind'], Handler>>;

/**
 * Build a ready-to-use {@link Economy} from the injected capabilities (the store, clock, ids,
 * and everything else the system needs from the outside world).
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

// The `Ctx` is the slice of capabilities an operation handler is allowed to read while it runs.
// It is everything in `capabilities` except the store (handlers get the store's per-transaction
// view instead) and the scheduler and dispatcher (which this factory keeps to itself). The
// optional `cache` is threaded through so the read-through balance cache can use it; it is
// `undefined` when no cache capability was injected, which leaves every read path unchanged.
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

// --- The read-through balance cache -----------------------------------------------

// The cache key for one account's balance. Namespaced with a `bal:` prefix so balance entries
// never collide with anything else a shared cache might hold.
function cacheKey(account: AccountRef): string {
  return `bal:${account}`;
}

// Read an account's balance, going through `ctx.cache` when one is present. When no cache was
// injected the call is exactly `ledger.balance(account, options)`, so the behavior is identical
// to having no cache at all. With a cache: return the cached figure on a hit; otherwise read the
// ledger, store the result in the cache, and return it. The amount is stored as its `encodeAmount`
// string (which also carries the currency), so the exact bigint minor-unit value survives a cache
// that can only hold strings. Only the public `read.balance` is routed through here; balance reads
// taken inside a write transaction (while it holds a lock) stay direct on purpose, so a
// transaction never sees a stale cached value.
async function cachedBalance(
  ctx: Ctx,
  ledger: Ledger,
  account: AccountRef,
  options?: Options,
): Promise<Amount> {
  if (!ctx.cache) {
    return ledger.balance(account, options);
  }
  let key = cacheKey(account);
  let hit = await ctx.cache.get(key);
  if (hit !== null) {
    return amountFromCache(hit);
  }
  let fresh = await ledger.balance(account, options);
  await ctx.cache.set(key, encodeAmount(fresh));
  return fresh;
}

// Rebuild an Amount from its cached `encodeAmount` form (`'CREDIT:12.34'`). The currency sits
// before the colon and the decimal after it, so the string alone carries everything `decodeAmount`
// needs — the same split the wire and postgres adapters use to parse an encoded amount.
function amountFromCache(encoded: string): Amount {
  let colon = encoded.indexOf(':');
  let cur = encoded.slice(0, colon) as Currency;
  return decodeAmount(encoded.slice(colon + 1), cur);
}

// --- The request-processing pipeline ----------------------------------------------

// Run one operation end to end. The order matters:
//
//   1. authorize first, so a forbidden request is thrown out before anything else happens;
//   2. then do the money work inside one database transaction (see `runOnion`), which commits
//      all or nothing. The risk-velocity attempt is recorded INSIDE that transaction's
//      `screenRisk` step (via the trust store's own atomic `record`, which is serialized per
//      subject and not undone by a rollback), so the attempt is counted at check time — never
//      again afterward. Recording at check time is what closes the velocity-limit TOCTOU: the
//      old design read the windowed total before the work and bumped it only here, after the
//      commit, so N concurrent same-subject submits all read the same pre-bump total and all
//      slipped past the limit.
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

// The largest amount, in minor units, any single operation may move. A generous ceiling that still
// blocks absurd or overflow-scale values from an operator typo or a hostile caller.
let MAX_OP_AMOUNT_MINOR = 1_000_000_000_000_000n;

// Reject a malformed operation before any work begins. This is the shared first line of defense
// every operation passes through, so a structural problem is caught once here rather than in each
// handler. It enforces three things that hold for every kind:
//   - a non-empty idempotency key, so genuinely distinct requests can't collapse into one
//     "duplicate" (which would silently drop a second purchase/payout/refund);
//   - no user wallet account with a blank owner (an empty user id would build a ":spendable"-style
//     account and leave a phantom, ownerless wallet behind);
//   - a money amount that is sane and in range (positive, or merely non-zero for a two-way
//     `adjust` correction, and within the ceiling above).
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

// The single money amount an operation moves, or null for the kinds that move none (they reference
// an existing transaction, order, or subscription instead).
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

// Reject an operation whose money amount is non-positive (zero or negative) or beyond the ceiling.
// A manual `adjust` correction may debit or credit, so it only has to be non-zero; every other
// money movement must be strictly positive.
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
// recomputes from the ledger instead of serving the now-stale pre-posting figure. This is a
// strict no-op in two cases: when no cache capability was injected (`ctx.cache` is undefined),
// and when the outcome wasn't a commit (a rejected or duplicate request changed no balance).
// The touched accounts are exactly `accountsOf(operation)` — the same set `lockAccounts` locks —
// de-duplicated so each key is invalidated once.
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
    await cache.invalidate(cacheKey(account));
  }
}

// The body of the database transaction: the actual sequence of checks and the money posting.
// Each request carries an idempotency key — a value that makes a retried request run at most
// once, since a repeat with the same key is recognized and not applied again. Returning a
// `rejected` outcome or throwing a fault rolls the whole transaction back, which means this
// request's idempotency key is NOT marked as used — so the caller can safely retry a rejected
// request later under the same key.
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

// Decide whether the caller is allowed to run this operation; throw an UNAUTHORIZED fault if
// not. The rule for an end user: they may run an operation only if every one of THEIR OWN
// accounts that it takes money OUT of belongs to them. Taking money out of someone else's
// account is forbidden, but paying money INTO another user's account, or moving the balancing
// amount through a platform account, is fine. Privileged-only operations (grants, and the
// manual operator corrections) are off-limits to end users entirely. This runs before the
// operation is even claimed for processing.
function authorize(operation: Operation): void {
  let actor = operation.actor;
  if (actor.kind === 'operator') {
    // A human operator runs manual corrections; the postings they make are fully audited and
    // record the reason, so they are allowed through here.
    return;
  }
  if (actor.kind === 'system') {
    // A trusted internal service. It currently has full access; per-service permission lists
    // are a later addition.
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

// The user accounts this operation takes money OUT of — the only ones the ownership check above
// cares about. This is intentionally narrower than `accountsOf` (which lists every account to
// lock): platform accounts and any user account being paid INTO are left out, because only an
// account being drained has to belong to the caller.
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

// Check up front that every account has enough money to cover what the operation will take from
// it, and return a `rejected` outcome (not throw) if one falls short — this is a normal "you
// can't afford this" answer, returned before any money is posted. The amount required per
// account comes from the same calculation the handler will use to post, so this pre-check and
// the real posting can never disagree on how much is needed. Returns null when funds are fine.
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

// How much each user account must have for the operation to go through. Only `spend` can run a
// user short: a purchase is paid from the buyer's promo balance first and then their spendable
// balance, so promo never overdraws (it's only ever spent down to zero) and spendable is the
// one account that can be too low. So this returns the exact spendable amount the purchase will
// draw. Every other operation returns nothing to check.
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

// The risk check: would this operation push the user past their recent-spending limit? It
// records THIS attempt and reads back the resulting windowed total in one atomic, per-subject
// step (`trust.record`), then denies if that total — which already INCLUDES this attempt — is
// over the limit. Recording at check time, rather than reading first and bumping after the
// commit, is what closes the velocity-limit TOCTOU: two concurrent same-subject submits can no
// longer both read a stale pre-bump total and both pass. The record goes straight through the
// trust store (NOT the transaction's view of it), so even a denied attempt — or one whose money
// transaction later rolls back — still counts against the limit; an attacker can't probe the
// limit for free. Returns a `rejected` outcome when the windowed total is over the limit, or
// null when it's within bounds.
async function screenRisk(step: Step): Promise<Outcome | null> {
  let { pipeline, operation, options } = step;
  let subject = riskSubject(operation);
  if (subject === null) {
    return null;
  }
  // Record this attempt with a fixed `committed` tag and the amount it would move. The outcome
  // tag is write-only — the limit logic sums every attempt's amount regardless of tag — so a
  // fixed tag at check time is faithful. The returned velocity already includes this attempt, so
  // the comparison is the raw windowed total against the limit, with no second add of this
  // attempt's amount (that would double-count it).
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

// Lock every account the operation will touch before it posts, so two operations on the same
// accounts can't interleave and corrupt a balance. The accounts are locked in a fixed order
// (sorted by the default string `.sort()`, whose raw character-code order is identical on every
// machine, unlike a locale-aware comparison), so operations that share an account grab their locks in
// the same order. That consistent ordering is what prevents a deadlock where each operation
// waits on a lock the other already holds.
async function lockAccounts(step: Step): Promise<void> {
  let { unit, operation, options } = step;
  let sorted = [...new Set(accountsOf(operation))].sort();
  for (let account of sorted) {
    await unit.ledger.lock(account, options);
  }
}

// After a successful posting, queue the matching notification event (e.g. "credits topped up").
// The event is written into the outbox inside the SAME transaction as the money posting, so it
// can only ever be sent if the posting actually committed — a rolled-back posting leaves no
// stray event behind, and a committed one is guaranteed to have its event queued.
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
    // Each event kind builds its own payload from the operation and the committed result. That
    // way a consumer reading the event learns what happened without re-fetching the transaction,
    // and an event sent to an end-user client carries only an explicitly allow-listed, PII-free
    // summary (the rule is deny-by-default: nothing is exposed unless a builder opts it in).
    data: descriptor.data(operation, outcome),
    audience: descriptor.audience,
  };
  await unit.outbox.enqueue(
    { id: ctx.ids.next('obx'), event, status: 'pending', attempts: 0 },
    options,
  );
}

// --- The operation registry -------------------------------------------------------

// --- The funds plan (shared by screenFunds and the spend handler) -----------------

type SpendPlan = { promoPart: Amount; spendablePart: Amount };

// Work out how a purchase is paid for: promo balance first, then spendable. The promo part is
// whichever is smaller, the price or the available promo balance; the spendable part is the
// rest. Both the up-front funds check and the actual posting call this one function, so they
// can never disagree about how much comes from each account.
function planSpend(price: Amount, promoBalance: Amount): SpendPlan {
  let available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  let promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount(price.currency, promoMinor),
    spendablePart: toAmount(price.currency, price.minor - promoMinor),
  };
}

// --- The integrity check ----------------------------------------------------------

/**
 * Walk every account once and report whether the ledger still holds its core guarantees; see
 * the {@link ProveReport} fields for what each returned flag means.
 *
 * The `backed` flag checks that the platform is holding enough real cash to cover what it owes
 * users. It adds up the credit balances the platform actually owes a user and must hold USD
 * against — the user-spendable accounts, which `classify` labels "custodial" and which
 * deliberately exclude earned, promo, and the payout reserve. It converts that credit
 * total to USD at the fixed CREDIT-to-USD rate, and checks the platform's cash account holds at
 * least that much.
 *
 * `chainIntact` here is only a quick shape check on each account's latest hash; the full replay
 * that re-verifies every recorded posting lives in integrity.ts.
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

// Visit every account that has ever been posted to (the ledger lists them by the most recent
// hash in each account's hash-chain) and gather the figures the integrity check needs in one
// pass.
//
// For each account it recomputes the balance by summing that account's recorded debit and
// credit entries — the source of truth — rather than reading the running balance the store
// keeps as a cache, which can be wrong. Each account's recomputed total is added into a
// per-currency running sum with the sign of the side that account grows on: positive for
// accounts that grow on the debit side, negative for those that grow on the credit side. With
// that sign convention a healthy, balanced ledger sums to exactly zero in each currency; any
// non-zero total means money was created or destroyed. Separately, whenever the cached running
// balance disagrees with the recomputed total, that account is reported as a mismatch instead of
// being quietly folded into the sum.
async function foldLedger(store: Store): Promise<LedgerFold> {
  let signedByCurrency = new Map<Currency, bigint>();
  let custodialCredit = 0n;
  let anyUserNegative = false;
  let chainIntact = true;
  let drift: LedgerDrift[] = [];

  for await (let [account, head] of store.ledger.heads()) {
    let bal = await store.ledger.balance(account);
    let cur = currency(account);
    // Recompute this account's balance by summing its recorded entries (each statement entry is
    // already signed the way it changed this account), so the conservation total is built from the
    // source-of-truth entries, not the cached running balance — and the two are compared just
    // below to catch a cached balance that no longer matches what its entries sum to.
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
  // TODO: only accounts that have been posted to (the ones `heads()` returns) are checked. A
  // stored balance row that has no backing posting at all would slip through; catching it would
  // need a separate store method that enumerates every balance row, which does not exist yet.
  return {
    signedByCurrency,
    custodialCredit,
    anyUserNegative,
    chainIntact,
    drift,
  };
}

// Recompute an account's balance in minor units by summing every statement entry, each of whose
// amounts is already signed the way it changed this account. The sum reproduces what
// `ledger.balance` should return; comparing the two is how a stale cached balance is detected.
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

// A time range wide enough to cover every entry ever recorded, so a statement over it returns the
// account's whole history. The range includes its lower bound but excludes its upper bound,
// matching how the ledger interprets a range elsewhere.
let PROVE_RANGE = {
  from: Number.MIN_SAFE_INTEGER,
  to: Number.MAX_SAFE_INTEGER,
};

// Convert a credit total into the real USD that must back it, in cents, at the fixed
// CREDIT-to-USD rate. That rate is stored as a pair of exact integers — its true value is
// `rate` divided by `10` to the power of `scale` — so this multiplies the credit total by `rate`
// and divides by that power of ten. Integer (bigint) division throws away any remainder, which
// here rounds the cash figure down, so the platform never reports needing less cash than it
// actually does.
function backingRequired(custodialCredit: bigint, par: Rate): bigint {
  return (custodialCredit * par.rate) / 10n ** BigInt(par.scale);
}

// --- Small helpers ----------------------------------------------------------------

// The velocity rule's shared pieces live in trust.ts: `riskSubject` picks the subject a limit is
// tracked against, and `attemptMinor` says how much an operation adds to its subject's running
// total. `screenRisk` builds the attempt from those two, then both records it and reads back the
// windowed total in one atomic step (`trust.record`), comparing that total against
// `config.velocityLimitMinor`. Because the same call records and measures, the check can never
// disagree with what was counted. The store applies the window length (`config.velocityWindowMs`)
// when it sums a subject's attempts.

// Find the handler for this operation's kind. If the registry has no entry for it, that's
// treated as a malformed operation and a fault is thrown rather than failing silently.
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

// Whether an account's latest entry hash has the expected shape: 64 lowercase hex characters (a
// SHA-256 hash written in hex). This is the cheap shape check `chainIntact` uses; it does not
// verify that the hash actually matches the entry it claims to cover.
function isWellFormedHead(head: string): boolean {
  return /^[0-9a-f]{64}$/.test(head);
}

function unauthorized(operation: Operation, message: string) {
  return fault(ERROR_CODES.UNAUTHORIZED, message, {
    detail: { kind: operation.kind, actor: operation.actor.kind },
  });
}

// The operations an end user is never allowed to run: handing out and taking back
// entitlements, handing out promo credits, and the two manual operator-only corrections
// (adjust and reverse). Revoking an entitlement names an arbitrary account the caller need
// not own and posts no debit the ownership check could catch, so the only safe rule is to
// gate them on a system or operator principal here.
let RESTRICTED_TO_PRIVILEGED = new Set<Operation['kind']>([
  'grantPromo',
  'grantEntitlement',
  'revokeEntitlement',
  // Credit issuance: a top-up mints spendable credits and records the matching trust cash, so it is
  // only ever driven by the trusted payment path (a verified processor webhook run as a system
  // service). An end user must never self-issue credits, so it is system/operator-only.
  'topUp',
  'adjust',
  'reverse',
  // Refunding a sale makes the buyer whole and debits the seller's earned balance. Letting a buyer
  // or seller self-serve it is a theft/fraud vector, and no end-user refund path exists today, so it
  // is platform-initiated only — system or operator. (If a seller-self-refund model is ever wanted,
  // loosen this to a seller-ownership check rather than opening it to all users.)
  'refund',
  // A bank chargeback / fraud recovery: it reclaims credits from a user's spendable balance and,
  // for an order-tied chargeback, claims the shared `reversed:${orderId}` key — which would block a
  // later legitimate refund of that order. It takes money OUT of an account the actor need not own
  // (the ownership rule below doesn't cover it), so — like adjust and reverse — it must be a system
  // service or operator, never an end user.
  'clawback',
  // A manual payout reversal hands the reserved credits back to the seller and force-fails a
  // payout already in flight. It is an emergency action run by hand, never by an end user, so
  // like adjust and reverse it is restricted to a system service or human operator.
  'reversePayout',
]);

// The committed outcome an event builder is handed: every event is emitted only after the
// posting committed, so the transaction is always present.
type Committed = Extract<Outcome, { status: 'committed' }>;

// For each operation kind that announces itself, the event to emit when it commits: the event
// name, who it's for (`client` for an end user, `internal` for back-office consumers), how to
// derive the subject (which user the event is about), and how to build the event payload. An
// event sent to a client carries only an explicitly allow-listed, PII-free summary — nothing is
// exposed unless a builder opts it in — while an internal event may carry richer detail. Both
// the subject and data builders are given the committed result, so either can be derived from
// the debit and credit entries that actually posted; refund needs this, because its operation
// names only an orderId and not the buyer.
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
  // A refund's operation carries only the orderId, so the buyer is recovered from the posting
  // itself: the reversing entry credits the buyer's own spendable or promo account, which is the
  // only user-owned, non-earned entry in it. Sent to the client, since the buyer is told their
  // sale was reversed.
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
  // An operator or fraud-system action that reclaims credits after a chargeback. Sent only to
  // internal consumers, not the customer, so the payload may carry richer detail — the reclaimed
  // amount and the disputed order — alongside the transaction id.
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
  // A payout request. The seller is told their cashout was accepted; the requested amount is
  // safe to send to the client, since it is the seller's own earned credits.
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
  // The start of a subscription, emitted when the subscribe operation commits. Later lifecycle
  // events (renewed, lapsed) are emitted elsewhere by the billing worker; this one fires once, up
  // front. Period 1 is the first billed period.
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
  // A cancellation. It commits without moving any money — cancel only flips the subscription's
  // state and records no debit or credit entries — but `emitEvents` fires for any committed
  // outcome, so the event is still emitted. The subscriptionId is the only identifier the
  // operation carries; it has no userId, sku, or period.
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
  // A payout reversal an operator runs by hand. Sent only to internal consumers, not the
  // customer, since it is an emergency manual action. It is given the same event shape as the
  // reversal the billing worker emits automatically, so a consumer sees one consistent event
  // whether a payout was force-failed by the worker or pulled back by an operator. The seller is
  // the subject.
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

// The default payload for the simple kinds that have nothing to summarize beyond the txn id.
function txnData(
  _operation: Operation,
  outcome: Committed,
): Record<string, unknown> {
  return { txnId: outcome.transaction.id };
}

// A sale's event payload: the txn id, plus the gift flag and recipient when the buyer bought the
// item for someone else (VRChat's `isGift`). Only added for a real gift (recipient differs from
// the buyer), so an ordinary self-purchase keeps the minimal payload.
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

// Narrow the operation union to one kind. The submit pipeline only ever calls a descriptor
// whose key equals `operation.kind`, so the cast is safe; it lets the field reads below
// typecheck without re-discriminating on `kind`. The kind is passed explicitly — e.g.
// `opOf<'refund'>(operation)` — because it can't be inferred from the argument.
function opOf<K extends Operation['kind']>(
  operation: Operation,
): Extract<Operation, { kind: K }> {
  return operation as Extract<Operation, { kind: K }>;
}

// Recover the refunded buyer from the debit and credit entries of the reversing transaction. A
// spend takes money out of the buyer's own spendable and/or promo accounts, so reversing it puts
// money back into those same accounts; a seller only ever receives credits into their `:earned`
// account. So the buyer is the user behind the single spendable-or-promo wallet entry. We read
// the userId off that entry's account id (the part before the `:kind` suffix) rather than
// trusting the operation, which carries no buyerId.
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
