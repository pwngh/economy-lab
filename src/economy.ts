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
 * The submit pipeline: validate, authorize, then one all-or-nothing transaction that claims the
 * idempotency key, screens risk and funds, runs the handler, and queues the event. `createEconomy`
 * builds the public Economy (submit + read + close); the handlers live in src/operations/.
 */

import { fault, rejected, ERROR_CODES } from '#src/errors.ts';
import { lockAll } from '#src/ledger.ts';
import {
  compare,
  decodeAmountWire,
  encodeAmount,
  isNegative,
  toAmount,
} from '#src/money.ts';
import {
  SYSTEM,
  baseOf,
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
import { economyPaused } from '#src/config.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Amount, Currency } from '#src/money.ts';
import type {
  Ctx,
  Economy,
  EconomyStatus,
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

/**
 * Re-exports the public `Economy` type, which is declared in contract.ts, so callers and test
 * support can import it from this factory.
 */
export type { Economy } from '#src/contract.ts';

type Handler = (operation: Operation, unit: Unit, ctx: Ctx) => Promise<Outcome>;
type Registry = Partial<Record<Operation['kind'], Handler>>;

/**
 * Build an {@link Economy} from the injected capabilities (store, clock, ids, etc.).
 *
 * @example
 * const economy = createEconomy(capabilities);
 * const outcome = await economy.submit(operation);
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for the
 * construction, the submit/read surface, and the request path.
 */
export function createEconomy(capabilities: Capabilities): Economy {
  const store = capabilities.store;
  const ctx = contextOf(capabilities);
  const registry = REGISTRY;

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
      status: () => economyStatus(ctx),
      accounts: (options) => store.ledger.balanceAccounts(options),
      payouts: (options) => store.sagas.list(options),
      postings: (options) => store.ledger.list(options),
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
  // Called by screenRisk with the velocity attempt it is about to record inside the transaction,
  // so `submit` can re-record the attempt if that transaction rolls back.
  staged?: (subject: string, attempt: Attempt) => void;
};

// Builds the runtime context a handler may read. It holds every capability except the store, which
// handlers receive as a per-transaction view, and the scheduler and dispatcher, which this factory
// keeps. `cache` is undefined when no cache was injected, which leaves every read path unchanged.
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

// Reports the economy's current pause state. It derives the state from the configured maintenance
// window and the clock, and never stores it, so the read surface and the submit gate read the same
// source. `resumesAt` is the window's end while paused, otherwise null. This mirrors the
// ECONOMY_PAUSED gate in `submit`.
function economyStatus(ctx: Ctx): EconomyStatus {
  const { pauseStartMs, pauseEndMs } = ctx.config;
  const paused = economyPaused(ctx.clock.now(), ctx.config);
  return {
    paused,
    pauseStart: pauseStartMs,
    pauseEnd: pauseEndMs,
    resumesAt: paused ? pauseEndMs : null,
  };
}

// --- Read-through balance cache ----------------------------------------------------

// The `bal:` prefix avoids collisions in a shared cache.
function cacheKey(account: AccountRef): string {
  return `bal:${account}`;
}

// Runs a cache operation, logging and falling back on any error: a `get` becomes a miss and a `set`
// or `invalidate` a no-op. The cache is best-effort, so adding one can only speed reads, never make
// them fail (a driver's retryable STORE.FAILURE is absorbed here).
// See https://economy-lab-docs.pages.dev/economy/ports/storage/ for why the cache is
// best-effort and every miss is safe.
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

// Reads an account's balance through `ctx.cache` when one is present, otherwise straight from
// `ledger.balance`. On a miss it reads the ledger, stores the result, and returns it. The value is
// stored as the `encodeAmount` string, which carries the currency, so the exact bigint minor-unit
// value survives a string-only cache. Only the public `read.balance` routes through here. Reads
// inside a write transaction, which hold a lock, stay direct, so a transaction never sees a stale
// cached value.
async function cachedBalance(
  ctx: Ctx,
  ledger: Ledger,
  account: AccountRef,
  options?: Options,
): Promise<Amount> {
  const cache = ctx.cache;
  if (!cache) {
    return ledger.balance(account, options);
  }
  const key = cacheKey(account);
  const hit = await bestEffortCache<string | null>(
    ctx,
    'get',
    () => cache.get(key),
    null,
  );
  if (hit !== null) {
    return decodeAmountWire(hit);
  }
  const fresh = await ledger.balance(account, options);
  await bestEffortCache<void>(
    ctx,
    'set',
    () => cache.set(key, encodeAmount(fresh)),
    undefined,
  );
  return fresh;
}

// --- Request-processing pipeline ---------------------------------------------------

// Runs one operation end to end. The order matters:
//   1. authorize first, so a forbidden request is rejected before any work;
//   2. then do the money work in one all-or-nothing transaction (see `runOnion`).
// The risk-velocity attempt is recorded inside that transaction (`screenRisk`), so a committed
// operation pays one durable commit, not two. If the transaction rolls back, the attempt is
// re-recorded below on the store's own connection. See `screenRisk` for why recording at check
// time, not after the commit, closes the velocity-limit TOCTOU.
async function submit(
  pipeline: Pipeline,
  operation: Operation,
  options?: Options,
): Promise<Outcome> {
  validateOperation(operation, pipeline.ctx.config.platformShards);
  authorize(operation);

  // Maintenance window. Refuse only an end user's discretionary write, never a 'system' settlement
  // webhook or operator fix. This gate sits before the transaction opens, so a paused user op records
  // no velocity attempt and touches no ledger. Reads never reach this path.
  // See https://economy-lab-docs.pages.dev/economy/concepts/actors-and-authorization/ for why the
  // pause tells actors apart by kind.
  const ctx = pipeline.ctx;
  if (
    operation.actor.kind === 'user' &&
    economyPaused(ctx.clock.now(), ctx.config)
  ) {
    return rejected('ECONOMY_PAUSED', { resumesAt: ctx.config.pauseEndMs });
  }

  // A rejected outcome must roll back, not commit, so it leaves the idempotency key UNUSED and the
  // caller can retry under it (runOnion's contract). Committing would persist MySQL's claim
  // placeholder row, while Postgres holds only a transaction advisory lock and inserts nothing, so
  // the two engines would diverge. Throw the RejectedRollback sentinel to roll back exactly as a
  // fault does, then recover the outcome outside the transaction.
  //
  // The rollback also erases the velocity attempt screenRisk recorded inside the transaction, so
  // re-record it here on the store's own connection. `bump` dedupes on the attempt's key, so a
  // retried operation never double-counts. On a rejection, a failed re-record propagates as a
  // fault: silently losing the attempt would let a caller probe the limit for free. On a genuine
  // fault, the original error wins and the re-record is only best-effort, since the store is
  // already suspect.
  let staged: { subject: string; attempt: Attempt } | null = null;
  const outcome = await pipeline.store
    .transaction(
      (unit) =>
        runRollingBackRejections({
          pipeline,
          unit,
          operation,
          options,
          staged: (subject, attempt) => {
            staged = { subject, attempt };
          },
        }),
      options,
    )
    .catch(async (error: unknown) => {
      if (error instanceof RejectedRollback) {
        if (staged) {
          await pipeline.store.trust.bump(
            staged.subject,
            staged.attempt,
            options,
          );
        }
        return error.outcome;
      }
      if (staged) {
        await pipeline.store.trust
          .bump(staged.subject, staged.attempt, options)
          .catch(() => {});
      }
      throw error;
    });

  await invalidateCache(pipeline, operation, outcome);
  return outcome;
}

// Thrown to roll back a transaction whose outcome is `rejected` while still surfacing that outcome,
// since a rejection is not an error to the caller. It is a distinct class so submit can tell it apart
// from a genuine fault, which must keep propagating and rolling back as it always has.
class RejectedRollback extends Error {
  outcome: Outcome;
  constructor(outcome: Outcome) {
    super('rejected outcome rolled back');
    this.outcome = outcome;
  }
}

// Runs the onion, then forces a rollback on a `rejected` outcome by throwing the sentinel. A
// committed or duplicate outcome returns normally, so the transaction commits.
async function runRollingBackRejections(step: Step): Promise<Outcome> {
  const outcome = await runOnion(step);
  if (outcome.status === 'rejected') {
    throw new RejectedRollback(outcome);
  }
  return outcome;
}

// The largest amount, in minor units, any single operation may move. The limit is high enough for
// legitimate operations but blocks overflow-scale values from a typo or a hostile caller.
const MAX_OP_AMOUNT_MINOR = 1_000_000_000_000_000n;

// Rejects a malformed operation before any work begins. The check lives here, caught once, rather
// than in each handler. It enforces three things for every kind. First, the operation needs a
// non-empty idempotency key, so distinct requests cannot collapse into one "duplicate" and drop a
// second purchase, payout, or refund. Second, no user wallet account may have a blank owner, because
// an empty user id builds a ":spendable"-style account and leaves a phantom, ownerless wallet. Third,
// the money amount must be in range: positive, or merely non-zero for a two-way `adjust`, and within
// the ceiling above. Handlers still re-check what is specific to them, such as currency, sufficiency,
// and business rules. Shards reroute only platform accounts, so the shard count cannot change what
// the blank-owner loop sees; it is passed so every accountsOf caller agrees.
function validateOperation(operation: Operation, shards: number): void {
  if (
    typeof operation.idempotencyKey !== 'string' ||
    operation.idempotencyKey.trim() === ''
  ) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'operation is missing a non-empty idempotencyKey.',
      { detail: { kind: operation.kind } },
    );
  }

  for (const account of accountsOf(operation, shards)) {
    if (isWalletAccount(account) && ownerOf(account).trim() === '') {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'operation names a wallet account with a blank user id.',
        { detail: { kind: operation.kind } },
      );
    }
  }

  assertAmountInRange(operation);
}

