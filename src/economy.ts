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
  rateGte,
  toAmount,
} from '#src/money.ts';
import {
  currency,
  earned,
  isDebitNormal,
  isShardedBase,
  isWalletAccount,
  ownerOf,
  promo,
  shardsOf,
  spendable,
  walletKindOf,
  accountsOf,
} from '#src/accounts.ts';
import {
  backingRequiredMinor,
  backingShortfallMinor,
  foldBackingAccount,
} from '#src/integrity.ts';
import { pendingOutbox } from '#src/outbox.ts';
import { PRE_CLAIMS, REGISTRY } from '#src/operations/registry.ts';
import { planSpend } from '#src/operations/spend.ts';
import {
  attemptMinor,
  classLimitMinor,
  riskSubject,
  VELOCITY_CURRENCY,
} from '#src/trust.ts';
import { economyPaused } from '#src/config.ts';
import { encodeWire } from '#src/adapters/http-wire.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Config } from '#src/config.ts';
import type { BackingTotals } from '#src/integrity.ts';
import type { Amount, Currency } from '#src/money.ts';
import type {
  BatchOutcome,
  Ctx,
  Economy,
  EconomyStatus,
  Handler,
  Operation,
  Outcome,
  ProveReport,
} from '#src/contract.ts';
import type {
  Attempt,
  Ports,
  EconomyEvent,
  Ledger,
  CallOptions,
  Rates,
  Store,
  Unit,
} from '#src/ports.ts';

export type { Economy } from '#src/contract.ts';

type Registry = Partial<Record<Operation['kind'], Handler>>;

/**
 * The one door to an {@link Economy}: sync, over a finished {@link Ports} bag — `openPorts`,
 * `memoryPorts`, or a hand-built structural object.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for the
 * construction, the submit/read surface, and the request path.
 */
export function createEconomy(ports: Ports): Economy {
  const store = ports.store;
  // A runtime config mutation would half-apply: most knobs are read per submit, but
  // velocityWindowMs is captured at store construction. Frozen, a mutation throws instead;
  // change a knob by rebuilding over the same store.
  Object.freeze(ports.config);
  Object.freeze(ports.config.maturityHorizonMs);
  Object.freeze(ports.config.payoutSla);
  assertBuyCoversPar(ports.rates);
  const ctx = contextOf(ports);
  const registry = REGISTRY;

  return {
    submit: (operation, options) =>
      meteredSubmit({ store, registry, ctx }, operation, options),
    submitBatch: (operations, options) =>
      submitBatch({ store, registry, ctx }, operations, options),
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
      lineage: (account, options) => store.ledger.lineage(account, options),
      export: (options) => exportLedger(store, options),
      checkpoint: (options) => store.checkpoints.latest(options),
      health: (options) => healthReport(store, ctx, options),
    },
    close: () => store.close(),
  };
}

// Refuses a misordered rate source at construction, the same way a bad signing key fails at
// startup rather than deep inside a request. Only `buy >= par` is checkable here: both are
// synchronous constants, while `payout` is asked per settlement time and guarded at
// requestPayout. A source whose answers change after construction is caught again by topUp's
// own guard.
function assertBuyCoversPar(rates: Rates): void {
  const buy = rates.buy('CREDIT');
  const par = rates.par('CREDIT');
  if (!rateGte(buy, par)) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'Rates are misordered: buy is below par, so every top-up would book a loss.',
      {
        retryable: false,
        detail: { buyRateId: buy.rateId, parRateId: par.rateId },
      },
    );
  }
}

type Pipeline = { store: Store; registry: Registry; ctx: Ctx };

type Step = {
  pipeline: Pipeline;
  unit: Unit;
  operation: Operation;
  options?: CallOptions;
  // Called by screenRisk with the velocity attempt it is about to record inside the transaction,
  // so `submit` can re-record the attempt if that transaction rolls back.
  staged?: (subject: string, attempt: Attempt) => void;
};

// Every port except the store (handlers get a per-transaction view), the scheduler and
// dispatcher (worker concerns), and the secrets bag, which the submit path never reads.
function contextOf(ports: Ports): Ctx {
  return {
    clock: ports.clock,
    ids: ports.ids,
    digest: ports.digest,
    signer: ports.signer,
    processor: ports.processor,
    config: ports.config,
    pricing: ports.pricing,
    rates: ports.rates,
    logger: ports.logger,
    meter: ports.meter,
    cache: ports.cache,
    payees: ports.payees,
  };
}

