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
  convertFloor,
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

// Builds the runtime context a handler may read: every capability except the store (handlers get a
// per-transaction view) and the scheduler and dispatcher (this factory keeps them). `cache` is
// undefined when none was injected.
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
    payees: capabilities.payees,
  };
}

// Derives the pause state from the maintenance window and the clock, never stored, so this read and
// the ECONOMY_PAUSED gate in `submit` agree. `resumesAt` is the window's end while paused, otherwise
// null.
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

// Runs a cache operation, logging and falling back on any error; the cache is best-effort, so a
// failure can never fail the read.
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

// Authorize first, so a forbidden request is rejected before any work; then do the money work in one
// all-or-nothing transaction. The risk-velocity attempt records inside that transaction and is
// re-recorded below if it rolls back (see `screenRisk` for the TOCTOU reasoning).
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

  // A rejected outcome must roll back, not commit, so the idempotency key stays unused for a retry;
  // committing would persist MySQL's claim placeholder while Postgres inserts nothing, and the
  // engines would diverge. Throw the RejectedRollback sentinel to roll back like a fault, then
  // recover the outcome outside the transaction.
  //
  // Re-record the velocity attempt the rollback erased (`bump` dedupes on the attempt's key). On a
  // rejection a failed re-record propagates — silently losing it would let a caller probe the limit
  // for free; on a genuine fault the original error wins.
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

// Rejects a malformed operation before any work, checked once here rather than per handler: a
// non-empty idempotency key, no blank wallet owner, and an in-range amount. The shard count is
// passed so every accountsOf caller agrees.
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

// Returns the money amount an operation moves, or null for kinds that reference an existing record
// instead.
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

// Rejects a non-positive or over-ceiling amount. A manual `adjust` may debit or credit, so it only
// has to be non-zero.
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

// Drops the cached balance of every account a committed transaction touched; a no-op with no cache
// or a non-commit outcome. The set matches what `lockAccounts` locked, de-duplicated.
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

// Claim the idempotency key, run the checks and the posting, record the outcome under the key on
// commit; a repeat replays the recorded result, a rejection or fault rolls back and leaves the key
// unused.
// See https://economy-lab-docs.pages.dev/economy/concepts/idempotency/ for the claim/record model.
async function runOnion(step: Step): Promise<Outcome> {
  const { unit, operation, options } = step;
  const claim = await unit.idempotency.claim(operation.idempotencyKey, options);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  // Risk runs before funds so a burst of unaffordable spends still counts toward the limit, and a
  // velocity-exceeded request is denied whether or not it could pay.
  const risk = await screenRisk(step);
  if (risk) {
    return risk;
  }

  // Screen funds after the lock so the read is current; balances are cached in `unit.balances` so the
  // screen and handler share one read.
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

// Decides whether the caller may run this operation, before the operation is claimed.
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

// The user accounts this operation debits — the only ones the ownership check cares about, since
// only a drained account has to belong to the caller.
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

// Checks up front that every account can cover what the operation takes, returning a `rejected`
// outcome instead of throwing. The database's no-overdraft CHECK is the enforcer; this exists so an
// overspend returns a clean rejection rather than a constraint violation.
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

// How much each user account must hold for the operation to pass. Only `spend` can run a user short:
// promo draws first and only to zero, so spendable is the one account to check.
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

// Reads a balance once per operation via `unit.balances`; a unit built outside the pipeline reads
// through to the ledger.
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

// Records this attempt and reads back the windowed total in one atomic per-subject step, then denies
// if the total is over the limit. Recording at check time, not after commit, closes the
// velocity-limit TOCTOU: two concurrent same-subject submits cannot both read a stale total and
// pass. The attempt is staged with `submit`, which re-records it if the transaction rolls back.
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

// Locks every account the operation touches, in the deadlock-free global order `lockAll` shares. The
// write runs at default isolation, so this fixed-order locking — not the engine — is what serializes
// contending operations.
// See https://economy-lab-docs.pages.dev/economy/concepts/integrity/ for the locking/isolation split.
async function lockAccounts(step: Step): Promise<void> {
  const { unit, operation, options } = step;
  const shards = step.pipeline.ctx.config.platformShards;
  await lockAll(unit.ledger, accountsOf(operation, shards), options);
}

// Queues the matching notification event in the outbox in the posting's own transaction, so the
// event ships only if the posting committed.
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
    // Each event kind builds its own payload. A client-bound event carries only an allow-listed,
    // PII-free summary; the default is deny, and a builder must opt each field in.
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

// The lighter twin of integrity.ts foldLedger — keep the two in sync. One pass over the hash-chain
// heads recomputes each balance from the recorded entries and folds it into a per-currency sum; a
// cached balance that disagrees is reported as drift instead of folded in.
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

// Recomputes an account's balance by summing every statement entry, each already signed the way it
// changed this account; comparing against `ledger.balance` detects a stale cache.
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

// A range wide enough to cover every entry ever recorded; the lower bound is inclusive, the upper
// exclusive.
const FULL_RANGE = {
  from: Number.MIN_SAFE_INTEGER,
  to: Number.MAX_SAFE_INTEGER,
};

// Converts a credit total into the USD that must back it at the fixed CREDIT-to-USD par rate,
// rounding down via `convertFloor`.
function backingRequired(custodialCreditMinor: bigint, par: Rate): bigint {
  return convertFloor(toAmount('CREDIT', custodialCreditMinor), par, 'USD')
    .minor;
}

// --- Small helpers ----------------------------------------------------------------

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

// A shape check only — 64 lowercase hex chars; it does not verify the hash matches the entry it
// covers.
function isWellFormedHead(head: string): boolean {
  return /^[0-9a-f]{64}$/.test(head);
}

function unauthorized(operation: Operation, message: string) {
  return fault(ERROR_CODES.UNAUTHORIZED, message, {
    detail: { kind: operation.kind, actor: operation.actor.kind },
  });
}

// Operations gated to a system or operator principal; several reclaim or mint money in accounts the
// ownership check below cannot catch.
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

// For each announcing kind: the event name, audience, subject builder, and payload builder. Client
// events carry an allow-listed, PII-free summary; internal events may carry richer detail; both
// builders get the committed result.
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
  // A refund's operation carries only the orderId, so the buyer is recovered from the reversing
  // entry — the single user-owned spendable-or-promo entry in it.
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
  // Internal-only, so the payload may carry the reclaimed amount and the disputed order alongside the
  // transaction id.
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
  // The requested amount is safe to send to the client: it is the seller's own earned credits.
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
  // Fires once at subscribe; later lifecycle events (renewed, lapsed) come from the billing worker.
  // Period 1 is the first billed period.
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
  // A cancellation commits without moving money, and `emitEvents` fires for any committed outcome.
  // The subscriptionId is the only identifier the operation carries.
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
  // An operator's manual reversal, internal-only. It shares the event shape of the worker's automatic
  // reversal, so a consumer sees one consistent event either way.
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

// The gift fields are added only when the recipient differs from the buyer, so a self-purchase keeps
// the minimal payload.
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

// Narrows the operation union to one kind; the pipeline only calls a descriptor whose key equals
// `operation.kind`, so the cast is safe.
function opOf<K extends Operation['kind']>(
  operation: Operation,
): Extract<Operation, { kind: K }> {
  return operation as Extract<Operation, { kind: K }>;
}

// The buyer is the user behind the single spendable-or-promo wallet entry in the reversing
// transaction; read the userId off that entry's account id, since the operation carries no buyerId.
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