// Returns the money amount an operation moves, or null for kinds that move none. Those kinds
// reference an existing transaction, order, or subscription instead.
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

// Rejects an operation whose money amount is non-positive or beyond the ceiling. A manual `adjust`
// may debit or credit, so it only has to be non-zero. Every other movement must be strictly
// positive.
function assertAmountInRange(operation: Operation): void {
  const amount = operationAmount(operation);
  if (amount === null) {
    return;
  }
  const signOk =
    operation.kind === 'adjust' ? amount.minor !== 0n : amount.minor > 0n;
  if (!signOk) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      operation.kind === 'adjust'
        ? 'operation amount must be non-zero.'
        : 'operation amount must be positive.',
      { detail: { kind: operation.kind, amount: encodeAmount(amount) } },
    );
  }
  const magnitude = amount.minor < 0n ? -amount.minor : amount.minor;
  if (magnitude > MAX_OP_AMOUNT_MINOR) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      'operation amount exceeds the maximum allowed.',
      { detail: { kind: operation.kind, amount: encodeAmount(amount) } },
    );
  }
}

// Drops the cached balance of every account a committed transaction touched, so the next read
// recomputes from the ledger instead of serving the stale pre-posting figure. It is a no-op when no
// cache was injected, or when the outcome was not a commit, since a rejected or duplicate outcome
// changed no balance. The touched accounts are `accountsOf(operation)` under the configured shard
// count, the same set `lockAccounts` locks, de-duplicated so each key is invalidated once.
async function invalidateCache(
  pipeline: Pipeline,
  operation: Operation,
  outcome: Outcome,
): Promise<void> {
  const cache = pipeline.ctx.cache;
  if (!cache || outcome.status !== 'committed') {
    return;
  }
  const shards = pipeline.ctx.config.platformShards;
  for (const account of new Set(accountsOf(operation, shards))) {
    await bestEffortCache<void>(
      pipeline.ctx,
      'invalidate',
      () => cache.invalidate(cacheKey(account)),
      undefined,
    );
  }
}

