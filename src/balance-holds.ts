/**
 * @pwngh/economy-lab
 * Copyright (c) Preston Neal
 * Licensed under the MIT license in LICENSE.md.
 */

import { balanceHoldAccount, balanceHoldParts, earned } from '#src/accounts.ts';
import { verifiedPosting } from '#src/chain.ts';
import { toHex } from '#src/bytes.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { credit, debit, lockAll, postEntry } from '#src/ledger.ts';
import { maturedBalance } from '#src/maturity.ts';
import { encodeAmount, isAmount, toAmount } from '#src/money.ts';

import type { AccountRef } from '#src/accounts.ts';
import { checkedConfig } from '#src/config.ts';
import type { CheckedConfig, Config } from '#src/config.ts';
import type { Amount } from '#src/money.ts';
import type { Digest, Ledger, Store, Unit } from '#src/ports.ts';

export type PlaceBalanceHold = {
  userId: string;
  /** A new ID for this user's hold. A matching retry returns the original receipt. */
  holdId: string;
  /** Positive CREDIT taken from available earnings. */
  amount: Amount;
  /** Epoch milliseconds at which the hold becomes eligible for release. */
  expiresAt?: number;
  /** Event name that permits release when the host later verifies it. */
  releaseEvent?: string;
  /** The host's current time in epoch milliseconds; never read from a system clock. */
  now: number;
};
export type ReleaseBalanceHold = {
  userId: string;
  holdId: string;
  /** Identifies one release request across this user's holds. Reuse it for retries. */
  idempotencyKey: string;
  /** Omit to release the entire remainder. A partial release must be positive CREDIT. */
  amount?: Amount;
  /** Host-verified event; must match the opening event unless the deadline has been reached. */
  event?: string;
  now: number;
};
export type BalanceHoldResult = {
  status: 'committed' | 'duplicate';
  transactionId: string;
  amount: Amount;
};
export type BalanceAvailability = {
  /** Unheld earnings whose waiting period has not ended. */
  pending: Amount;
  /** Unheld earnings whose waiting period has ended. Other payout policies still apply. */
  available: Amount;
  /** Earnings in balance holds; excludes funds already reserved for accepted payouts. */
  reserved: Amount;
  /** pending + available + reserved. An accepted payout leaves this total. */
  total: Amount;
};
export type BalanceHolds = {
  /** Reserve available earnings until an event or deadline permits release. */
  place(input: PlaceBalanceHold): Promise<BalanceHoldResult>;
  /** Return held earnings to available funds without starting another waiting period. */
  release(input: ReleaseBalanceHold): Promise<BalanceHoldResult>;
  /** Release due remainders, each in its own transaction. An interrupted call can be retried. */
  expire(input: { userId: string; now: number }): Promise<BalanceHoldResult[]>;
  /** Read balances without releasing expired holds. */
  read(input: { userId: string; now: number }): Promise<BalanceAvailability>;
};
type Dependencies = { store: Store; config: CheckedConfig; digest: Digest };
type Opening = {
  amount: Amount;
  expiresAt: number | null;
  releaseEvent: string | null;
};

/**
 * Creates the in-process API for holds on seller earnings. Use the same store, configuration,
 * digest, and clock as the Economy instance that handles payouts. The host authorizes callers,
 * verifies events, and schedules expiry calls. No timer runs inside this API.
 *
 * Hold IDs belong to one user and cannot be reused for a new hold. Release keys also belong to
 * one user, across all their holds. Matching retries return the original receipt even with a
 * later `now`; changed business inputs are refused. Complete history must stay in active storage.
 */
export function createBalanceHolds(input: {
  store: Store;
  config: Config;
  digest: Digest;
}): BalanceHolds {
  const deps: Dependencies = { ...input, config: checkedConfig(input.config) };
  return {
    place: (input) => place(deps, input),
    release: async (input) => (await release(deps, input, false))!,
    expire: (input) => expire(deps, input),
    read: (input) => read(deps, input),
  };
}

