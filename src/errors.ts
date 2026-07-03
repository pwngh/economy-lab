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

import type { Outcome } from '#src/contract.ts';

/**
 * Reasons a well-formed request is declined on a healthy system. A rejection is normal,
 * expected data: returned as a `rejected` Outcome the caller handles (e.g. "not enough
 * funds"), not thrown.
 *
 * Kept separate from the thrown faults in `ERROR_CODES`. Affordability is checked up front
 * and returned as INSUFFICIENT_FUNDS; it never reaches the deeper OVERDRAFT fault, which
 * only fires if a balance went negative anyway. Keeping ordinary "no" answers off the
 * thrown-error path keeps them out of error dashboards and alerts.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/outcomes-and-reason-codes/
 *   Outcomes & reason codes} for the full taxonomy.
 */
export type RejectionCode =
  // The account doesn't have enough money to cover the request.
  | 'INSUFFICIENT_FUNDS'
  // The fraud/abuse risk check declined this request.
  | 'RISK_DENIED'
  // The funds exist but aren't usable yet (they're still in a holding period).
  | 'FUNDS_IMMATURE'
  // The user doesn't own the item or feature the request needs.
  | 'NOT_ENTITLED'
  // No sale was found for the order the request refers to.
  | 'UNKNOWN_ORDER'
  // A spend reused an orderId that already has a completed sale but carried a different
  // idempotencyKey. The orderId identifies a unique purchase, so a second charge for the same
  // order is declined rather than thrown. This is an expected client mistake, such as a retry
  // that lost its idempotency key, not a bug.
  | 'DUPLICATE_ORDER'
  // No subscription was found matching the request.
  | 'UNKNOWN_SUBSCRIPTION'
  // The user already has an ACTIVE subscription to this sku/seller; a second one would double-bill.
  | 'ALREADY_SUBSCRIBED'
  // A payout was requested for less than the smallest amount that's allowed to be
  // paid out (the minimum is set in config).
  | 'BELOW_MINIMUM'
  // A payout was requested before enough time had passed since the user's previous request
  // (minimum gap is config payoutMinIntervalMs). The decline carries when the user may retry.
  | 'PAYOUT_TOO_SOON'
  // A scheduled maintenance window is in effect, so an end user's discretionary write is declined.
  // Settlement (actor 'system') and operator fixes are never paused; the decline carries `resumesAt`
  // (the window's end) so the caller can tell the user when to retry.
  | 'ECONOMY_PAUSED';

/**
 * Codes for thrown faults (genuine failures), as opposed to the expected "no" answers in
 * {@link RejectionCode}. Each value is a stable, namespaced string (e.g. `LEDGER.OVERDRAFT`)
 * so callers and dashboards match on a fixed code, not free-text. Always reference these
 * constants; never write the bare strings inline.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/outcomes-and-reason-codes/
 *   Outcomes & reason codes} for how each code maps to an HTTP status and retry decision.
 */