// The pause state is derived from the window and the clock, never stored, so this read and the
// ECONOMY_PAUSED gate in `submit` agree.
function economyStatus(ctx: Ctx): EconomyStatus {
  const { pauseStartMs, pauseEndMs } = ctx.config;
  const active = economyPaused(ctx.clock.now(), ctx.config);
  return {
    maintenanceActive: active,
    pauseStart: pauseStartMs,
    pauseEnd: pauseEndMs,
    resumesAt: active ? pauseEndMs : null,
  };
}

// --- Read-through balance cache ----------------------------------------------------

// The `bal:` prefix avoids collisions in a shared cache.
function cacheKey(account: AccountRef): string {
  return `bal:${account}`;
}

// The cache is best-effort: any error logs and falls back, so a cache failure can never fail a read.
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

// The value is cached as its `encodeAmount` string, so the exact bigint minor-unit value survives a
// string-only cache. Only the public `read.balance` routes through here; reads inside a write
// transaction stay direct, so a transaction never sees a stale cached value.
// A bare sharded platform account reads as its logical balance: the sum over its shard rows,
// each row cached (and invalidated) under its own key.
async function cachedBalance(
  ctx: Ctx,
  ledger: Ledger,
  account: AccountRef,
  options?: CallOptions,
): Promise<Amount> {
  const shards = ctx.config.platformShards;
  if (shards > 1 && isShardedBase(account)) {
    let minor = 0n;
    for (const shard of shardsOf(account, shards)) {
      minor += (await cachedRow(ctx, ledger, shard, options)).minor;
    }
    return toAmount(currency(account), minor);
  }
  return cachedRow(ctx, ledger, account, options);
}