function malformed(message: string): never {
  throw fault(ERROR_CODES.MALFORMED_OPERATION, message);
}
function broken(message: string): never {
  throw fault(ERROR_CODES.CHAIN_BROKEN, message, { retryable: false });
}
function identity(userId: string, holdId?: string): void {
  const valid = (value: string): boolean =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value);
  if (
    !valid(userId) ||
    userId === 'platform' ||
    (holdId !== undefined && !valid(holdId))
  ) {
    malformed(
      'Hold identifiers must be 1–40 ASCII letters, digits, underscores or hyphens; platform is reserved.',
    );
  }
}
function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    malformed('Hold times must be non-negative safe integer milliseconds.');
}
function textField(value: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200)
    malformed(
      'Hold event and idempotency keys must be non-empty strings of at most 200 characters.',
    );
}
function amount(value: Amount): void {
  if (
    !isAmount(value) ||
    value.currency !== 'CREDIT' ||
    value.minor <= 0n ||
    value.minor > 1_000_000_000_000_000n
  ) {
    malformed(
      'Hold amounts must be positive CREDIT of at most 1000000000000000 minor units.',
    );
  }
}
async function transactionId(
  deps: Dependencies,
  parts: readonly string[],
): Promise<string> {
  // 240 hash bits fit MySQL's 64-character posting ID without shortening caller identities.
  return `txn_${toHex(await deps.digest.hash(new TextEncoder().encode(JSON.stringify(parts)))).slice(0, 60)}`;
}
function openingId(
  deps: Dependencies,
  userId: string,
  holdId: string,
): Promise<string> {
  return transactionId(deps, ['balance-hold', 'place', userId, holdId]);
}
async function unarchived(deps: Dependencies): Promise<void> {
  if ((await deps.store.checkpoints.archiveState?.()) != null) {
    broken(
      'Balance holds require complete ledger history in active storage; archival is unsupported.',
    );
  }
}
async function existing(
  deps: Dependencies,
  ledger: Ledger,
  txnId: string,
  request: string,
): Promise<BalanceHoldResult | null> {
  const posting = await verifiedPosting({ ledger, digest: deps.digest }, txnId);
  if (posting === null) return null;
  if (posting.meta.request !== request)
    malformed(
      'A hold identity or release idempotency key was reused with a different request.',
    );
  const debitLeg = posting.legs.find((leg) => leg.amount.minor > 0n);
  if (!debitLeg) broken('A hold receipt has no debit leg.');
  return { status: 'duplicate', transactionId: txnId, amount: debitLeg.amount };
}
async function checkedBalance(
  ledger: Ledger,
  account: AccountRef,
): Promise<Amount> {
  const live = await ledger.balance(account);
  const derived = await ledger.derivedBalances(account);
  const minor = derived.reduce((sum, value) => {
    if (value.currency !== 'CREDIT')
      broken('Hold history contains the wrong currency.');
    return sum + value.minor;
  }, 0n);
  if (minor !== live.minor || minor < 0n)
    broken(
      'A balance is negative or does not match its active ledger entries.',
    );
  return live;
}
async function available(
  deps: Dependencies,
  unit: Unit,
  userId: string,
  now: number,
): Promise<{ live: Amount; available: Amount }> {
  const live = await checkedBalance(unit.ledger, earned(userId));
  const matured = await maturedBalance(unit.ledger, earned(userId), now, {
    config: deps.config,
  });
  return { live, available: matured };
}