// The transaction body: claim the idempotency key, run the checks and the money posting, then record
// the outcome under the key on commit. A repeat with the same key replays the recorded result; a
// rejected or faulted request rolls back and leaves the key unused for a retry.
// See https://economy-lab-docs.pages.dev/economy/concepts/idempotency/ for the claim/record model.
async function runOnion(step: Step): Promise<Outcome> {
  const { unit, operation, options } = step;
  const claim = await unit.idempotency.claim(operation.idempotencyKey, options);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  // Risk runs before funds: a burst of unaffordable spends still counts toward the limit
  // (screenRisk records the attempt at check time), and a velocity-exceeded request is denied
  // whether or not it could pay. Both screens run before any money moves, so the order is free to
  // choose.
  const risk = await screenRisk(step);
  if (risk) {
    return risk;
  }

  // Screen funds after the lock, so the read is current, and cache balances in `unit.balances` so the
  // screen and handler share one read each. Risk still records before the lock, so denied attempts count.
  await lockAccounts(step);
  unit.balances = new Map();
  const funds = await screenFunds(step);
  if (funds) {
    return funds;
  }

  const handler = resolveHandler(step.pipeline.registry, operation);
  const outcome = await handler(operation, unit, step.pipeline.ctx);
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

// Decides whether the caller may run this operation, and throws an UNAUTHORIZED fault if not. This
// runs before the operation is claimed.
// See https://economy-lab-docs.pages.dev/economy/concepts/actors-and-authorization/ for the actor
// kinds, the user-may-only-debit-own-accounts rule, and the privileged-only set.
function authorize(operation: Operation): void {
  const actor = operation.actor;
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
  for (const account of debitedUserAccounts(operation)) {
    if (!ownedBy(account, actor.userId)) {
      throw unauthorized(operation, 'a user may not debit another account');
    }
  }
}

// Returns the user accounts this operation debits, the only ones the ownership check cares about.
// This is narrower than `accountsOf`, which lists every account to lock. It leaves out platform
// accounts and any user account being paid into, since only a drained account has to belong to the
// caller.
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

// Checks up front that every account can cover what the operation will take, before any money is
// posted. It returns a `rejected` outcome, rather than throwing, if one falls short, and returns null
// when funds are fine. The required amount per account comes from the same calculation the handler
// uses to post, so the pre-check and the posting cannot disagree.
//
// This is a courtesy pre-check, not the enforcer. No-overdraft is enforced by the database, in the
// user_account_non_negative CHECK in db/*-schema.sql. This check exists so an overspend returns a
// clean `rejected` outcome, submit()'s ordinary "no", instead of the engine throwing a constraint
// violation. The engine is the backstop, and this is the kind error.
async function screenFunds(step: Step): Promise<Outcome | null> {
  const { unit, operation, options } = step;
  for (const need of await fundsNeeded(unit, operation, options)) {
    const have = await readCachedBalance(unit, need.account, options);
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

// Returns how much each user account must hold for the operation to go through. Only `spend` can run
// a user short. A purchase draws promo first, then spendable, so promo never overdraws and is only
// spent to zero, which leaves spendable as the one account that can be too low. This returns the
// exact spendable amount the purchase will draw. Every other operation returns nothing to check.
async function fundsNeeded(
  unit: Unit,
  operation: Operation,
  options?: Options,
): Promise<ReadonlyArray<{ account: AccountRef; amount: Amount }>> {
  if (operation.kind !== 'spend') {
    return [];
  }
  const promoBalance = await readCachedBalance(
    unit,
    promo(operation.buyerId),
    options,
  );
  const plan = planSpend(operation.price, promoBalance);
  return [
    { account: spendable(operation.buyerId), amount: plan.spendablePart },
  ];
}

// Reads a balance once per operation: runOnion seeds `unit.balances` after locking, so the funds screen
// and the handler share one read. Without the cache (a unit built outside the pipeline) it reads through.
async function readCachedBalance(
  unit: Unit,
  account: AccountRef,
  options?: Options,
): Promise<Amount> {
  const cached = unit.balances?.get(account);
  if (cached !== undefined) {
    return cached;
  }
  const balance = await unit.ledger.balance(account, options);
  unit.balances?.set(account, balance);
  return balance;
}

// Checks whether this operation would push the user past their recent-spending limit, returning
// `rejected` if so else null. It records this attempt and reads back the windowed total in one atomic
// per-subject step (`trust.record`), then denies if that total (already including this attempt) is
// over the limit. Recording at check time, not reading-then-bumping after commit, closes the
// velocity-limit TOCTOU: two concurrent same-subject submits cannot both read a stale total and pass.
// The record goes through the transaction's trust view, so a committed operation carries its
// attempt in the same durable commit. The attempt is staged with `submit` first, which re-records
// it if the transaction rolls back — see there for why a denied attempt must still count. The
// store applies config.velocityWindowMs when summing a subject's windowed attempts.
async function screenRisk(step: Step): Promise<Outcome | null> {
  const { pipeline, unit, operation, options } = step;
  const subject = riskSubject(operation);
  if (subject === null) {
    return null;
  }
  // Record this attempt with a fixed `committed` tag and the amount it would move. The outcome tag is
  // write-only, because the limit logic sums every attempt's amount regardless of tag, so a fixed tag
  // at check time is faithful. The returned velocity already includes this attempt, so compare the
  // raw windowed total against the limit without re-adding this attempt's amount, which would
  // double-count.
  const attempt: Attempt = {
    idempotencyKey: operation.idempotencyKey,
    amount: toAmount(VELOCITY_CURRENCY, attemptMinor(operation)),
    at: pipeline.ctx.clock.now(),
    outcome: 'committed',
  };
  step.staged?.(subject, attempt);
  const velocity = await unit.trust.record(subject, attempt, options);
  if (velocity.spent.minor > pipeline.ctx.config.velocityLimitMinor) {
    return rejected('RISK_DENIED', { subject });
  }
  return null;
}

// Locks every account the operation will touch before posting, via `lockAll` (src/ledger.ts), which
// takes them in the deadlock-free global order every lock-set shares.
//
// This is app-side concurrency control, deliberately: the write runs at the engine's default
// isolation, not SERIALIZABLE, so this fixed-order locking, not the engine, is what serializes
// contending operations. The engine still enforces each invariant's content (conservation, balances,
// continuity); this only enforces their interleaving. Exercised by
// test/conformance/concurrency.adversarial.test.ts.
// See https://economy-lab-docs.pages.dev/economy/concepts/integrity/ for the locking/isolation split.
async function lockAccounts(step: Step): Promise<void> {
  const { unit, operation, options } = step;
  const shards = step.pipeline.ctx.config.platformShards;
  await lockAll(unit.ledger, accountsOf(operation, shards), options);
}

// After a successful posting, queues the matching notification event, such as "credits topped up".
// The event is written into the outbox in the same transaction as the posting, so it ships only if
// the posting committed. A rollback leaves no stray event, and a commit always has its event queued.
// See https://economy-lab-docs.pages.dev/economy/ports/messaging/ for how the legs and
// the event commit in one transaction, so they all land or none do.
async function emitEvents(
  step: Step,
  outcome: Extract<Outcome, { status: 'committed' }>,
): Promise<void> {
  const { unit, operation, options } = step;
  const ctx = step.pipeline.ctx;
  const descriptor = EVENTS[operation.kind];
  if (!descriptor) {
    return;
  }
  const event: EconomyEvent = {
    id: ctx.ids.next('evt'),
    type: descriptor.type,
    version: 1,
    occurredAt: outcome.transaction.postedAt,
    subject: descriptor.subject(operation, outcome),
    // Each event kind builds its own payload from the operation and committed result, so a consumer
    // learns what happened without re-fetching the transaction. A client-bound event carries only an
    // allow-listed, PII-free summary. The default is deny: a builder must opt each field in.
    data: descriptor.data(operation, outcome),
    audience: descriptor.audience,
  };
  await unit.outbox.enqueue(
    {
      id: ctx.ids.next('obx'),
      event,
      status: 'pending',
      attempts: 0,
      reason: null,
    },
    options,
  );
}

// --- Funds plan (shared by screenFunds and the spend handler) ----------------------

type SpendPlan = { promoPart: Amount; spendablePart: Amount };

// Plans how a purchase is paid for: promo balance first, then spendable. The promo part is min(price,
// available promo), and the spendable part is the rest. Deliberate private copy of the rule in
// operations/spend.ts planSpend — keep the two in sync so the up-front check and the posting agree.
function planSpend(price: Amount, promoBalance: Amount): SpendPlan {
  const available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  const promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount(price.currency, promoMinor),
    spendablePart: toAmount(price.currency, price.minor - promoMinor),
  };
}

// --- Integrity check ---------------------------------------------------------------

/**
 * Walks every account once and reports whether the ledger still holds its core guarantees. See the
 * {@link ProveReport} fields for what each flag means.
 *
 * This is the lighter in-process prover: its `chainIntact` is only a shape check on each account's
 * latest hash, while the full replay that re-verifies every posting lives in integrity.ts.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ The proof} for why this
 * is an independent audit rather than the primary guard, how `backed` converts custodial credits to
 * USD, and how the two provers differ.
 */
async function proveEconomy(
  store: Store,
  ctx: Ctx,
  options?: Options,
): Promise<ProveReport> {
  const fold = await foldLedger(store, options);
  const required = backingRequired(
    fold.custodialCreditMinor,
    ctx.rates.par('CREDIT'),
  );
  const shortfallMinor =
    fold.trustCashMinor < required ? required - fold.trustCashMinor : 0n;

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
  custodialCreditMinor: bigint;
  trustCashMinor: bigint;
  anyUserNegative: boolean;
  chainIntact: boolean;
  drift: LedgerDrift[];
};

// The lighter twin of integrity.ts foldLedger and accumulateLegs, the thorough prover. Keep the two
// in sync. Visits every account ever posted to (the ledger's hash-chain heads) and gathers the
// integrity figures in one pass. For each account it recomputes the balance from the recorded entries
// (the source of truth, not the cached running balance) and adds it into a per-currency sum signed by
// the side it grows on: positive debit-normal, negative credit-normal. A healthy ledger sums to zero
// per currency; a non-zero total means money was created or destroyed. A cached balance that
// disagrees with the recomputed total is reported as drift instead of folded in.
// See https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ for what each figure proves.
async function foldLedger(
  store: Store,
  options?: Options,
): Promise<LedgerFold> {
  const signedByCurrency = new Map<Currency, bigint>();
  let custodialCreditMinor = 0n;
  let trustCashMinor = 0n;
  let anyUserNegative = false;
  let chainIntact = true;
  const drift: LedgerDrift[] = [];

  for await (const [account, head] of store.ledger.heads()) {
    const bal = await store.ledger.balance(account, options);
    const cur = currency(account);
    // Recompute from the recorded entries, the source of truth, not the cached running balance. The
    // two are compared just below to flag an account whose cached balance has drifted from its
    // entries.
    const derivedMinor = await deriveBalanceMinor(store, account, options);
    const sign = isDebitNormal(account) ? 1n : -1n;
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
      custodialCreditMinor += bal.minor;
    }
    // Trust cash is one logical account split across shard rows, so the backing check compares
    // `required` against the sum over every TRUST_CASH shard this pass visits, not one bare row.
    if (baseOf(account) === SYSTEM.TRUST_CASH) {
      trustCashMinor += bal.minor;
    }
    if (isWalletAccount(account) && isNegative(bal)) {
      anyUserNegative = true;
    }
    if (!isWellFormedHead(head)) {
      chainIntact = false;
    }
  }
  // This lighter prover only visits accounts that have been posted to, which is what heads() returns,
  // so a stored balance row with no backing posting would slip past it. The thorough prover closes
  // that gap via ledger.balanceAccounts() (integrity.ts foldLedger, R33). read.prove() intentionally
  // trades that guarantee for speed, so it is not ported here unless this prover ever needs it.
  return {
    signedByCurrency,
    custodialCreditMinor,
    trustCashMinor,
    anyUserNegative,
    chainIntact,
    drift,
  };
}

// Mirrors integrity.ts's per-account leg sum, where the thorough prover's accumulateLegs is the
// fuller twin. Recomputes an account's balance in minor units by summing every statement entry, each
// already signed the way it changed this account. This reproduces what `ledger.balance` should
// return, and comparing the two detects a stale cached balance.
async function deriveBalanceMinor(
  store: Store,
  account: AccountRef,
  options?: Options,
): Promise<bigint> {
  let derivedMinor = 0n;
  const page = await store.ledger.statement(account, FULL_RANGE, options);
  for (const entry of page.entries) {
    derivedMinor += entry.amount.minor;
  }
  return derivedMinor;
}

// A range wide enough to cover every entry ever recorded, so a statement over it returns the
// account's whole history. The lower bound is inclusive and the upper bound is exclusive, matching
// how the ledger reads a range elsewhere.
const FULL_RANGE = {
  from: Number.MIN_SAFE_INTEGER,
  to: Number.MAX_SAFE_INTEGER,
};

// Converts a credit total into the USD that must back it, in cents, at the fixed CREDIT-to-USD rate.
// The rate is a pair of exact integers, with a true value of `rate` / 10^`scale`, so this multiplies
// by `rate` and divides by that power of ten. Bigint division drops the remainder and rounds down, so
// the platform never reports needing less cash than it actually does.
function backingRequired(custodialCreditMinor: bigint, par: Rate): bigint {
  return (custodialCreditMinor * par.rate) / 10n ** BigInt(par.scale);
}

// --- Small helpers ----------------------------------------------------------------

// Finds the handler for this operation's kind. A missing entry throws a malformed-operation fault.
function resolveHandler(registry: Registry, operation: Operation): Handler {
  const handler = registry[operation.kind];
  if (!handler) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `No handler is registered for operation ${operation.kind}.`,
      { detail: { kind: operation.kind } },
    );
  }
  return handler;
}