async function cachedRow(
  ctx: Ctx,
  ledger: Ledger,
  account: AccountRef,
  options?: CallOptions,
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
// Counts every submit by kind and how it resolved, and observes its wall time, so an operator
// has request-path telemetry without wrapping submit themselves. Metering runs after the
// outcome (or fault) is already decided and is guarded: a throwing meter must not turn a
// committed operation into an error the caller retries.
async function meteredSubmit(
  pipeline: Pipeline,
  operation: Operation,
  options?: CallOptions,
): Promise<Outcome> {
  const { meter, clock } = pipeline.ctx;
  const kind = String((operation as { kind?: unknown })?.kind ?? 'unknown');
  const startedAt = clock.now();
  let status = 'fault';
  let reason: string | undefined;
  try {
    const outcome = await submit(pipeline, operation, options);
    status = outcome.status;
    if (outcome.status === 'rejected') reason = outcome.detail.reason;
    return outcome;
  } finally {
    try {
      // A rejection carries its reason code (a bounded enum), so a supervisor can tell a
      // velocity storm from an underfunded buyer without seeing any outcome.
      meter.count('economy.submit', 1, {
        kind,
        status,
        ...(reason === undefined ? {} : { reason }),
      });
      meter.observe('economy.submit.ms', clock.now() - startedAt, { kind });
    } catch {
      // Telemetry only; the outcome above is already decided.
    }
  }
}

// One operation's place in a batch while it runs: its input position, plus the velocity attempt
// its risk screen staged (re-recorded if the operation's savepoint rolls back, exactly as
// `submit` re-records after a transaction rollback).
type BatchEntry = {
  index: number;
  operation: Operation;
  staged: { subject: string; attempt: Attempt } | null;
};

// Economy.submitBatch. The pre-transaction phase (validation, authorization, the pause gate, and
// the distinct-key guard) decides what enters the shared transaction; each entrant then runs the
// same claimed pipeline as `submit` under its own savepoint. Without store batch support the
// batch degrades to sequential submits with faults captured per slot.
async function submitBatch(
  pipeline: Pipeline,
  operations: ReadonlyArray<Operation>,
  options?: CallOptions,
): Promise<ReadonlyArray<BatchOutcome>> {
  if (pipeline.store.batchTransaction === undefined) {
    return sequentialBatch(pipeline, operations, options);
  }
  const slots: Array<BatchOutcome | null> = operations.map(() => null);
  const entries = screenBatch(pipeline, operations, slots);
  if (entries.length === 0) {
    // Everything was decided pre-transaction; don't pay for an empty BEGIN/COMMIT.
    await finishBatch(pipeline, operations, slots);
    return slots as BatchOutcome[];
  }

  const results = await pipeline.store
    .batchTransaction(
      entries.map(
        (entry) => (unit: Unit) =>
          rejectionsRollBack({
            pipeline,
            unit,
            operation: entry.operation,
            options,
            staged: (subject, attempt) => {
              entry.staged = { subject, attempt };
            },
          }),
      ),
      options,
    )
    .catch(async (error: unknown) => {
      // The shared transaction itself failed, erasing every entrant's in-transaction velocity
      // attempt; re-record them best-effort (`bump` dedupes on the attempt key), as submit does
      // when its transaction dies, then let the batch's error reach the caller.
      for (const entry of entries) {
        if (entry.staged) {
          await pipeline.store.trust
            .bump(entry.staged.subject, entry.staged.attempt, options)
            .catch(() => {});
        }
      }
      throw error;
    });

  for (let i = 0; i < entries.length; i += 1) {
    slots[entries[i]!.index] = await settleBatchSlot(
      pipeline,
      entries[i]!,
      results[i]!,
      options,
    );
  }
  await finishBatch(pipeline, operations, slots);
  return slots as BatchOutcome[];
}

async function sequentialBatch(
  pipeline: Pipeline,
  operations: ReadonlyArray<Operation>,
  options?: CallOptions,
): Promise<ReadonlyArray<BatchOutcome>> {
  const slots: BatchOutcome[] = [];
  for (const operation of operations) {
    try {
      slots.push({
        ok: true,
        outcome: await meteredSubmit(pipeline, operation, options),
      });
    } catch (error) {
      slots.push({ ok: false, error });
    }
  }
  // meteredSubmit already counted each operation; the batch counter still fires so batch rate
  // stays visible on stores without batch support.
  try {
    pipeline.ctx.meter.count('economy.submit.batch', 1, {
      size: String(operations.length),
    });
  } catch {
    // Telemetry only.
  }
  return slots;
}

// The pre-transaction screens, per operation: a failure fills the slot and keeps the operation
// out of the shared transaction. Duplicate idempotency keys are refused up front — inside one
// transaction the second claim would see the first's uncommitted placeholder as its own and run
// the operation twice, the very double-run the key exists to prevent.
function screenBatch(
  pipeline: Pipeline,
  operations: ReadonlyArray<Operation>,
  slots: Array<BatchOutcome | null>,
): BatchEntry[] {
  const ctx = pipeline.ctx;
  const entries: BatchEntry[] = [];
  const seen = new Set<string>();
  operations.forEach((operation, index) => {
    try {
      validateOperation(operation, ctx.config);
      authorize(operation);
      if (seen.has(operation.idempotencyKey)) {
        throw fault(
          ERROR_CODES.MALFORMED_OPERATION,
          'A submitBatch may not carry the same idempotencyKey twice.',
          { detail: { kind: operation.kind } },
        );
      }
      seen.add(operation.idempotencyKey);
      if (
        operation.actor.kind === 'user' &&
        economyPaused(ctx.clock.now(), ctx.config)
      ) {
        slots[index] = {
          ok: true,
          outcome: rejected('ECONOMY_PAUSED', {
            resumesAt: ctx.config.pauseEndMs,
          }),
        };
        return;
      }
      entries.push({ index, operation, staged: null });
    } catch (error) {
      slots[index] = { ok: false, error };
    }
  });
  return entries;
}

// One savepoint result to one slot, with `submit`'s post-rollback bookkeeping: a rejected
// operation's velocity attempt is re-recorded (its savepoint erased it), and a failed re-record
// turns the slot into a fault rather than silently letting the caller probe the limit for free.
async function settleBatchSlot(
  pipeline: Pipeline,
  entry: BatchEntry,
  result: { ok: true; value: Outcome } | { ok: false; error: unknown },
  options?: CallOptions,
): Promise<BatchOutcome> {
  if (result.ok) {
    return { ok: true, outcome: result.value };
  }
  if (result.error instanceof RejectedRollback) {
    if (entry.staged) {
      try {
        await pipeline.store.trust.bump(
          entry.staged.subject,
          entry.staged.attempt,
          options,
        );
      } catch (error) {
        return { ok: false, error };
      }
    }
    return { ok: true, outcome: result.error.outcome };
  }
  if (entry.staged) {
    await pipeline.store.trust
      .bump(entry.staged.subject, entry.staged.attempt, options)
      .catch(() => {});
  }
  return { ok: false, error: result.error };
}

// The per-operation aftercare `submit` does outside its transaction: cache invalidation for
// committed slots and the submit counter, plus one batch counter. Metering is guarded like
// meteredSubmit's: a throwing meter must not fail outcomes already decided.
async function finishBatch(
  pipeline: Pipeline,
  operations: ReadonlyArray<Operation>,
  slots: ReadonlyArray<BatchOutcome | null>,
): Promise<void> {
  for (let i = 0; i < operations.length; i += 1) {
    const slot = slots[i];
    if (slot?.ok === true) {
      await invalidateCache(pipeline, operations[i]!, slot.outcome);
    }
    try {
      const status =
        slot === null || slot === undefined
          ? 'fault'
          : slot.ok
            ? slot.outcome.status
            : 'fault';
      const reason =
        slot?.ok === true && slot.outcome.status === 'rejected'
          ? slot.outcome.detail.reason
          : undefined;
      pipeline.ctx.meter.count('economy.submit', 1, {
        kind: String((operations[i] as { kind?: unknown })?.kind ?? 'unknown'),
        status,
        ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      // Telemetry only.
    }
  }
  try {
    pipeline.ctx.meter.count('economy.submit.batch', 1, {
      size: String(operations.length),
    });
  } catch {
    // Telemetry only.
  }
}

async function submit(
  pipeline: Pipeline,
  operation: Operation,
  options?: CallOptions,
): Promise<Outcome> {
  validateOperation(operation, pipeline.ctx.config);
  authorize(operation);

  // Maintenance window. Refuse only an end user's discretionary write, never a 'system' settlement
  // webhook or operator fix. The gate sits before the transaction opens, so a paused user op records
  // no velocity attempt and touches no ledger.
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
        rejectionsRollBack({
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

// Thrown to roll back a transaction whose outcome is `rejected` while still surfacing that outcome;
// a rejection is not an error to the caller.
class RejectedRollback extends Error {
  outcome: Outcome;
  constructor(outcome: Outcome) {
    super('rejected outcome rolled back');
    this.outcome = outcome;
  }
}

async function rejectionsRollBack(step: Step): Promise<Outcome> {
  const outcome = await runClaimed(step);
  if (outcome.status === 'rejected') {
    throw new RejectedRollback(outcome);
  }
  return outcome;
}

// High enough for any legitimate operation; blocks overflow-scale values from a typo or a hostile
// caller.
const MAX_OP_AMOUNT_MINOR = 1_000_000_000_000_000n;

// Checked once here rather than per handler. The shard and accrual knobs are passed so every
// accountsOf caller agrees.
function validateOperation(
  operation: Operation,
  config: Pick<Config, 'platformShards' | 'accrualDrain'>,
): void {
  if (!(operation.kind in REGISTRY)) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `Unknown operation kind "${operation.kind}".`,
      { detail: { kind: operation.kind } },
    );
  }

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

  for (const account of accountsOf(
    operation,
    config.platformShards,
    config.accrualDrain,
  )) {
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

// A manual `adjust` may debit or credit, so it only has to be non-zero.
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

// On commit, drops the cached balance of the same account set `lockAccounts` locked.
async function invalidateCache(
  pipeline: Pipeline,
  operation: Operation,
  outcome: Outcome,
): Promise<void> {
  const cache = pipeline.ctx.cache;
  if (!cache || outcome.status !== 'committed') {
    return;
  }
  const { platformShards, accrualDrain } = pipeline.ctx.config;
  for (const account of new Set(
    accountsOf(operation, platformShards, accrualDrain),
  )) {
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
async function runClaimed(step: Step): Promise<Outcome> {
  const { unit, operation, options } = step;
  const claim = await unit.idempotency.claim(operation.idempotencyKey, options);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  // A domain-level duplicate (a replayed orderId) is final before any lock, so it exits here —
  // like a key replay, it records no velocity attempt.
  const preClaim = PRE_CLAIMS[operation.kind];
  if (preClaim) {
    const duplicate = await preClaim(operation, unit);
    if (duplicate) {
      return duplicate;
    }
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

// See https://economy-lab-docs.pages.dev/economy/concepts/actors-and-authorization/ for the actor
// kinds, the user-may-only-debit-own-accounts rule, and the privileged-only set.
function authorize(operation: Operation): void {
  const actor = operation.actor;
  if (actor.kind === 'operator') {
    return;
  }
  if (actor.kind === 'system') {
    // The lab models one trust domain; a deployment running several services scopes them here, at
    // the one authorization seam.
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

// The database's no-overdraft CHECK is the enforcer; this up-front screen exists so an overspend
// returns a clean rejection rather than a constraint violation.
async function screenFunds(step: Step): Promise<Outcome | null> {
  const { unit, operation, options } = step;
  for (const need of await fundsNeeded(unit, operation, options)) {
    const have = await readCachedBalance(unit, need.account, options);
    if (compare(have, need.amount) < 0) {
      return rejected('INSUFFICIENT_FUNDS', {
        account: need.account,
        need: need.amount,
        have,
      });
    }
  }
  return null;
}

// Only `spend` can run a user short: promo draws first and only to zero, so spendable is the one
// account to check. The split comes from `planSpend`, shared with the spend handler, so this check
// and the posting always agree.
async function fundsNeeded(
  unit: Unit,
  operation: Operation,
  options?: CallOptions,
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
  options?: CallOptions,
): Promise<Amount> {
  const cached = unit.balances?.get(account);
  if (cached !== undefined) {
    return cached;
  }
  const balance = await unit.ledger.balance(account, options);
  unit.balances?.set(account, balance);
  return balance;
}

// Recording at check time, not after commit, closes the velocity-limit TOCTOU: two concurrent
// same-subject submits cannot both read a stale total and pass. The attempt is staged with `submit`,
// which re-records it if the transaction rolls back.
async function screenRisk(step: Step): Promise<Outcome | null> {
  const { pipeline, unit, operation, options } = step;
  const risk = riskSubject(operation);
  if (risk === null) {
    return null;
  }
  // The outcome tag is write-only — the limit sums every attempt regardless of tag — so a fixed
  // `committed` tag at check time is faithful. The returned velocity already includes this attempt;
  // re-adding its amount would double-count.
  const attempt: Attempt = {
    idempotencyKey: operation.idempotencyKey,
    amount: toAmount(VELOCITY_CURRENCY, attemptMinor(operation)),
    at: pipeline.ctx.clock.now(),
    outcome: 'committed',
  };
  step.staged?.(risk.subject, attempt);
  const velocity = await unit.trust.record(risk.subject, attempt, options);
  const config = pipeline.ctx.config;
  const limitMinor = classLimitMinor(config, risk.class);
  if (velocity.spent.minor > limitMinor) {
    return rejected('RISK_DENIED', {
      window: risk.class === 'in' ? 'inflow' : 'outflow',
      limitMinor,
    });
  }
  return null;
}

// Locks every account the operation touches, in the deadlock-free global order `lockAll` shares. The
// write runs at default isolation, so this fixed-order locking — not the engine — is what serializes
// contending operations.
// See https://economy-lab-docs.pages.dev/economy/concepts/integrity/ for the locking/isolation split.
async function lockAccounts(step: Step): Promise<void> {
  const { unit, operation, options } = step;
  const { platformShards, accrualDrain } = step.pipeline.ctx.config;
  await lockAll(
    unit.ledger,
    accountsOf(operation, platformShards, accrualDrain),
    options,
  );
}

// The event enqueues in the posting's own transaction, so it ships only if the posting committed.
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
    data: descriptor.data(operation, outcome),
    audience: descriptor.audience,
  };
  await unit.outbox.enqueue(
    pendingOutbox(ctx.ids, event, options?.correlationId),
    options,
  );
}

// --- Integrity check ---------------------------------------------------------------

/**
 * The lighter in-process prover behind `read.health()`: its `chainIntact` is only a shape check
 * on each account's latest hash, while the full replay that re-verifies every posting lives in
 * integrity.ts (`proveEconomy`).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ The proof} for why this
 * is an independent audit rather than the primary guard, how `backed` converts custodial credits to
 * USD, and how the two provers differ.
 */
async function healthReport(
  store: Store,
  ctx: Ctx,
  options?: CallOptions,
): Promise<ProveReport> {
  const fold = await foldLedger(store, options);
  const required = backingRequiredMinor(
    fold.custodialCreditMinor,
    ctx.rates.par('CREDIT'),
  );
  const shortfallMinor = backingShortfallMinor(required, fold.trustCashMinor);

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
  options?: CallOptions,
): Promise<LedgerFold> {
  const signedByCurrency = new Map<Currency, bigint>();
  const backing: BackingTotals = {
    custodialCreditMinor: 0n,
    trustCashMinor: 0n,
  };
  let anyUserNegative = false;
  let chainIntact = true;
  const drift: LedgerDrift[] = [];

  for await (const [account, head] of store.ledger.heads()) {
    const bal = await store.ledger.balance(account, options);
    const cur = currency(account);
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
    // Backing sums read the stored balance; `foldBackingAccount` (integrity.ts) owns what counts.
    foldBackingAccount(backing, account, bal.minor);
    if (isWalletAccount(account) && isNegative(bal)) {
      anyUserNegative = true;
    }
    if (!isWellFormedHead(head)) {
      chainIntact = false;
    }
  }
  // heads() only visits posted-to accounts, so a balance row with no backing posting slips past this
  // prover. The thorough prover closes that gap (integrity.ts foldLedger, R33); read.health() trades
  // it for speed on purpose.
  return { signedByCurrency, ...backing, anyUserNegative, chainIntact, drift };
}

// Statement entries are already signed the way they changed this account, so their plain sum is the
// derived balance.
async function deriveBalanceMinor(
  store: Store,
  account: AccountRef,
  options?: CallOptions,
): Promise<bigint> {
  let derivedMinor = 0n;
  const page = await store.ledger.statement(account, FULL_RANGE, options);
  for (const entry of page.entries) {
    derivedMinor += entry.amount.minor;
  }
  return derivedMinor;
}

// Covers every entry ever recorded; `from` is inclusive, `to` exclusive.
const FULL_RANGE = {
  from: Number.MIN_SAFE_INTEGER,
  to: Number.MAX_SAFE_INTEGER,
};

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

type Committed = Extract<Outcome, { status: 'committed' }>;

// Client events carry only an allow-listed, PII-free summary — the default is deny, each field
// opted in; internal events may carry richer detail.
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
    subject: userSubject,
    data: txnData,
  },
  grantPromo: {
    type: 'economy.promo.granted',
    audience: 'client',
    subject: userSubject,
    data: txnData,
  },
  spend: {
    type: 'economy.sale.completed',
    audience: 'client',
    subject: userSubject,
    data: spendData,
  },
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
    const kind = walletKindOf(leg.account);
    if (kind === 'spendable' || kind === 'promo') {
      return ownerOf(leg.account);
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

// --- Ledger export (the offline-verification file) --------------------------------

/** First-line marker of a ledger export; scripts/ledger-verify.ts refuses files without it. */
export const EXPORT_FORMAT = 'economy-lab/ledger-export';

// Link lines carry the full posting (legs, meta, both hashes), so the file alone re-proves
// every chain and re-derives the Merkle root the checkpoint signed. Field order comes from the
// wire codec and never changes: the file is canonical, byte-for-byte stable for the same data.
async function* exportLedger(
  store: Store,
  options?: CallOptions,
): AsyncIterable<string> {
  yield JSON.stringify({ format: EXPORT_FORMAT, v: 1 });
  const accounts: AccountRef[] = [];
  for await (const [account] of store.ledger.heads()) {
    accounts.push(account);
  }
  for (const account of accounts) {
    for await (const link of store.ledger.lineage(account, options)) {
      yield JSON.stringify({
        type: 'link',
        account,
        link: encodeWire.storedLink(link),
      });
    }
  }
  const checkpoint = await store.checkpoints.latest(options);
  if (checkpoint !== null) {
    yield JSON.stringify({ type: 'checkpoint', checkpoint });
  }
}