async function place(
  deps: Dependencies,
  input: PlaceBalanceHold,
): Promise<BalanceHoldResult> {
  identity(input.userId, input.holdId);
  if (typeof input.holdId !== 'string') malformed('A holdId is required.');
  time(input.now);
  amount(input.amount);
  if (input.expiresAt !== undefined) time(input.expiresAt);
  if (input.releaseEvent !== undefined) textField(input.releaseEvent);
  if (input.expiresAt === undefined && input.releaseEvent === undefined)
    malformed('A hold needs an expiry or a release event.');
  const txnId = await openingId(deps, input.userId, input.holdId);
  const request = JSON.stringify([
    'place',
    input.userId,
    input.holdId,
    encodeAmount(input.amount),
    input.expiresAt ?? null,
    input.releaseEvent ?? null,
  ]);
  await unarchived(deps);
  return deps.store.transaction(async (unit) => {
    // earned sorts before every :hold: account. Taking it first also makes discovery a snapshot.
    await lockAll(unit.ledger, [earned(input.userId)]);
    const reserved = balanceHoldAccount(input.userId, input.holdId);
    let previouslyUsed = false;
    for await (const account of unit.ledger.balanceAccounts()) {
      if (account === reserved) previouslyUsed = true;
    }
    await lockAll(unit.ledger, [reserved]);
    const duplicate = await existing(deps, unit.ledger, txnId, request);
    if (duplicate) return duplicate;
    if (previouslyUsed)
      broken('A previously used hold account is missing its opening entry.');
    const funds = await available(deps, unit, input.userId, input.now);
    // Accrual debt is a separate payout policy, not a ledger balance bucket.
    const debt = await unit.accruals.netPending(input.userId);
    const payable = funds.live.minor + (debt < 0n ? debt : 0n);
    if (
      input.amount.minor > funds.available.minor ||
      input.amount.minor > payable
    ) {
      throw fault(
        ERROR_CODES.OVERDRAFT,
        'A hold can reserve only available earned funds.',
      );
    }
    await postEntry(unit.ledger, {
      txnId,
      legs: [
        debit(earned(input.userId), input.amount),
        credit(reserved, input.amount),
      ],
      meta: {
        kind: 'placeBalanceHold',
        userId: input.userId,
        holdId: input.holdId,
        expiresAt: input.expiresAt ?? null,
        releaseEvent: input.releaseEvent ?? null,
        now: input.now,
        request,
      },
    });
    return { status: 'committed', transactionId: txnId, amount: input.amount };
  });
}

async function loadOpening(
  deps: Dependencies,
  ledger: Ledger,
  userId: string,
  holdId: string,
): Promise<Opening> {
  const posting = await verifiedPosting(
    { ledger, digest: deps.digest },
    await openingId(deps, userId, holdId),
  );
  if (posting === null)
    broken(
      'A hold opening posting is missing; refusing to infer its conditions.',
    );
  const [from, to] = posting.legs;
  if (
    posting.meta.kind !== 'placeBalanceHold' ||
    posting.meta.userId !== userId ||
    posting.meta.holdId !== holdId ||
    posting.legs.length !== 2 ||
    from?.account !== earned(userId) ||
    to?.account !== balanceHoldAccount(userId, holdId) ||
    from.amount.currency !== 'CREDIT' ||
    from.amount.minor <= 0n ||
    to.amount.currency !== 'CREDIT' ||
    to.amount.minor !== -from.amount.minor
  ) {
    broken('A hold opening does not match its account and amount.');
  }
  return { amount: from.amount, ...openingConditions(posting.meta) };
}

function openingConditions(
  meta: Record<string, unknown>,
): Omit<Opening, 'amount'> {
  const expiresAt = meta.expiresAt;
  const releaseEvent = meta.releaseEvent;
  if (
    !(
      expiresAt === null ||
      (typeof expiresAt === 'number' &&
        Number.isSafeInteger(expiresAt) &&
        expiresAt >= 0)
    ) ||
    !(
      releaseEvent === null ||
      (typeof releaseEvent === 'string' && releaseEvent.trim() !== '')
    ) ||
    (expiresAt === null && releaseEvent === null)
  ) {
    broken('A hold opening has invalid release conditions.');
  }
  return { expiresAt, releaseEvent };
}