function ownedBy(account: AccountRef, userId: string): boolean {
  return account.startsWith(`${userId}:`);
}

// Reports whether an account's latest entry hash has the expected shape: 64 lowercase hex chars, a
// hex SHA-256. This is the cheap shape check `chainIntact` uses. It does not verify the hash matches
// the entry it covers.
function isWellFormedHead(head: string): boolean {
  return /^[0-9a-f]{64}$/.test(head);
}

function unauthorized(operation: Operation, message: string) {
  return fault(ERROR_CODES.UNAUTHORIZED, message, {
    detail: { kind: operation.kind, actor: operation.actor.kind },
  });
}

// Operations an end user may never run. Several reclaim or mint money in accounts the ownership check
// below cannot catch (clawback, revokeEntitlement), so they are gated on a system or operator
// principal here instead.
// See https://economy-lab-docs.pages.dev/economy/concepts/actors-and-authorization/ for the per-kind
// reason each operation is barred to a user.
const RESTRICTED_TO_PRIVILEGED = new Set<Operation['kind']>([
  'grantPromo',
  'grantEntitlement',
  'revokeEntitlement',
  'topUp',
  'adjust',
  'reverse',
  'refund',
  'clawback',
  'reversePayout',
  'settlePayout',
]);

// --- Event descriptors --------------------------------------------------------------