export const ERROR_CODES = {
  /** The request was structurally wrong (missing or invalid fields). */
  MALFORMED_OPERATION: 'OP.MALFORMED',

  /** A money amount was invalid (for example, negative or not a whole minor unit). */
  INVALID_AMOUNT: 'MONEY.INVALID_AMOUNT',

  /** A posting's debits and credits didn't add up to zero, so the books wouldn't balance. */
  LEDGER_UNBALANCED: 'LEDGER.UNBALANCED',

  /** A posting referenced an account that doesn't exist. */
  UNKNOWN_ACCOUNT: 'LEDGER.UNKNOWN_ACCOUNT',

  /** A single posting tried to combine two different currencies, which isn't allowed. */
  CURRENCY_MISMATCH: 'LEDGER.CURRENCY_MISMATCH',

  /**
   * A balance that's never supposed to go negative did. Last-resort backstop deep in the posting
   * code; the type doc above explains how the up-front INSUFFICIENT_FUNDS check keeps ordinary
   * shortfalls away from it, so reaching this fault means a bug let a balance slip below zero.
   */
  OVERDRAFT: 'LEDGER.OVERDRAFT',

  /**
   * A posting tried to mix custodial funds (money the platform owes users and must hold real money
   * against) with funds it does not owe, such as revenue. Those two kinds must stay in separate
   * accounts, so this is a thrown safety fault deep in the treasury path, never an expected "no".
   */
  COMMINGLING: 'LEDGER.COMMINGLING',

  /**
   * A multi-step saga was told to move to a state it can't reach from its
   * current one.
   */
  INVALID_TRANSITION: 'SAGA.INVALID_TRANSITION',

  /** The caller isn't permitted to perform this action. */
  UNAUTHORIZED: 'AUTH.UNAUTHORIZED',

  /**
   * A cryptographic signature didn't verify. Thrown in src/server.ts when an inbound webhook's
   * HMAC signature fails to match, before any state is changed; outer layers map this to HTTP 401.
   */
  INVALID_SIGNATURE: 'AUTH.INVALID_SIGNATURE',

  /** The underlying storage layer (database, etc.) failed. */
  STORE_FAILURE: 'STORE.FAILURE',

  /** An external service we depend on (such as a payment processor) failed. */
  PROVIDER_FAILURE: 'PROVIDER.FAILURE',

  /**
   * Configuration failed to load or validate. Thrown at startup so a bad config stops
   * the service immediately rather than failing later.
   */
  CONFIG_INVALID: 'CONFIG.INVALID',

  /**
   * The hash chain failed to verify: a stored hash no longer matches the one recomputed from its
   * posting, so the ledger has been tampered with. Thrown before a checkpoint is signed, so no
   * attestation is produced over a broken chain. Last-resort integrity fault, never an expected
   * "no", hence a thrown fault rather than a RejectionCode.
   */
  CHAIN_BROKEN: 'CHAIN.BROKEN',
} as const;

/**
 * The union of every {@link ERROR_CODES} value, so a caller matching on `error.code` gets
 * autocompletion and exhaustiveness instead of comparing against free-typed strings.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Thrown-error type for every fault in this system. Carries one of the stable
 * {@link ERROR_CODES} codes, which outer layers use to pick an HTTP status, decide whether
 * to retry, and what to log.
 *
 * Only `message` is safe to show a caller. `detail` and `cause` may hold internal info, so
 * they are for logging only; don't surface them in a response.
 */
export class EconomyError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      detail?: Record<string, unknown>;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'EconomyError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.detail = options?.detail ?? {};
  }
}

export function fault(
  code: ErrorCode,
  message: string,
  options?: {
    cause?: unknown;
    retryable?: boolean;
    detail?: Record<string, unknown>;
  },
): EconomyError {
  return new EconomyError(code, message, options);
}

/**
 * Builds a `rejected` Outcome: the value an operation returns (not throws) when it
 * declines a valid request for one of the expected business reasons in
 * {@link RejectionCode}.
 */
export function rejected(
  reason: RejectionCode,
  detail?: Record<string, unknown>,
): Extract<Outcome, { status: 'rejected' }> {
  return detail === undefined
    ? { status: 'rejected', reason }
    : { status: 'rejected', reason, detail };
}

/**
 * Turns anything caught in a `catch` into an {@link EconomyError}. If it's already one, returns
 * it unchanged: re-wrapping could overwrite its retryable flag and wrongly mark a non-retryable
 * failure as safe to retry. Anything else (a raw exception from a library, the storage layer,
 * etc.) is wrapped as a retryable STORE.FAILURE, with the original kept in `cause` for logs so
 * the caller never sees the raw error or its stack trace.
 */
export function normalizeError(error: unknown): EconomyError {
  if (error instanceof EconomyError) {
    return error;
  }
  return new EconomyError(
    ERROR_CODES.STORE_FAILURE,
    'An unexpected error occurred.',
    {
      cause: error,
      retryable: true,
    },
  );
}