async function release(
  deps: Dependencies,
  input: ReleaseBalanceHold,
  expiration: boolean,
): Promise<BalanceHoldResult | null> {
  identity(input.userId, input.holdId);
  if (typeof input.holdId !== 'string') malformed('A holdId is required.');
  time(input.now);
  textField(input.idempotencyKey);
  if (input.amount !== undefined) amount(input.amount);
  if (input.event !== undefined) textField(input.event);
  const txnId = await transactionId(deps, [
    'balance-hold',
    expiration ? 'expire' : 'release',
    input.userId,
    input.idempotencyKey,
  ]);
  const request = JSON.stringify([
    'release',
    input.userId,
    input.holdId,
    input.amount === undefined ? null : encodeAmount(input.amount),
    input.event ?? null,
  ]);
  await unarchived(deps);
  return deps.store.transaction(async (unit) => {
    const reserved = balanceHoldAccount(input.userId, input.holdId);
    await lockAll(unit.ledger, [earned(input.userId), reserved]);
    const duplicate = await existing(deps, unit.ledger, txnId, request);
    if (duplicate) return duplicate;
    const opening = await loadOpening(
      deps,
      unit.ledger,
      input.userId,
      input.holdId,
    );
    const expired =
      opening.expiresAt !== null && input.now >= opening.expiresAt;
    if (
      !expired &&
      (input.event === undefined || input.event !== opening.releaseEvent)
    )
      malformed(
        'The hold has not expired and its release event did not match.',
      );
    const remaining = await checkedBalance(unit.ledger, reserved);
    if (remaining.minor > opening.amount.minor)
      broken('A hold contains more than its opening amount.');
    if (remaining.minor === 0n) {
      if (expiration) return null;
      malformed('The hold has already been fully released.');
    }
    const released = input.amount ?? remaining;
    if (released.minor > remaining.minor)
      throw fault(
        ERROR_CODES.OVERDRAFT,
        'A release exceeds the remaining hold.',
      );
    await postEntry(unit.ledger, {
      txnId,
      legs: [debit(reserved, released), credit(earned(input.userId), released)],
      meta: {
        kind: 'releaseBalanceHold',
        userId: input.userId,
        holdId: input.holdId,
        now: input.now,
        request,
      },
    });
    return { status: 'committed', transactionId: txnId, amount: released };
  });
}

async function holdsFor(
  deps: Dependencies,
  ledger: Ledger,
  userId: string,
): Promise<Array<{ holdId: string; amount: Amount; opening: Opening }>> {
  const holds = [];
  for await (const account of ledger.balanceAccounts()) {
    const parts = balanceHoldParts(account);
    if (parts?.userId !== userId) continue;
    const balance = await checkedBalance(ledger, account);
    if (balance.minor === 0n) continue;
    const opening = await loadOpening(deps, ledger, userId, parts.holdId);
    if (balance.minor > opening.amount.minor)
      broken('A hold contains more than its opening amount.');
    holds.push({ holdId: parts.holdId, amount: balance, opening });
  }
  return holds;
}
async function expire(
  deps: Dependencies,
  input: { userId: string; now: number },
): Promise<BalanceHoldResult[]> {
  identity(input.userId);
  time(input.now);
  await unarchived(deps);
  const holds = await deps.store.transaction(async (unit) => {
    await lockAll(unit.ledger, [earned(input.userId)]);
    return holdsFor(deps, unit.ledger, input.userId);
  });
  const results = [];
  for (const hold of holds) {
    if (
      hold.opening.expiresAt !== null &&
      input.now >= hold.opening.expiresAt
    ) {
      const result = await release(
        deps,
        { ...input, holdId: hold.holdId, idempotencyKey: hold.holdId },
        true,
      );
      if (result !== null) results.push(result);
    }
  }
  return results;
}
async function read(
  deps: Dependencies,
  input: { userId: string; now: number },
): Promise<BalanceAvailability> {
  identity(input.userId);
  time(input.now);
  await unarchived(deps);
  return deps.store.transaction(async (unit) => {
    await lockAll(unit.ledger, [earned(input.userId)]);
    const funds = await available(deps, unit, input.userId, input.now);
    const holds = await holdsFor(deps, unit.ledger, input.userId);
    const reserved = holds.reduce((sum, hold) => sum + hold.amount.minor, 0n);
    return {
      pending: toAmount('CREDIT', funds.live.minor - funds.available.minor),
      available: funds.available,
      reserved: toAmount('CREDIT', reserved),
      total: toAmount('CREDIT', funds.live.minor + reserved),
    };
  });
}