// The committed outcome an event builder is handed. Events emit only after the posting committed, so
// the transaction is always present.
type Committed = Extract<Outcome, { status: 'committed' }>;

// For each operation kind that announces itself, the event to emit on commit: name, audience
// (`client` for an end user, `internal` for back-office), subject builder, and payload builder. A
// client event carries only an allow-listed, PII-free summary (opt-in per field); internal events may
// carry richer detail. Both builders get the committed result, so a payload can derive from the
// entries that actually posted (refund needs this, since its operation names only an orderId).
const EVENTS: Partial<
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
  // A refund's operation carries only the orderId, so recover the buyer from the posting. The
  // reversing entry credits the buyer's own spendable or promo account, the only user-owned,
  // non-earned entry in it. This is sent to the client, since the buyer is told their sale was
  // reversed.
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
  // An operator or fraud-system action that reclaims credits after a chargeback. It is internal-only,
  // not for the customer, so the payload may carry richer detail (the reclaimed amount and the
  // disputed order) alongside the transaction id.
  clawback: {
    type: 'economy.credits.clawed_back',
    audience: 'internal',
    subject: (operation) => opOf<'clawback'>(operation).userId,
    data: (operation, outcome) => {
      const op = opOf<'clawback'>(operation);
      const data: Record<string, unknown> = {
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
  // A payout request. The seller is told their cash-out was accepted. The requested amount is safe to
  // send to the client, since it is the seller's own earned credits.
  requestPayout: {
    type: 'economy.payout.requested',
    audience: 'client',
    subject: (operation) => opOf<'requestPayout'>(operation).userId,
    data: (operation, outcome) => {
      const op = opOf<'requestPayout'>(operation);
      return {
        txnId: outcome.transaction.id,
        userId: op.userId,
        amount: encodeAmount(op.amount),
      };
    },
  },
  // The start of a subscription, emitted when subscribe commits. Later lifecycle events (renewed,
  // lapsed) come from the billing worker, while this one fires once, up front. Period 1 is the first
  // billed period.
  subscribe: {
    type: 'economy.subscription.started',
    audience: 'client',
    subject: (operation) => opOf<'subscribe'>(operation).userId,
    data: (operation, outcome) => {
      const op = opOf<'subscribe'>(operation);
      return {
        txnId: outcome.transaction.id,
        userId: op.userId,
        sku: op.sku,
        period: 1,
      };
    },
  },
  // A cancellation. It commits without moving money, since cancel only flips the subscription's state
  // and posts no entries, but `emitEvents` fires for any committed outcome, so the event still emits.
  // The subscriptionId is the only identifier the operation carries; there is no userId, sku, or
  // period.
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
  // A payout reversal an operator runs by hand. It is internal-only, not for the customer, since it
  // is an emergency manual action. It uses the same event shape as the reversal the billing worker
  // emits automatically, so a consumer sees one consistent event whether a payout was force-failed by
  // the worker or pulled back by an operator. The seller is the subject.
  reversePayout: {
    type: 'economy.payout.reversed',
    audience: 'internal',
    subject: (operation) => opOf<'reversePayout'>(operation).userId,
    data: (operation) => {
      const op = opOf<'reversePayout'>(operation);
      return { sagaId: op.sagaId, reason: op.reason };
    },
  },
};

function txnData(
  _operation: Operation,
  outcome: Committed,
): Record<string, unknown> {
  return { txnId: outcome.transaction.id };
}

// Builds a sale's event payload: the txn id, plus the gift flag and recipient when the buyer bought
// for someone else. The gift fields are added only for a real gift, where the recipient differs from
// the buyer, so a self-purchase keeps the minimal payload.
function spendData(
  operation: Operation,
  outcome: Committed,
): Record<string, unknown> {
  const base = txnData(operation, outcome);
  if (
    operation.kind === 'spend' &&
    operation.giftTo !== undefined &&
    operation.giftTo !== operation.buyerId
  ) {
    return { ...base, isGift: true, giftTo: operation.giftTo };
  }
  return base;
}

// Narrows the operation union to one kind. The submit pipeline only ever calls a descriptor whose
// key equals `operation.kind`, so the cast is safe, and it lets the field reads below typecheck
// without re-discriminating on `kind`. The kind is passed explicitly (e.g. `opOf<'refund'>(operation)`)
// because it cannot be inferred from the argument.
function opOf<K extends Operation['kind']>(
  operation: Operation,
): Extract<Operation, { kind: K }> {
  return operation as Extract<Operation, { kind: K }>;
}

// Recovers the refunded buyer from the entries of the reversing transaction. A spend takes money out
// of the buyer's own spendable and promo accounts, so reversing it credits those same accounts, while
// a seller only ever receives credits into their `:earned` account. So the buyer is the user behind
// the single spendable-or-promo wallet entry. Read the userId off that entry's account id, the part
// before the `:kind` suffix, rather than the operation, which carries no buyerId.
function refundBuyer(outcome: Committed): string {
  for (const leg of outcome.transaction.legs) {
    if (!isWalletAccount(leg.account)) {
      continue;
    }
    const colon = leg.account.lastIndexOf(':');
    const kind = leg.account.slice(colon + 1);
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
